package ar.exertion.casco;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.hardware.SensorManager;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.SystemClock;
import android.os.BatteryManager;
import android.os.FileObserver;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Servicio en primer plano: observa CapPicture/CapCamera de RundeCap, copia cada archivo nuevo a
 * almacenamiento propio (RundeCap lo borra tras subirlo), lo sube y publica eventos
 * (photo/video/sos/fall/heartbeat) en Supabase.
 *
 * Hilos: observer = FileObserver (solo copia rapida), h = eventos, up = subidas (lentas),
 * main = sensores (callback liviano que despacha a h).
 */
public class MediaWatcherService extends Service {
    static final String ACTION_SOS = "ar.exertion.casco.SOS";
    private static final String TAG = "CascoAgente";
    private static final long HEARTBEAT_MS = 5 * 60_000L;
    private static final long POLL_MS = 5_000L;
    private static final long UPLOAD_RETRY_MS = 30_000L;
    private static final int UPLOAD_ATTEMPTS = 3;
    private static final String[][] DIRS = {{"CapPicture", "photo"}, {"CapCamera", "video"}};

    private HandlerThread hThread, upThread;
    private Handler h, up;
    private Supabase sb;
    private Config cfg;
    private File spool;
    private FallDetector fall;
    private OrientationTracker orient;
    private ManDownPolicy mandown;
    private VoiceCallManager voiceCall;
    private BroadcastAgent bcast;
    private HandlerThread sensorThread, teleThread;
    private Handler tele;
    private int sensorOrientation = 90;
    private static volatile MediaWatcherService instance;
    private boolean started;
    private final FileObserver[] observers = new FileObserver[DIRS.length]; // referencia viva
    private final Set<String> seen = new HashSet<>();

    @Override
    public void onCreate() {
        super.onCreate();
        goForeground(); // primero: si algo falla despues, igual se cumple startForeground()
        hThread = new HandlerThread("casco-events");
        hThread.start();
        h = new Handler(hThread.getLooper());
        upThread = new HandlerThread("casco-upload");
        upThread.start();
        up = new Handler(upThread.getLooper());
        spool = new File(getFilesDir(), "spool");
        spool.mkdirs();
        instance = this;
        Log.i(TAG, "MediaWatcherService onCreate");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        Log.i(TAG, "MediaWatcherService onStartCommand action=" + action + " started=" + started);
        if (!started) {
            cfg = Config.load(this);
            if (cfg == null || !cfg.valid()) {
                Log.e(TAG, "config.json ausente o incompleto en getExternalFilesDir");
            } else {
                sb = new Supabase(cfg);
                if (checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE)
                        != PackageManager.PERMISSION_GRANTED) {
                    Log.w(TAG, "falta READ_EXTERNAL_STORAGE: otorgar con 'pm grant'; no se veran fotos");
                }
                StreamService.shared = sb;
                recoverSpool();
                armObservers(true);
                h.postDelayed(poll, POLL_MS);
                if (cfg.streamHost.isEmpty()) {
                    Log.w(TAG, "sin stream_host valido en config.json: video deshabilitado");
                }
                // el poll corre siempre: comandos de video (si hay stream_host) y ordenes del supervisor
                h.postDelayed(cmdPoll, 5_000L);
                scheduleHeartbeat();
                SpanishVoice.promptsOn = cfg.voicePrompts;
                // el TTS tambien hace falta para las ordenes del supervisor aunque voice_prompts sea false
                if (cfg.voicePrompts || cfg.broadcastEnabled) SpanishVoice.instance = new SpanishVoice(this);
                mandown = new ManDownPolicy(cfg.mandownEnabled, cfg.mandownStillSeconds,
                        cfg.mandownConfirmSeconds, cfg.mandownInactivitySeconds);
                SensorManager smgr = (SensorManager) getSystemService(SENSOR_SERVICE);
                // sensores en su propio hilo: el callback solo hace matematica y despacha a h
                sensorThread = new HandlerThread("casco-sensors");
                sensorThread.start();
                Handler sensH = new Handler(sensorThread.getLooper());
                fall = new FallDetector(smgr, new FallDetector.Callback() {
                    @Override public void onFall(float impact) {
                        h.post(() -> {
                            startLocalStream(); // primero el video (sin red), luego el evento
                            sendEvent("fall", null, null, null, 0, 6);
                            handleMandown(mandown.onImpact(SystemClock.elapsedRealtime(), impact));
                        });
                    }
                    @Override public void onWindow(boolean still) {
                        h.post(() -> handleMandown(mandown.update(SystemClock.elapsedRealtime(), still)));
                    }
                });
                if (!fall.start(sensH)) {
                    Log.w(TAG, "sin acelerometro: deteccion de caida deshabilitada");
                }
                orient = new OrientationTracker(smgr);
                if (!orient.start(sensH)) Log.w(TAG, "sin acelerometro: orientacion fija en 0");
                teleThread = new HandlerThread("casco-tele");
                teleThread.start();
                tele = new Handler(teleThread.getLooper());
                tele.post(() -> sensorOrientation = OrientationTracker.readSensorOrientation(this));
                tele.postDelayed(oriTick, 5_000L);
                voiceCall = new VoiceCallManager(this, sb, cfg);
                voiceCall.start();
                if (cfg.broadcastEnabled) {
                    bcast = new BroadcastAgent(this, sb, cfg);
                    bcast.start();
                }
                started = true;
                Log.i(TAG, "agente iniciado device_id=" + cfg.deviceId);
            }
        }
        if (ACTION_SOS.equals(action)) {
            final int ms = intent.getIntExtra("press_ms", 0);
            if (sb == null) {
                Log.e(TAG, "SOS recibido pero sin config valida: evento perdido");
            } else {
                h.post(() -> {
                    startLocalStream();
                    if (mandown != null && mandown.onManualSos(SystemClock.elapsedRealtime())
                            == ManDownPolicy.Act.ALERT) {
                        // F11 durante la cuenta regresiva: un solo SOS, con reason manual_en_caida
                        sendEvent("sos", "KEY_F11", ms, null, mandownPayload(), 0, 6);
                    } else {
                        sendEvent("sos", "KEY_F11", ms, null, null, 0, 6);
                    }
                });
            }
        }
        return START_STICKY;
    }

    /** SOS/caida: transmite 120 s sin esperar comando (si hay stream_host y no hay ya una transmision). */
    private void startLocalStream() {
        if (cfg == null || cfg.streamHost.isEmpty() || StreamService.source != StreamPolicy.SRC_NONE) return;
        StreamService.start(this, StreamPolicy.SRC_LOCAL);
    }

    private String lastCmdId;
    private int cmdFails;

    /** Cada 3 s (en h): ultimo comando de stream -> StreamPolicy decide. Backoff hasta 30 s si falla la red. */
    private final Runnable cmdPoll = new Runnable() {
        @Override public void run() {
            if (!cfg.streamHost.isEmpty()) {
                try {
                    String[] c = sb.latestStreamCommand();
                    String id = c == null ? null : c[0];
                    StreamPolicy.Act act = StreamPolicy.decide(id, c == null ? null : c[1], lastCmdId, StreamService.source);
                    if (act == StreamPolicy.Act.START) {
                        Log.i(TAG, "comando start recibido");
                        StreamService.start(MediaWatcherService.this, StreamPolicy.SRC_REMOTE);
                    } else if (act == StreamPolicy.Act.STOP) {
                        Log.i(TAG, "comando stop/vencido: deteniendo transmision");
                        StreamService.stop(MediaWatcherService.this);
                    }
                    if (id != null) lastCmdId = id;
                    if (cmdFails > 0) Log.i(TAG, "poll de comandos recuperado");
                    cmdFails = 0;
                } catch (Exception e) {
                    if (cmdFails++ == 0) Log.w(TAG, "poll de comandos fallo (backoff hasta 30 s): " + e.getMessage());
                }
            }
            // ordenes del supervisor: la red corre en su propio hilo (no demora SOS en h); backoff propio
            if (bcast != null) bcast.tick();
            h.postDelayed(this, StreamPolicy.pollDelayMs(cmdFails));
        }
    };

    /** Inserta un evento reintentando (en h, cada 10 s) hasta maxAttempts: SOS/caida no deben perderse. */
    private void sendEvent(String type, String key, Integer ms, String path, int attempt, int maxAttempts) {
        sendEvent(type, key, ms, path, null, attempt, maxAttempts);
    }

    private void sendEvent(String type, String key, Integer ms, String path, JSONObject payload,
                           int attempt, int maxAttempts) {
        if (sb.insertEvent(type, key, ms, path, battery(), payload)) {
            Log.i(TAG, "evento " + type + " enviado");
            if ("sos".equals(type)) SpanishVoice.say(SpanishVoice.EMERGENCIA);
        } else if (attempt + 1 < maxAttempts) {
            h.postDelayed(() -> sendEvent(type, key, ms, path, payload, attempt + 1, maxAttempts), 10_000L);
        } else {
            Log.e(TAG, "evento " + type + " descartado tras " + maxAttempts + " intentos");
        }
    }

    // ---- hombre caido (docs/PROTOCOLO-VOZ.md seccion 6) ----

    /** En h. Ejecuta lo que pide la politica. */
    private void handleMandown(ManDownPolicy.Act act) {
        switch (act) {
            case CONFIRM:
                Log.i(TAG, "hombre caido: CONFIRMANDO (" + mandown.trigger() + ")");
                SpanishVoice.say(SpanishVoice.CAIDA);
                beep();
                break;
            case BEEP:
                beep();
                break;
            case ALERT:
                Log.w(TAG, "hombre caido: ALERTA");
                startLocalStream();
                sendEvent("sos", null, null, null, mandownPayload(), 0, 6);
                break;
            case RECOVERED:
                Log.i(TAG, "hombre caido: recuperado por movimiento");
                break;
            case CANCELLED:
                Log.i(TAG, "hombre caido: cancelado");
                break;
            default:
                break;
        }
    }

    private JSONObject mandownPayload() {
        try {
            return new JSONObject().put("reason", mandown.reason())
                    .put("still_s", mandown.stillSeconds())
                    .put("impact", Math.round(mandown.impact() * 10) / 10.0)
                    .put("confirm_s", mandown.confirmSeconds())
                    .put("trigger", mandown.trigger());
        } catch (Exception e) {
            return null;
        }
    }

    private void beep() {
        try {
            final ToneGenerator tg = new ToneGenerator(AudioManager.STREAM_ALARM, 100);
            tg.startTone(ToneGenerator.TONE_PROP_BEEP, 250);
            h.postDelayed(tg::release, 600);
        } catch (RuntimeException e) {
            Log.w(TAG, "beep: " + e);
        }
    }

    /** F10/F12 (SosKeyService, sin consumir): cancelan la cuenta regresiva de hombre caido. */
    static void onCancelKey() {
        MediaWatcherService s = instance;
        if (s == null || s.h == null) return;
        s.h.post(() -> {
            if (s.mandown != null) s.handleMandown(s.mandown.onCancelButton(SystemClock.elapsedRealtime()));
        });
    }

    // ---- orientacion (docs/PROTOCOLO-VOZ.md seccion 1) ----

    private final ArrayDeque<Long> oriPubs = new ArrayDeque<>();
    private long lastOriPubAt;
    private int lastOriPub = -1;

    /** En tele (nunca en h ni en callbacks de sensores): cada 5 s, solo mientras transmite. */
    private final Runnable oriTick = new Runnable() {
        @Override public void run() {
            try {
                if (StreamService.source != StreamPolicy.SRC_NONE && orient != null && sb != null) {
                    long now = SystemClock.elapsedRealtime();
                    while (!oriPubs.isEmpty() && now - oriPubs.peekFirst() > 60_000L) oriPubs.pollFirst();
                    int o = orient.orientation();
                    if (OrientationMath.shouldPublish(o != lastOriPub, now, lastOriPubAt, oriPubs.size())) {
                        oriPubs.addLast(now);
                        lastOriPubAt = now;
                        lastOriPub = o;
                        sb.insertEvent("heartbeat", null, null, null, battery(), orientationPayload());
                    }
                }
            } catch (RuntimeException e) {
                Log.w(TAG, "orientacion: " + e);
            }
            tele.postDelayed(this, 5_000L);
        }
    };

    private JSONObject orientationPayload() {
        try {
            int ori = orient != null ? orient.orientation() : 0;
            JSONObject p = new JSONObject().put("rot", OrientationMath.rot(sensorOrientation, ori))
                    .put("ori", ori).put("sens", sensorOrientation).put("enc", cfg.streamRotation);
            DeviceHealth.addTo(this, p); // bat/chg/temp_c/sig/lvl/net/sim/app/free_mb/up_s (omite lo que falte)
            return p;
        } catch (Exception e) {
            return null;
        }
    }

    // ---- observacion de carpetas de RundeCap ----

    /** Arma (o re-arma si la carpeta recien aparecio) los FileObserver. */
    private void armObservers(boolean firstRun) {
        long now = System.currentTimeMillis();
        for (int i = 0; i < DIRS.length; i++) {
            if (observers[i] != null) continue;
            final File d = new File(Config.RUNDE_FILES, DIRS[i][0]);
            final String type = DIRS[i][1];
            if (!d.isDirectory()) {
                if (firstRun) Log.w(TAG, "carpeta inexistente por ahora: " + d);
                continue;
            }
            // FileObserver(String) esta deprecado en API 29 pero es el unico disponible en minSdk 26
            FileObserver o = new FileObserver(d.getAbsolutePath(), FileObserver.CLOSE_WRITE | FileObserver.MOVED_TO) {
                @Override public void onEvent(int event, String name) {
                    if (name != null) ingest(new File(d, name), type);
                }
            };
            o.startWatching();
            observers[i] = o;
            // lo que ya estaba (hace mas de 60 s) es historico: no se sube
            File[] old = d.listFiles();
            if (old != null) {
                for (File f : old) if (now - f.lastModified() > 60_000L) claim(f);
            }
            Log.i(TAG, "observando " + d);
        }
    }

    /** Red de seguridad: re-arma carpetas que aparecen tarde y detecta archivos que inotify no avise. */
    private final Runnable poll = new Runnable() {
        @Override public void run() {
            try {
                armObservers(false);
                long now = System.currentTimeMillis();
                for (String[] dt : DIRS) {
                    File[] fs = new File(Config.RUNDE_FILES, dt[0]).listFiles();
                    if (fs == null) continue;
                    long quiet = dt[1].equals("video") ? 10_000L : 3_000L; // no tocar videos en escritura
                    for (File f : fs) if (now - f.lastModified() > quiet) ingest(f, dt[1]);
                }
            } catch (RuntimeException e) {
                Log.w(TAG, "poll: " + e);
            }
            h.postDelayed(this, POLL_MS);
        }
    };

    private static String ext(String n) {
        n = n.toLowerCase(Locale.ROOT);
        return n.substring(n.lastIndexOf('.') + 1);
    }

    private static boolean wanted(String name, String type) {
        if (name.startsWith(".")) return false; // temporales
        String e = ext(name);
        return type.equals("photo")
                ? (e.equals("jpg") || e.equals("jpeg") || e.equals("png"))
                : (e.equals("mp4") || e.equals("3gp") || e.equals("mkv"));
    }

    /** true la primera vez que se ve este archivo (nombre+tamano). Hilo-seguro. */
    private boolean claim(File f) {
        synchronized (seen) {
            if (seen.size() > 5000) seen.clear(); // ponytail: tope simple, solo duplicaria subidas viejas
            return seen.add(f.getName() + ":" + f.length());
        }
    }

    /**
     * Corre en el hilo del FileObserver (o en h por poll). Copia de inmediato al spool propio porque
     * RundeCap borra el original tras subirlo a su plataforma; la subida va por el hilo up.
     */
    private void ingest(File f, String type) {
        if (!wanted(f.getName(), type) || !f.isFile() || f.length() == 0 || !claim(f)) return;
        final String origName = f.getName();
        Log.i(TAG, "archivo nuevo " + type + ": " + origName + " (" + f.length() + " bytes)");
        if (f.length() > Config.MAX_UPLOAD_BYTES) {
            h.post(() -> sendEvent(type, null, null, null, 0, 2));
            return;
        }
        final File copy = new File(spool, type + "_" + System.currentTimeMillis() + "_"
                + origName.replaceAll("[^A-Za-z0-9._-]", "_"));
        try {
            copyFile(f, copy);
        } catch (Exception e) {
            // el original ya no esta (RundeCap lo borro antes de poder copiarlo): queda al menos el evento
            Log.w(TAG, "no se pudo copiar " + origName + ": " + e);
            copy.delete();
            h.post(() -> sendEvent(type, null, null, null, 0, 2));
            return;
        }
        if (type.equals("photo")) SpanishVoice.say(SpanishVoice.FOTO);
        up.post(() -> upload(copy, type, origName, 0));
    }

    private static void copyFile(File src, File dst) throws Exception {
        try (InputStream in = new FileInputStream(src); OutputStream out = new FileOutputStream(dst)) {
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        }
    }

    /** En hilo up. Reintenta la subida 3 veces (30 s); al final registra el evento con o sin media_path. */
    private void upload(File copy, String type, String origName, int attempt) {
        String path = sb.uploadMedia(copy, type, origName);
        if (path == null && attempt + 1 < UPLOAD_ATTEMPTS) {
            up.postDelayed(() -> upload(copy, type, origName, attempt + 1), UPLOAD_RETRY_MS);
            return;
        }
        copy.delete();
        Log.i(TAG, "subida " + origName + " -> " + path);
        h.post(() -> sendEvent(type, null, null, path, 0, 3));
    }

    /** Archivos copiados que quedaron sin subir (reinicio/crash del servicio). Nombre: type_ts_orig. */
    private void recoverSpool() {
        File[] left = spool.listFiles();
        if (left == null) return;
        for (File f : left) {
            String[] p = f.getName().split("_", 3);
            if (p.length < 3 || f.length() == 0) { f.delete(); continue; }
            final String type = p[0], orig = p[2];
            Log.i(TAG, "recuperando del spool: " + f.getName());
            up.post(() -> upload(f, type, orig, 0));
        }
    }

    private void scheduleHeartbeat() {
        h.postDelayed(new Runnable() {
            @Override public void run() {
                sb.insertEvent("heartbeat", null, null, null, battery(), orientationPayload());
                h.postDelayed(this, HEARTBEAT_MS);
            }
        }, 10_000L);
    }

    private Integer battery() {
        Intent b = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (b == null) return null;
        int level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
        int scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
        return (level < 0 || scale <= 0) ? null : (level * 100 / scale);
    }

    private void goForeground() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        String ch = "casco";
        nm.createNotificationChannel(new NotificationChannel(ch, "Casco Agente", NotificationManager.IMPORTANCE_MIN));
        Notification n = new Notification.Builder(this, ch)
                .setContentTitle("Casco Agente activo")
                .setSmallIcon(android.R.drawable.ic_menu_camera)
                .build();
        startForeground(1, n);
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onDestroy() {
        Log.i(TAG, "MediaWatcherService onDestroy");
        StreamService.shared = null;
        instance = null;
        if (fall != null) fall.stop();
        if (orient != null) orient.stop();
        if (voiceCall != null) voiceCall.stop();
        if (bcast != null) bcast.stop();
        if (sensorThread != null) sensorThread.quitSafely();
        if (tele != null) tele.removeCallbacksAndMessages(null);
        if (teleThread != null) teleThread.quitSafely();
        SpanishVoice v = SpanishVoice.instance;
        if (v != null) v.shutdown();
        for (FileObserver o : observers) if (o != null) o.stopWatching();
        if (h != null) h.removeCallbacksAndMessages(null);
        if (hThread != null) hThread.quitSafely();
        if (upThread != null) upThread.quitSafely();
        super.onDestroy();
    }
}
