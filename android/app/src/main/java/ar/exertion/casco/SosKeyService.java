package ar.exertion.casco;

import android.accessibilityservice.AccessibilityService;
import android.content.Intent;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.view.accessibility.AccessibilityEvent;

/**
 * Detecta el boton SOS fisico. En este casco (mtk-kpd) emite KEY_F11 = KEYCODE_F11 (142).
 * No consume el evento: la app RundeCap sigue recibiendolo y reportando a su plataforma.
 */
public class SosKeyService extends AccessibilityService {
    static final int SOS_KEYCODE = KeyEvent.KEYCODE_F11;
    private long downAt = -1;

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        startService(new Intent(this, MediaWatcherService.class));
    }

    @Override
    protected boolean onKeyEvent(KeyEvent e) {
        if (e.getKeyCode() == SOS_KEYCODE) {
            if (e.getAction() == KeyEvent.ACTION_DOWN && downAt < 0) {
                downAt = SystemClock.elapsedRealtime();
            } else if (e.getAction() == KeyEvent.ACTION_UP && downAt >= 0) {
                int ms = (int) (SystemClock.elapsedRealtime() - downAt);
                downAt = -1;
                Intent i = new Intent(this, MediaWatcherService.class)
                        .setAction(MediaWatcherService.ACTION_SOS)
                        .putExtra("press_ms", ms);
                startService(i);
            }
        }
        return false; // no consumir
    }

    @Override public void onAccessibilityEvent(AccessibilityEvent event) { }
    @Override public void onInterrupt() { }
}
