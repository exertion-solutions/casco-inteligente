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
import android.os.BatteryManager;
import android.os.FileObserver;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
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
                } else {
                    h.postDelayed(cmdPoll, 5_000L);
                }
                scheduleHeartbeat();
                fall = new FallDetector((SensorManager) getSystemService(SENSOR_SERVICE),
                        () -> h.post(() -> {
                            startLocalStream(); // primero el video (sin red), luego el evento
                            sendEvent("fall", null, null, null, 0, 6);
                        }));
                // sensores en el hilo principal: callback solo hace matematica y despacha a h
                if (!fall.start(new Handler(Looper.getMainLooper()))) {
                    Log.w(TAG, "sin acelerometro: deteccion de caida deshabilitada");
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
                    sendEvent("sos", "KEY_F11", ms, null, 0, 6);
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
            h.postDelayed(this, StreamPolicy.pollDelayMs(cmdFails));
        }
    };

    /** Inserta un evento reintentando (en h, cada 10 s) hasta maxAttempts: SOS/caida no deben perderse. */
    private void sendEvent(String type, String key, Integer ms, String path, int attempt, int maxAttempts) {
        if (sb.insertEvent(type, key, ms, path, battery())) {
            Log.i(TAG, "evento " + type + " enviado");
        } else if (attempt + 1 < maxAttempts) {
            h.postDelayed(() -> sendEvent(type, key, ms, path, attempt + 1, maxAttempts), 10_000L);
        } else {
            Log.e(TAG, "evento " + type + " descartado tras " + maxAttempts + " intentos");
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
                sb.insertEvent("heartbeat", null, null, null, battery());
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
        if (fall != null) fall.stop();
        for (FileObserver o : observers) if (o != null) o.stopWatching();
        if (h != null) h.removeCallbacksAndMessages(null);
        if (hThread != null) hThread.quitSafely();
        if (upThread != null) upThread.quitSafely();
        super.onDestroy();
    }
}
