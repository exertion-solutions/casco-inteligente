package ar.exertion.casco;

import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Handler;
import android.os.SystemClock;

/**
 * Deteccion de caida por acelerometro: caida libre (|a| baja) seguida de impacto (|a| alta).
 * ponytail: umbrales fijos, sin filtrar "casco apoyado/lanzado" vs persona; calibrar con pruebas
 * reales (FREE_FALL_MS2, IMPACT_MS2) y sumar inmovilidad posterior si hay falsos positivos.
 */
final class FallDetector implements SensorEventListener {
    interface Callback { void onFall(); }

    private static final float FREE_FALL_MS2 = 3.0f;   // ~0,3 g
    private static final float IMPACT_MS2 = 25.0f;     // ~2,5 g
    private static final long FREE_FALL_MIN_MS = 80;
    private static final long IMPACT_WINDOW_MS = 1000;
    private static final long COOLDOWN_MS = 30_000;

    private final SensorManager sm;
    private final Callback cb;
    private long freeFallSince = 0, lastFreeFallEnd = 0, lastFallAt = 0;

    FallDetector(SensorManager sm, Callback cb) {
        this.sm = sm;
        this.cb = cb;
    }

    /** onFall() corre en el hilo del Handler: debe ser liviano (nada de red aqui). */
    boolean start(Handler h) {
        Sensor acc = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        if (acc == null) return false;
        return sm.registerListener(this, acc, SensorManager.SENSOR_DELAY_GAME, h);
    }

    void stop() { sm.unregisterListener(this); }

    @Override
    public void onSensorChanged(SensorEvent e) {
        float x = e.values[0], y = e.values[1], z = e.values[2];
        float mag = (float) Math.sqrt(x * x + y * y + z * z);
        long now = SystemClock.elapsedRealtime(); // monotono: inmune a cambios de hora (NTP)

        if (mag < FREE_FALL_MS2) {
            if (freeFallSince == 0) freeFallSince = now;
        } else {
            if (freeFallSince != 0 && now - freeFallSince >= FREE_FALL_MIN_MS) lastFreeFallEnd = now;
            freeFallSince = 0;
        }

        if (mag > IMPACT_MS2 && lastFreeFallEnd != 0
                && now - lastFreeFallEnd <= IMPACT_WINDOW_MS
                && now - lastFallAt > COOLDOWN_MS) {
            lastFallAt = now;
            lastFreeFallEnd = 0;
            cb.onFall();
        }
    }

    @Override public void onAccuracyChanged(Sensor sensor, int accuracy) { }
}
