package ar.exertion.casco;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;

/**
 * Actividad minima sin UI. Abrirla (icono o 'am start') saca al paquete del estado "stopped" y de la
 * supresion de MediaTek DuraSpeed, y arranca el servicio. Sin esto, tras un force-stop el sistema
 * no vuelve a lanzar el agente.
 */
public class LauncherActivity extends Activity {
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        Log.i("CascoAgente", "LauncherActivity abierta: arrancando MediaWatcherService");
        try {
            startForegroundService(new Intent(this, MediaWatcherService.class));
        } catch (RuntimeException e) {
            Log.e("CascoAgente", "no se pudo arrancar el servicio: " + e);
        }
        finish();
    }
}
