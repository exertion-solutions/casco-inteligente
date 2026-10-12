package ar.exertion.casco;

import android.accessibilityservice.AccessibilityService;
import android.content.Intent;
import android.os.SystemClock;
import android.util.Log;
import android.view.KeyEvent;
import android.view.accessibility.AccessibilityEvent;

/**
 * Detecta el boton SOS fisico. En este casco (mtk-kpd) emite KEY_F11 = KEYCODE_F11 (142).
 * No consume el evento: la app RundeCap sigue recibiendolo y reportando a su plataforma.
 */
public class SosKeyService extends AccessibilityService {
    private static final String TAG = "CascoAgente";
    static final int SOS_KEYCODE = KeyEvent.KEYCODE_F11;
    private long downAt = -1;

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        Log.i(TAG, "SosKeyService conectado");
        startWatcher(new Intent(this, MediaWatcherService.class));
    }

    // startForegroundService: valido aunque la app este en segundo plano en Android 8-11;
    // MediaWatcherService llama startForeground() en onCreate, cumpliendo el contrato de 5 s.
    private void startWatcher(Intent i) {
        try {
            startForegroundService(i);
        } catch (RuntimeException e) {
            Log.e(TAG, "no se pudo arrancar MediaWatcherService: " + e);
        }
    }

    @Override
    protected boolean onKeyEvent(KeyEvent e) {
        if (e.getKeyCode() == SOS_KEYCODE) {
            if (e.getAction() == KeyEvent.ACTION_DOWN) {
                // repeatCount 0 = pulsacion nueva; evita que un UP perdido deje downAt colgado
                if (downAt < 0 || e.getRepeatCount() == 0) downAt = SystemClock.elapsedRealtime();
                Log.i(TAG, "F11 down");
            } else if (e.getAction() == KeyEvent.ACTION_UP) {
                int ms = downAt >= 0 ? (int) (SystemClock.elapsedRealtime() - downAt) : 0;
                downAt = -1;
                Log.i(TAG, "F11 recibido press_ms=" + ms);
                startWatcher(new Intent(this, MediaWatcherService.class)
                        .setAction(MediaWatcherService.ACTION_SOS)
                        .putExtra("press_ms", ms));
            }
        }
        return false; // no consumir
    }

    @Override public void onAccessibilityEvent(AccessibilityEvent event) { }
    @Override public void onInterrupt() { }
}
