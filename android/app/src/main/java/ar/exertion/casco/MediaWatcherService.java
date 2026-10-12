package ar.exertion.casco;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.hardware.SensorManager;
import android.os.IBinder;
import android.util.Log;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * Servicio en primer plano: observa CapPicture/CapCamera de RundeCap, sube los archivos nuevos y
 * publica eventos (photo/video/sos/heartbeat) en Supabase.
 */
public class MediaWatcherService extends Service {
    static final String ACTION_SOS = "ar.exertion.casco.SOS";
    private static final String TAG = "CascoAgente";
    private static final long HEARTBEAT_MS = 5 * 60_000L;

    private HandlerThread thread;
    private Handler h;
    private Supabase sb;
    private Config cfg;
    private final List<android.os.FileObserver> observers = new ArrayList<>();
    private FallDetector fall;
    private boolean started;

    @Override
    public void onCreate() {
        super.onCreate();
        thread = new HandlerThread("casco-io");
        thread.start();
        h = new Handler(thread.getLooper());
        goForeground();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!started) {
            cfg = Config.load(this);
            if (cfg == null || !cfg.valid()) {
                Log.e(TAG, "config.json ausente o incompleto en getExternalFilesDir");
            } else {
                sb = new Supabase(cfg);
                watch("CapPicture", "photo");
                watch("CapCamera", "video");
                scheduleHeartbeat();
                fall = new FallDetector((SensorManager) getSystemService(SENSOR_SERVICE),
                        () -> sb.insertEvent("fall", null, null, null, battery()));
                if (!fall.start(h)) Log.w(TAG, "sin acelerometro: deteccion de caida deshabilitada");
                started = true;
            }
        }
        if (intent != null && ACTION_SOS.equals(intent.getAction()) && sb != null) {
            final int ms = intent.getIntExtra("press_ms", 0);
            h.post(() -> sb.insertEvent("sos", "KEY_F11", ms, null, battery()));
        }
        return START_STICKY;
    }

    private void watch(String dir, final String type) {
        final File d = new File(Config.RUNDE_FILES, dir);
        android.os.FileObserver o = new android.os.FileObserver(d.getAbsolutePath(), android.os.FileObserver.CLOSE_WRITE) {
            @Override public void onEvent(int event, String name) {
                if (name == null) return;
                final File f = new File(d, name);
                if (type.equals("photo") && !isImage(name)) return;
                if (type.equals("video") && !name.endsWith(".mp4")) return;
                h.post(() -> handleFile(f, type));
            }
        };
        o.startWatching();
        observers.add(o); // mantener referencia: si se recolecta, deja de observar
    }

    private static boolean isImage(String n) {
        String s = n.toLowerCase();
        return s.endsWith(".jpg") || s.endsWith(".jpeg") || s.endsWith(".png");
    }

    private void handleFile(File f, String type) {
        if (!f.exists() || f.length() == 0) return;
        String path = null;
        if (f.length() <= Config.MAX_UPLOAD_BYTES) path = sb.uploadMedia(f, type);
        sb.insertEvent(type, null, null, path, battery());
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
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(ch, "Casco Agente", NotificationManager.IMPORTANCE_MIN));
        }
        Notification n = new Notification.Builder(this, ch)
                .setContentTitle("Casco Agente activo")
                .setSmallIcon(android.R.drawable.ic_menu_camera)
                .build();
        startForeground(1, n);
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onDestroy() {
        if (fall != null) fall.stop();
        for (android.os.FileObserver o : observers) o.stopWatching();
        thread.quitSafely();
        super.onDestroy();
    }
}
