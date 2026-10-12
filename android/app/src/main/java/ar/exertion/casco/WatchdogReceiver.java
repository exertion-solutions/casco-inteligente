package ar.exertion.casco;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.SystemClock;
import android.util.Log;

/**
 * Watchdog: una alarma exacta (allow-while-idle) cada ~5 min relanza MediaWatcherService si DuraSpeed/LMK
 * lo mato (si sigue vivo, onStartCommand es inofensivo) y vuelve a armarse. Las alarmas sobreviven a la
 * muerte del proceso. Se arma en el arranque (BootReceiver), al iniciar el servicio y en cada disparo.
 */
public class WatchdogReceiver extends BroadcastReceiver {
    static final long PERIOD_MS = 5 * 60_000L;
    private static final String TAG = "CascoAgente";

    static final String ACTION_HEARTBEAT = "ar.exertion.casco.HEARTBEAT";

    /** Alarma de vigilancia (relanza el servicio). */
    static void schedule(Context c) { arm(c, 0, "ar.exertion.casco.WATCHDOG"); }

    /**
     * Alarma del heartbeat (cada 5 min, tambien con el equipo dormido: un Handler.postDelayed se frena al
     * suspender). Doze limita las alarmas allow-while-idle (~1 cada 9 min en reposo profundo).
     */
    static void scheduleHeartbeat(Context c) { arm(c, 1, ACTION_HEARTBEAT); }

    private static void arm(Context c, int requestCode, String action) {
        try {
            AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
            PendingIntent pi = PendingIntent.getBroadcast(c, requestCode,
                    new Intent(c, WatchdogReceiver.class).setAction(action),
                    PendingIntent.FLAG_UPDATE_CURRENT);
            am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP,
                    SystemClock.elapsedRealtime() + (requestCode == 1 ? RemoteConfig.heartbeatMs(PERIOD_MS) : PERIOD_MS), pi);
        } catch (RuntimeException e) {
            Log.w(TAG, "alarma " + action + ": no se pudo armar: " + e);
        }
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        // primero re-armar: si el arranque falla, el siguiente ciclo reintenta
        boolean hb = ACTION_HEARTBEAT.equals(intent.getAction());
        if (hb) scheduleHeartbeat(ctx); else schedule(ctx);
        try {
            ctx.startForegroundService(new Intent(ctx, MediaWatcherService.class)
                    .setAction(hb ? MediaWatcherService.ACTION_HEARTBEAT : MediaWatcherService.ACTION_WATCHDOG));
        } catch (RuntimeException e) {
            Log.e(TAG, "watchdog: no se pudo relanzar el servicio: " + e);
        }
    }
}
