package ar.exertion.casco;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            Log.i("CascoAgente", "BOOT_COMPLETED: arrancando MediaWatcherService");
            try {
                ctx.startForegroundService(new Intent(ctx, MediaWatcherService.class));
            } catch (RuntimeException e) {
                Log.e("CascoAgente", "no se pudo arrancar el servicio: " + e);
            }
        }
    }
}
