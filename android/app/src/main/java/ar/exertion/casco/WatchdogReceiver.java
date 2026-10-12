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

    static void schedule(Context c) {
        try {
            AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
            PendingIntent pi = PendingIntent.getBroadcast(c, 0,
                    new Intent(c, WatchdogReceiver.class).setAction("ar.exertion.casco.WATCHDOG"),
                    PendingIntent.FLAG_UPDATE_CURRENT);
            am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP,
                    SystemClock.elapsedRealtime() + PERIOD_MS, pi);
        } catch (RuntimeException e) {
            Log.w(TAG, "watchdog: no se pudo armar: " + e);
        }
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        schedule(ctx); // primero re-armar: si el arranque falla, el siguiente ciclo reintenta
        try {
            ctx.startForegroundService(new Intent(ctx, MediaWatcherService.class)
                    .setAction(MediaWatcherService.ACTION_WATCHDOG));
        } catch (RuntimeException e) {
            Log.e(TAG, "watchdog: no se pudo relanzar el servicio: " + e);
        }
    }
}
