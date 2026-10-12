package ar.exertion.casco;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaRecorder;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import com.pedro.common.ConnectChecker;
import com.pedro.encoder.EncoderErrorCallback;
import com.pedro.encoder.input.video.CameraCallbacks;
import com.pedro.encoder.input.video.CameraHelper;
import com.pedro.encoder.utils.CodecUtil;
import com.pedro.library.rtmp.RtmpCamera2;

import java.net.URLEncoder;

/**
 * Servicio en primer plano que transmite la camara trasera por RTMP (RootEncoder, sin preview) a
 * rtmp://<stream_host>:1935/live/<device_id>?user=device&pass=<access_token>. Audio solo si stream_audio=true
 * (AAC-LC mono 16 kHz ~24 kbps, ruta ingest/<device_id>; ver StreamPolicy.ingestPath).
 *
 * Todo el estado vive en el hilo "casco-stream" (sh). La camara se libera SIEMPRE en shutdown()/onDestroy().
 * Arranque: MediaWatcherService (comando 'start' remoto) o SOS/caida (local, 120 s).
 * Tope duro: StreamPolicy.MAX_STREAM_MS. Reconexion: StreamPolicy.MAX_RETRIES con backoff.
 */
public class StreamService extends Service {
    static final String ACTION_START = "ar.exertion.casco.STREAM_START";
    static final String ACTION_STOP = "ar.exertion.casco.STREAM_STOP";
    /** Reabre la transmision en curso con/sin audio (voz: "activar audio" / "desactivar audio"). */
    static final String ACTION_REAUDIO = "ar.exertion.casco.STREAM_REAUDIO";
    private static final String EXTRA_SOURCE = "source";
    private static final String EXTRA_ANNOUNCE = "announce";

    /**
     * Voz ("casco, activar audio"): pisa stream_audio y la config remota hasta que el servicio se reinicia.
     * null = sin pedido (manda RemoteConfig/config.json).
     */
    static volatile Boolean audioOverride;
    /** El intento actual tiene el microfono del stream abierto (lo lee VoiceCommandAgent para no pisarlo). */
    static volatile boolean audioActive;
    private static final String TAG = "CascoAgente";

    /** SRC_* actual. Escribe el hilo sh; lo lee el poll de comandos. */
    static volatile int source = StreamPolicy.SRC_NONE;
    /** Cliente Supabase compartido (mismo proceso) para reutilizar el token; lo setea MediaWatcherService. */
    static volatile Supabase shared;

    private HandlerThread thread;
    private Handler sh;
    private Config cfg;
    private Supabase sb;
    private PowerManager.WakeLock wake;
    private RtmpCamera2 cam;       // acceso bajo synchronized(this)
    private int gen;               // invalida callbacks de intentos anteriores (solo hilo sh)
    private int attempt;           // reintentos consecutivos (solo hilo sh)
    private boolean announced;     // "transmision iniciada" dicha en esta sesion (solo hilo sh)
    private boolean audioOn;       // el intento actual lleva pista de audio (solo hilo sh)
    private boolean audioFailed;   // el audio dio problemas en esta sesion: seguir solo con video (solo hilo sh)
    private boolean audioMuted;    // silenciado por llamada WebRTC (solo hilo sh)
    private boolean permWarned;

    static void start(Context c, int src) {
        try {
            c.startForegroundService(new Intent(c, StreamService.class)
                    .setAction(ACTION_START).putExtra(EXTRA_SOURCE, src));
        } catch (RuntimeException e) {
            Log.e(TAG, "no se pudo arrancar StreamService: " + e);
        }
    }

    static void stop(Context c) {
        try {
            c.startForegroundService(new Intent(c, StreamService.class).setAction(ACTION_STOP));
        } catch (RuntimeException e) {
            Log.e(TAG, "no se pudo detener StreamService: " + e);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        goForeground();
        thread = new HandlerThread("casco-stream");
        thread.start();
        sh = new Handler(thread.getLooper());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        goForeground(); // cada startForegroundService exige startForeground()
        final String action = intent != null ? intent.getAction() : null;
        if (ACTION_START.equals(action)) {
            final int src = intent.getIntExtra(EXTRA_SOURCE, StreamPolicy.SRC_REMOTE);
            sh.post(() -> begin(src));
        } else if (ACTION_REAUDIO.equals(action)) {
            final String phrase = intent.getStringExtra(EXTRA_ANNOUNCE);
            sh.post(() -> reconnectForAudio(phrase));
        } else {
            // ACTION_STOP, o reinicio sin intent: no hay nada que transmitir
            sh.post(this::shutdown);
        }
        return START_NOT_STICKY;
    }

    /** Voz: cambia audio con la transmision en curso. announce = frase al reconectar (la de AAC/sin audio). */
    static void reaudio(Context c, String announce) {
        try {
            c.startForegroundService(new Intent(c, StreamService.class)
                    .setAction(ACTION_REAUDIO).putExtra(EXTRA_ANNOUNCE, announce));
        } catch (RuntimeException e) {
            Log.e(TAG, "no se pudo reabrir StreamService: " + e);
        }
    }

    // ---- hilo sh ----

    private String announceOnce;       // frase para el proximo "conectado" (reconexion por cambio de audio)

    private void reconnectForAudio(String phrase) {
        if (source == StreamPolicy.SRC_NONE || cfg == null) return; // nada transmitiendo: el pedido ya quedo en audioOverride
        Log.i(TAG, "stream: cambio de audio pedido por voz, se reconecta");
        attempt = 0;
        audioFailed = false;
        announced = false;
        announceOnce = phrase;
        sh.removeCallbacks(audioTick);
        connect();
    }

    private void begin(int src) {
        if (source == StreamPolicy.SRC_LOCAL && src == StreamPolicy.SRC_REMOTE) {
            source = StreamPolicy.SRC_REMOTE; // comando remoto adopta la transmision del SOS: sin corte a los 120 s
            Log.i(TAG, "transmision local promovida a remota");
            return;
        }
        if (source != StreamPolicy.SRC_NONE) return; // ya transmitiendo

        cfg = Config.load(this);
        if (cfg == null || cfg.streamHost.isEmpty()) {
            Log.e(TAG, "stream: falta stream_host valido en config.json, no se transmite");
            shutdown();
            return;
        }
        if (!cfg.deviceId.matches("[A-Za-z0-9_-]{1,64}")) {
            Log.e(TAG, "stream: device_id invalido para la ruta live/<device_id>");
            shutdown();
            return;
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            Log.e(TAG, "stream: falta permiso CAMERA (adb shell pm grant ar.exertion.casco android.permission.CAMERA)");
            shutdown();
            return;
        }
        sb = shared != null ? shared : new Supabase(cfg);

        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "casco:stream");
        wake.acquire(StreamPolicy.MAX_STREAM_MS + 60_000L); // nunca queda tomado mas que el tope

        source = src;
        attempt = 0;
        Log.i(TAG, "stream: inicio origen=" + (src == StreamPolicy.SRC_LOCAL ? "local(SOS/caida)" : "remoto")
                + " " + cfg.streamWidth + "x" + cfg.streamHeight + "@" + cfg.streamFps + " "
                + cfg.streamBitrateKbps + "kbps");
        sh.postDelayed(() -> {
            Log.w(TAG, "stream: tope de " + StreamPolicy.MAX_STREAM_MS / 60_000 + " min alcanzado, se detiene");
            shutdown();
        }, StreamPolicy.MAX_STREAM_MS);
        connected = false;
        if (src == StreamPolicy.SRC_LOCAL) sh.postDelayed(localEnd, StreamPolicy.LOCAL_SOS_MS);
        connect();
    }

    private boolean connected;         // RTMP conectado ahora (solo hilo sh)

    /** SOS/caida: a los 120 s corta solo si hay video; sin conexion sigue reintentando (tope de 10 min). */
    private final Runnable localEnd = new Runnable() {
        @Override public void run() {
            if (source != StreamPolicy.SRC_LOCAL) return;
            if (StreamPolicy.localWindowEnds(connected)) {
                Log.i(TAG, "stream: fin de transmision local SOS/caida");
                shutdown();
            } else {
                sh.postDelayed(this, StreamPolicy.LOCAL_RETRY_MAX_MS);
            }
        }
    };

    private void connect() {
        if (source == StreamPolicy.SRC_NONE) return;
        final int g = ++gen;
        try {
            releaseCamera();
            String token = sb.accessToken(); // red; renueva si quedan <5 min
            String host = cfg.streamHost.contains(":") ? cfg.streamHost : cfg.streamHost + ":1935";
            // el microfono SOLO se abre con stream_audio=true Y transmision activa (este intento)
            boolean hasMic = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
            Boolean vo = audioOverride; // voz: "activar audio" / "desactivar audio" pisa la config
            boolean cfgAudio = vo != null ? vo : RemoteConfig.streamAudio(cfg.streamAudio);
            if (cfgAudio && !hasMic && !permWarned) {
                permWarned = true;
                Log.w(TAG, "stream: stream_audio=true pero falta RECORD_AUDIO: video sin audio "
                        + "(adb shell pm grant ar.exertion.casco android.permission.RECORD_AUDIO)");
            }
            boolean wantAudio = StreamPolicy.wantAudio(cfgAudio, hasMic, audioFailed);

            RtmpCamera2 c = new RtmpCamera2(this, new ConnectChecker() {
                @Override public void onConnectionStarted(String u) { }
                @Override public void onConnectionSuccess() {
                    sh.post(() -> {
                        if (g != gen) return;
                        attempt = 0;
                        connected = true;
                        if (source == StreamPolicy.SRC_LOCAL) { // 120 s de video efectivo desde que conecta
                            sh.removeCallbacks(localEnd);
                            sh.postDelayed(localEnd, StreamPolicy.LOCAL_SOS_MS);
                        }
                        Log.i(TAG, "stream: RTMP conectado, transmitiendo");
                        if (!announced) {
                            announced = true;
                            String ph = announceOnce; // cambio de audio por voz: frase propia
                            announceOnce = null;
                            if (ph != null) SpanishVoice.announce(ph); // la pidio el operario: habla aunque voice_prompts=false
                            else SpanishVoice.say(audioOn ? SpanishVoice.AUDIO_ON : SpanishVoice.STREAM_ON);
                        }
                    });
                }
                @Override public void onConnectionFailed(String reason) {
                    sh.post(() -> retry(g, "RTMP fallo: " + reason));
                }
                @Override public void onDisconnect() {
                    sh.post(() -> retry(g, "RTMP desconectado"));
                }
                @Override public void onAuthError() {
                    sh.post(() -> retry(g, "RTMP auth rechazada (token/rol device)"));
                }
                @Override public void onAuthSuccess() { }
                @Override public void onNewBitrate(long bitrate) { }
            });
            c.setCameraCallbacks(new CameraCallbacks() {
                @Override public void onCameraChanged(CameraHelper.Facing facing) { }
                @Override public void onCameraOpened() { }
                @Override public void onCameraError(String error) {
                    sh.post(() -> retry(g, "camara: " + explainCameraError(error)));
                }
                @Override public void onCameraDisconnected() {
                    sh.post(() -> retry(g, "camara desconectada (la tomo otra app o el sistema)"));
                }
            });
            c.setEncoderErrorCallback(new EncoderErrorCallback() {
                @Override public void onCodecError(CodecUtil.CodecTypeError type,
                                                   MediaCodec.CodecException e) {
                    sh.post(() -> retry(g, "encoder " + type + ": " + e.getDiagnosticInfo()));
                }
                @Override public boolean onEncodeError(CodecUtil.CodecTypeError type,
                                                       IllegalStateException e) {
                    sh.post(() -> retry(g, "encoder " + type + ": " + e));
                    return false;
                }
            });
            synchronized (this) { cam = c; }

            int br = cfg.streamBitrateKbps * 1000;
            boolean ok = c.prepareVideo(cfg.streamWidth, cfg.streamHeight, cfg.streamFps, br, 2, cfg.streamRotation,
                    MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline, -1)
                    || c.prepareVideo(cfg.streamWidth, cfg.streamHeight, cfg.streamFps, br, 2, cfg.streamRotation);
            if (!ok) {
                Log.e(TAG, "stream: el encoder H.264 no acepta " + cfg.streamWidth + "x" + cfg.streamHeight
                        + "@" + cfg.streamFps + ", se cancela (ajustar stream_* en config.json)");
                shutdown();
                return;
            }
            audioOn = false;
            audioMuted = false;
            if (wantAudio) {
                // AAC-LC mono 16 kHz 24 kbps (prepareAudio(fuente, bitrate, sampleRate, estereo, eco, ruido));
                // RtmpClient de RootEncoder 2.5.5 tambien empaqueta G.711, pero el relay del servidor espera AAC.
                try {
                    audioOn = c.prepareAudio(MediaRecorder.AudioSource.MIC, 24_000, 16_000, false, false, true);
                } catch (Throwable t) {
                    Log.w(TAG, "stream: prepareAudio fallo (" + t.getClass().getSimpleName() + "), sigue solo video");
                }
                if (!audioOn) audioFailed = true;
                else if (StreamPolicy.audioMuted(VoiceCallManager.inCall)) {
                    c.disableAudio(); // arranca silenciado: hay llamada, el microfono es del WebRTC
                    audioMuted = true;
                }
            }
            audioActive = audioOn; // VoiceCommandAgent: el microfono del stream esta (o no) abierto
            String path = StreamPolicy.ingestPath(audioOn, cfg.streamIngestPath);
            String url = "rtmp://" + host + "/" + path + "/" + cfg.deviceId + "?user=device&pass="
                    + URLEncoder.encode(token, "UTF-8"); // nunca loguear url: lleva el token
            Log.i(TAG, "stream: ruta " + path + "/<id> audio=" + (audioOn ? "AAC 16kHz mono 24kbps" : "no"));
            // en modo sin preview esto solo elige camara trasera; la camara se abre en startStream()
            c.startPreview(CameraHelper.Facing.BACK, cfg.streamWidth, cfg.streamHeight, cfg.streamFps,
                    cfg.streamRotation);
            c.startStream(url); // bloquea hasta abrir la camara; el resultado RTMP llega por ConnectChecker
            if (audioOn) sh.postDelayed(audioTick, AUDIO_TICK_MS);
        } catch (Throwable e) {
            Log.e(TAG, "stream: excepcion al conectar: " + e.getClass().getSimpleName() + " " + e.getMessage());
            retry(g, "excepcion " + e.getClass().getSimpleName());
        }
    }

    private static final long AUDIO_TICK_MS = 500L;

    /**
     * En sh: durante una llamada WebRTC el audio del stream se silencia (el microfono es del WebRTC) y se
     * reanuda al colgar. El video no se toca. Se detiene solo cuando el intento termina (audioOn=false).
     */
    private final Runnable audioTick = new Runnable() {
        @Override public void run() {
            if (!audioOn || source == StreamPolicy.SRC_NONE) return;
            boolean want = StreamPolicy.audioMuted(VoiceCallManager.inCall);
            if (want != audioMuted) {
                RtmpCamera2 c;
                synchronized (StreamService.this) { c = cam; }
                try {
                    if (c != null) {
                        if (want) c.disableAudio(); else c.enableAudio();
                        audioMuted = want;
                        Log.i(TAG, "stream: audio " + (want ? "silenciado (llamada de voz)" : "reanudado"));
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "stream: no se pudo " + (want ? "silenciar" : "reanudar") + " el audio: " + t);
                }
            }
            sh.postDelayed(this, AUDIO_TICK_MS);
        }
    };

    /** Un solo reintento por intento fallido (varios callbacks pueden avisar lo mismo). */
    private void retry(int g, String why) {
        if (g != gen || source == StreamPolicy.SRC_NONE) return;
        gen++; // invalida los demas callbacks de este intento
        connected = false;
        why = AgentPolicy.redact(why); // el motivo de RootEncoder puede traer la URL con el token
        sh.removeCallbacks(audioTick);
        releaseCamera();
        attempt++;
        if (audioOn && attempt >= StreamPolicy.AUDIO_GIVE_UP_ATTEMPT && !audioFailed) {
            audioFailed = true; // no perder el video por el microfono: reintentos siguientes sin audio, en live/
            Log.w(TAG, "stream: el audio no se estabiliza, se continua solo con video");
        }
        if (StreamPolicy.giveUp(source, attempt)) {
            Log.e(TAG, "stream: " + why + ". Sin mas reintentos (" + StreamPolicy.MAX_RETRIES + "), se detiene");
            shutdown();
            return;
        }
        long d = StreamPolicy.retryDelayMs(attempt, source);
        Log.w(TAG, "stream: " + why + ". Reintento " + attempt + " en " + d + " ms");
        sh.postDelayed(this::connect, d);
    }

    private static String explainCameraError(String raw) {
        // raw termina en el codigo de CameraDevice.StateCallback.ERROR_*
        if (raw.endsWith(": 1")) return "ocupada por otra app (CAMERA_IN_USE; RundeCap/otra la tiene abierta)";
        if (raw.endsWith(": 2")) return "demasiadas camaras abiertas (MAX_CAMERAS_IN_USE)";
        if (raw.endsWith(": 3")) return "deshabilitada por politica del dispositivo (CAMERA_DISABLED)";
        if (raw.endsWith(": 4")) return "error del dispositivo de camara (CAMERA_DEVICE)";
        if (raw.endsWith(": 5")) return "error del servicio de camara (CAMERA_SERVICE)";
        return raw;
    }

    private void releaseCamera() {
        RtmpCamera2 c;
        synchronized (this) { c = cam; cam = null; }
        audioActive = false;
        if (c == null) return;
        try { c.stopStream(); } catch (Throwable e) { Log.w(TAG, "stream: stopStream: " + e); }
        try { if (c.isOnPreview()) c.stopCamera(); } catch (Throwable e) { Log.w(TAG, "stream: stopCamera: " + e); }
    }

    private void shutdown() {
        if (source != StreamPolicy.SRC_NONE) SpanishVoice.say(SpanishVoice.STREAM_OFF);
        announced = false;
        audioOn = false;
        audioFailed = false;
        audioMuted = false;
        gen++;
        sh.removeCallbacksAndMessages(null);
        try {
            releaseCamera();
        } finally {
            source = StreamPolicy.SRC_NONE;
            releaseWake();
            stopForeground(true);
            stopSelf();
            Log.i(TAG, "stream: detenido, camara liberada");
        }
    }

    private void releaseWake() {
        try {
            if (wake != null && wake.isHeld()) wake.release();
        } catch (RuntimeException ignored) { }
    }

    private void goForeground() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        String ch = "casco";
        nm.createNotificationChannel(new NotificationChannel(ch, "Vigía",NotificationManager.IMPORTANCE_MIN));
        Notification n = new Notification.Builder(this, ch)
                .setContentTitle("Vigía")
                .setContentText("Casco transmitiendo")
                .setSmallIcon(android.R.drawable.ic_menu_camera)
                .build();
        startForeground(2, n);
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onDestroy() {
        try {
            releaseCamera(); // red de seguridad si el sistema mata el servicio sin pasar por shutdown()
        } finally {
            source = StreamPolicy.SRC_NONE;
            releaseWake();
            if (sh != null) sh.removeCallbacksAndMessages(null);
            if (thread != null) thread.quitSafely();
            super.onDestroy();
        }
    }
}
