package ar.exertion.casco;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.ToneGenerator;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.Log;

import org.vosk.LibVosk;
import org.vosk.LogLevel;
import org.vosk.Model;
import org.vosk.Recognizer;

import java.io.File;
import java.util.Locale;
import java.util.Map;

/**
 * Comandos de voz en espanol, sin nube (docs/PROTOCOLO-GEO.md seccion 5, android/README-VOZ.md).
 * Vosk offline con el modelo vosk-model-small-es en getExternalFilesDir/vosk-model-es (NO va en el APK;
 * tools/instalar-modelo-voz.ps1) y gramatica cerrada (VoiceCommandPolicy). Toda la decision es de
 * VoiceCommandPolicy (pura); aca solo hay audio, hilos y acciones.
 *
 * Hilos: "casco-voz-mic" (AudioRecord + Vosk; nunca bloquea otra cosa) y "casco-voz-act" (acciones: foto
 * bloquea hasta ~10 s). El microfono se SUELTA (AudioRecord.release) en cada pausa para que WebRTC/RundeCap lo usen.
 *
 * Pausas (gate): voice_commands apagado, sin RECORD_AUDIO, sin movimiento voice_idle_off_minutes, llamada WebRTC,
 * el casco hablando (TTS) o con sirena/orden del supervisor, y transmision con audio si el microfono
 * concurrente entrega ceros (ver README-VOZ.md, "Microfono compartido").
 */
final class VoiceCommandAgent {
    private static final String TAG = "CascoAgente";
    private static final int RATE = 16_000;
    private static final int CHUNK = 1_600;           // 100 ms
    private static final int ZERO_CHUNKS = 30;        // 3 s de ceros exactos = microfono silenciado
    static final String MODEL_DIR = "vosk-model-es";

    /** Lo que necesita del servicio (hilos propios del servicio; el agente no conoce sus campos). */
    interface Host {
        /** La cuenta regresiva termino sin cancelar: encolar el SOS ("voz"). */
        void sos();
        /** Hay una cuenta regresiva de hombre caido en curso (cancelar suelto vale). */
        boolean fallCountdown();
        /** Cancela la cuenta regresiva de hombre caido; true si habia una. */
        boolean cancelFall();
        /** Linterna; null = ok, si no el motivo. */
        String torch(boolean on);
        /** Foto local (bloquea hasta ~25 s); null = ok, si no el motivo. */
        String photo();
    }

    private final Context app;
    private final Config cfg;
    private final Host host;
    private final VoiceCommandPolicy.Session session;
    private final String wake;

    private volatile boolean stopped;
    private volatile long lastMotion = SystemClock.elapsedRealtime();
    private volatile boolean sosPending;
    private long sosAt;
    private boolean micBlocked;   // hilo mic: el microfono concurrente con el stream entrega ceros
    private Thread micT;
    private HandlerThread actT;
    private Handler act;

    VoiceCommandAgent(Context c, Config cfg, Host host) {
        this.app = c.getApplicationContext();
        this.cfg = cfg;
        this.host = host;
        this.wake = cfg.voiceWakeWord;
        this.session = new VoiceCommandPolicy.Session(wake);
    }

    void start() {
        actT = new HandlerThread("casco-voz-act");
        actT.start();
        act = new Handler(actT.getLooper());
        micT = new Thread(this::listen, "casco-voz-mic");
        micT.setDaemon(true);
        micT.start();
    }

    void stop() {
        stopped = true;
        if (micT != null) micT.interrupt();
        if (act != null) act.removeCallbacksAndMessages(null);
        if (actT != null) actT.quitSafely();
    }

    /** Hay movimiento del casco (ventana de FallDetector): reinicia el contador de inactividad. */
    void onMotion() { lastMotion = SystemClock.elapsedRealtime(); }

    /**
     * Prueba sin microfono (adb): procesa una frase como si Vosk la hubiera reconocido, con la misma gramatica
     * y ventana. Solo la dispara quien puede iniciar el servicio (no exportado: shell/adb).
     */
    void injectText(String text) {
        Handler a = act;
        if (a != null) a.post(() -> onResult(text, -1));
    }

    // ---- reconocimiento (hilo mic) ----

    private String gate() {
        if (!RemoteConfig.voiceCommands(cfg.voiceCommands)) return "apagado";
        if (app.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            return "sin permiso RECORD_AUDIO";
        }
        long now = SystemClock.elapsedRealtime();
        if (VoiceCommandPolicy.idleOff(now, lastMotion, cfg.voiceIdleOffMinutes)) return "casco quieto " + cfg.voiceIdleOffMinutes + " min";
        if (VoiceCallManager.inCall) return "llamada de voz";
        if (SpanishVoice.busy()) return "el casco habla";
        if (BroadcastAgent.playing()) return "sirena u orden del supervisor";
        if (!StreamService.audioActive) micBlocked = false;
        if (micBlocked) return "transmision con audio (microfono compartido)";
        return null;
    }

    private void listen() {
        Model model = null;
        Recognizer rec = null;
        AudioRecord ar = null;
        final short[] buf = new short[CHUNK];
        String lastGate = "?";
        int zeroRun = 0, diag = 0;
        boolean modelWarned = false;
        try {
            while (!stopped) {
                String g = gate();
                String key = g == null ? "" : g;
                if (!key.equals(lastGate)) {
                    if (g != null) Log.i(TAG, "voz: en pausa (" + g + ")");
                    else Log.i(TAG, "voz: escuchando");
                    lastGate = key;
                }
                if (g != null) {
                    ar = release(ar);
                    sleep("apagado".equals(g) ? 5_000L : 300L);
                    continue;
                }
                if (model == null) {
                    File dir = new File(app.getExternalFilesDir(null), MODEL_DIR);
                    if (!new File(dir, "am/final.mdl").isFile()) {
                        if (!modelWarned) {
                            modelWarned = true;
                            Log.w(TAG, "voz: falta el modelo en " + dir + " (tools/instalar-modelo-voz.ps1); sin comandos de voz");
                        }
                        sleep(30_000L);
                        continue;
                    }
                    try {
                        LibVosk.setLogLevel(LogLevel.WARNINGS);
                        long t0 = SystemClock.elapsedRealtime();
                        model = new Model(dir.getAbsolutePath());
                        rec = new Recognizer(model, RATE, VoiceCommandPolicy.grammarJson(wake));
                        rec.setWords(true);
                        Log.i(TAG, "voz: reconocimiento listo (modelo " + (SystemClock.elapsedRealtime() - t0)
                                + " ms, palabra \"" + wake + "\", " + VoiceCommandPolicy.grammar(wake).size() + " frases)");
                    } catch (Throwable t) {
                        Log.e(TAG, "voz: no se pudo cargar el modelo: " + t);
                        if (rec != null) { try { rec.close(); } catch (Throwable ignored) { } }
                        if (model != null) { try { model.close(); } catch (Throwable ignored) { } }
                        model = null;
                        rec = null;
                        sleep(60_000L);
                        continue;
                    }
                }
                if (ar == null) {
                    ar = open();
                    if (ar == null) { sleep(5_000L); continue; }
                    rec.reset();
                    zeroRun = 0;
                }
                int n = ar.read(buf, 0, buf.length);
                if (n <= 0) {
                    Log.w(TAG, "voz: AudioRecord.read=" + n + ", se reabre");
                    ar = release(ar);
                    sleep(500L);
                    continue;
                }
                int peak = 0;
                for (int i = 0; i < n; i++) peak = Math.max(peak, Math.abs((int) buf[i]));
                if (StreamService.audioActive && ++diag % 50 == 0) {
                    Log.i(TAG, "voz: microfono con audio del stream activo, pico=" + peak); // diagnostico de captura concurrente
                }
                if (peak == 0) {
                    if (++zeroRun == ZERO_CHUNKS) {
                        if (StreamService.audioActive) {
                            micBlocked = true; // ver gate(): hasta que termine la transmision con audio
                            Log.w(TAG, "voz: el microfono entrega ceros mientras el stream usa el audio: reconocimiento en pausa");
                        } else {
                            Log.w(TAG, "voz: el microfono entrega ceros (otra app lo tiene?)");
                        }
                    }
                } else {
                    zeroRun = 0;
                }
                if (rec.acceptWaveForm(buf, n)) {
                    onResultJson(rec.getResult());
                } else {
                    String p = rec.getPartialResult();
                    String t = VoiceCommandPolicy.text(p.replace("\"partial\"", "\"text\""));
                    if (!t.isEmpty() && !t.equals(lastPartial)) Log.d(TAG, "voz: parcial \"" + t + "\"");
                    lastPartial = t;
                }
            }
        } catch (Throwable t) {
            Log.e(TAG, "voz: el reconocimiento se detuvo: " + t);
        } finally {
            release(ar);
            try { if (rec != null) rec.close(); } catch (Throwable ignored) { }
            try { if (model != null) model.close(); } catch (Throwable ignored) { }
        }
    }

    private String lastPartial = "";

    private void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ignored) { /* stop() */ }
    }

    private AudioRecord open() {
        int[] sources = {MediaRecorder.AudioSource.VOICE_RECOGNITION, MediaRecorder.AudioSource.MIC};
        int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        for (int src : sources) {
            AudioRecord r = null;
            try {
                r = new AudioRecord(src, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                        Math.max(min, RATE * 2));
                if (r.getState() == AudioRecord.STATE_INITIALIZED) {
                    r.startRecording();
                    if (r.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) return r;
                }
            } catch (RuntimeException e) {
                Log.w(TAG, "voz: AudioRecord fuente " + src + ": " + e);
            }
            if (r != null) { try { r.release(); } catch (RuntimeException ignored) { } }
        }
        Log.w(TAG, "voz: no se pudo abrir el microfono (ocupado?), reintento en 5 s");
        return null;
    }

    private static AudioRecord release(AudioRecord r) {
        if (r != null) {
            try { r.stop(); } catch (RuntimeException ignored) { }
            try { r.release(); } catch (RuntimeException ignored) { }
        }
        return null;
    }

    // ---- resultado -> accion ----

    private void onResultJson(String json) {
        final String text = VoiceCommandPolicy.text(json);
        if (text.isEmpty()) return;
        final double conf = VoiceCommandPolicy.meanConf(json);
        Handler a = act;
        if (a != null) a.post(() -> onResult(text, conf));
    }

    /** Hilo act. */
    private void onResult(String text, double conf) {
        long now = SystemClock.elapsedRealtime();
        boolean countdown = sosPending || host.fallCountdown();
        VoiceCommandPolicy.Outcome o = session.feed(now, text, conf, countdown);
        Log.i(TAG, String.format(Locale.ROOT, "voz: resultado \"%s\" conf=%.2f -> %s%s", text, conf, o,
                o == VoiceCommandPolicy.Outcome.COMMAND ? " " + session.cmd() : ""));
        if (o == VoiceCommandPolicy.Outcome.IGNORED) return;
        lastMotion = now; // oyeron al operario: hay alguien
        if (o == VoiceCommandPolicy.Outcome.WAKE) {
            ack();
            return;
        }
        execute(session.cmd());
    }

    /** Tono corto "te escucho" (la ventana de activacion se abrio). */
    private void ack() {
        try {
            final ToneGenerator tg = new ToneGenerator(AudioManager.STREAM_MUSIC, 80);
            tg.startTone(ToneGenerator.TONE_PROP_ACK, 150);
            act.postDelayed(tg::release, 500);
        } catch (RuntimeException e) {
            Log.w(TAG, "voz: tono: " + e);
        }
    }

    private static void say(String t) {
        Log.i(TAG, "voz: dice \"" + t + "\"");
        SpanishVoice.announce(t); // el operario lo pidio: habla aunque voice_prompts sea false
    }

    private void execute(VoiceCommandPolicy.Cmd c) {
        switch (c) {
            case SOS:
                startSos();
                break;
            case CANCEL:
                if (sosPending) {
                    sosPending = false;
                    act.removeCallbacks(sosTick);
                    Log.i(TAG, "voz: SOS por voz cancelado");
                    say(VoiceCommandPolicy.CANCELLED);
                } else if (host.cancelFall()) {
                    say(VoiceCommandPolicy.CANCELLED);
                } else {
                    say(VoiceCommandPolicy.NOTHING_TO_CANCEL);
                }
                break;
            case PHOTO: {
                String err = host.photo();
                say(err == null ? VoiceCommandPolicy.PHOTO_OK : VoiceCommandPolicy.photoError(err, StreamService.source != StreamPolicy.SRC_NONE));
                break;
            }
            case VIDEO_ON:
                if (cfg.streamHost.isEmpty()) say(VoiceCommandPolicy.VIDEO_NO_HOST);
                else if (StreamService.source != StreamPolicy.SRC_NONE) say(VoiceCommandPolicy.ALREADY_VIDEO);
                else StreamService.start(app, StreamPolicy.SRC_VOICE); // "Transmision de video iniciada" lo dice StreamService
                break;
            case VIDEO_OFF:
                if (StreamService.source == StreamPolicy.SRC_NONE) say(VoiceCommandPolicy.NO_VIDEO);
                else if (StreamService.source == StreamPolicy.SRC_LOCAL) say(VoiceCommandPolicy.VIDEO_EMERGENCY);
                else StreamService.stop(app); // StreamService dice "Transmision detenida"
                break;
            case AUDIO_ON:
            case AUDIO_OFF:
                audio(c == VoiceCommandPolicy.Cmd.AUDIO_ON);
                break;
            case TORCH_ON:
                torch(true);
                break;
            case TORCH_OFF:
                torch(false);
                break;
            case STATUS:
                say(status());
                break;
            case HELP:
                say(VoiceCommandPolicy.help(wake));
                break;
            case REPEAT:
                if (!SpanishVoice.repeatLast()) say(VoiceCommandPolicy.NOTHING_TO_REPEAT);
                break;
            default:
                break;
        }
    }

    private void audio(boolean on) {
        int src = StreamService.source;
        if (src == StreamPolicy.SRC_LOCAL) {
            say(VoiceCommandPolicy.AUDIO_EMERGENCY); // no se reabre la transmision de una emergencia
            return;
        }
        StreamService.audioOverride = on;
        Log.i(TAG, "voz: audio del video " + (on ? "activado" : "desactivado") + " (hasta reiniciar el agente)");
        if (src == StreamPolicy.SRC_NONE) {
            say(on ? VoiceCommandPolicy.AUDIO_ON_NEXT : VoiceCommandPolicy.AUDIO_OFF_OK);
        } else if (on == StreamService.audioActive) {
            say(on ? VoiceCommandPolicy.AUDIO_ON_STREAM : VoiceCommandPolicy.AUDIO_OFF_STREAM);
        } else {
            StreamService.reaudio(app, on ? VoiceCommandPolicy.AUDIO_ON_STREAM : VoiceCommandPolicy.AUDIO_OFF_STREAM);
        }
    }

    private void torch(boolean on) {
        if (!on && StreamService.source != StreamPolicy.SRC_NONE) {
            say(VoiceCommandPolicy.TORCH_OFF_OK); // con la camara tomada por el stream la linterna no puede estar prendida
            return;
        }
        String err = host.torch(on);
        say(err == null ? (on ? VoiceCommandPolicy.TORCH_ON_OK : VoiceCommandPolicy.TORCH_OFF_OK)
                : VoiceCommandPolicy.torchError(err, StreamService.source != StreamPolicy.SRC_NONE));
    }

    private String status() {
        Integer bat = null, lvl = null;
        try {
            Map<String, Object> m = DeviceHealth.collect(app);
            if (m.get("bat") instanceof Integer) bat = (Integer) m.get("bat");
            if (m.get("lvl") instanceof Integer) lvl = (Integer) m.get("lvl");
        } catch (RuntimeException e) {
            Log.w(TAG, "voz: estado: " + e);
        }
        return VoiceCommandPolicy.status(bat, lvl, StreamService.source != StreamPolicy.SRC_NONE,
                StreamService.audioActive);
    }

    // ---- SOS por voz: 5 s para cancelar, contados desde que el casco termino de hablar ----

    private final Runnable sosTick = new Runnable() {
        @Override public void run() {
            if (!sosPending || stopped) return;
            long now = SystemClock.elapsedRealtime();
            long q = SpanishVoice.quietSince();
            if (q >= 0) q = Math.max(q, sosAt);
            if (VoiceCommandPolicy.sosDue(now, sosAt, q)) {
                sosPending = false;
                Log.w(TAG, "voz: SOS por voz confirmado (sin cancelar)");
                host.sos();
            } else {
                act.postDelayed(this, 250L);
            }
        }
    };

    private void startSos() {
        if (sosPending) return;
        sosPending = true;
        sosAt = SystemClock.elapsedRealtime();
        Log.w(TAG, "voz: SOS por voz pedido, 5 s para cancelar");
        say(VoiceCommandPolicy.SOS_START);
        act.postDelayed(sosTick, 250L);
    }
}
