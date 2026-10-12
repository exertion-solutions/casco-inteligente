package ar.exertion.casco;

import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Handler;
import android.os.SystemClock;

/**
 * Deteccion de impacto + medicion de quietud (ver docs/PROTOCOLO-VOZ.md seccion 6).
 *  - Impacto: (caida libre |a| baja) o (giro violento |w| > 6 rad/s), seguido de |a| > 25 m/s2.
 *  - Quietud: por ventanas de 1 s, desvio estandar de |a| < 0.6 m/s2 y |w| medio < 0.15 rad/s.
 * Los callbacks corren en el hilo del Handler pasado a start(): deben ser livianos (nada de red).
 * ponytail: umbrales fijos; calibrar con pruebas reales (FREE_FALL_MS2, IMPACT_MS2, GYRO_VIOLENT).
 */
final class FallDetector implements SensorEventListener {
    interface Callback {
        void onFall(float impactMs2);
        /** Fin de una ventana de 1 s: true si el casco estuvo quieto. */
        void onWindow(boolean still);
    }

    private static final float FREE_FALL_MS2 = 3.0f;   // ~0,3 g
    private static final float IMPACT_MS2 = 25.0f;     // ~2,5 g
    private static final float GYRO_VIOLENT = 6.0f;    // rad/s
    private static final float STILL_ACC_STD = 0.6f;   // m/s2
    private static final float STILL_GYRO = 0.15f;     // rad/s
    private static final long FREE_FALL_MIN_MS = 80;
    private static final long IMPACT_WINDOW_MS = 1000;
    private static final long COOLDOWN_MS = 30_000;
    private static final long WINDOW_MS = 1000;
    private static final int MIN_SAMPLES = 8;

    private final SensorManager sm;
    private final Callback cb;
    private long freeFallSince = 0, lastFreeFallEnd = 0, lastFallAt = 0, lastGyroViolentAt = 0;

    // ventana de quietud
    private long winStart = 0;
    private int accN, gyroN;
    private double accSum, accSumSq, gyroSum;

    FallDetector(SensorManager sm, Callback cb) {
        this.sm = sm;
        this.cb = cb;
    }

    boolean start(Handler h) {
        Sensor acc = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        if (acc == null) return false;
        Sensor gyro = sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
        if (gyro != null) sm.registerListener(this, gyro, SensorManager.SENSOR_DELAY_GAME, h);
        return sm.registerListener(this, acc, SensorManager.SENSOR_DELAY_GAME, h);
    }

    void stop() { sm.unregisterListener(this); }

    @Override
    public void onSensorChanged(SensorEvent e) {
        float x = e.values[0], y = e.values[1], z = e.values[2];
        float mag = (float) Math.sqrt(x * x + y * y + z * z);
        long now = SystemClock.elapsedRealtime(); // monotono: inmune a cambios de hora (NTP)

        if (e.sensor.getType() == Sensor.TYPE_GYROSCOPE) {
            if (mag > GYRO_VIOLENT) lastGyroViolentAt = now;
            gyroSum += mag;
            gyroN++;
            return;
        }

        // ---- acelerometro: impacto
        if (mag < FREE_FALL_MS2) {
            if (freeFallSince == 0) freeFallSince = now;
        } else {
            if (freeFallSince != 0 && now - freeFallSince >= FREE_FALL_MIN_MS) lastFreeFallEnd = now;
            freeFallSince = 0;
        }
        boolean freeFall = lastFreeFallEnd != 0 && now - lastFreeFallEnd <= IMPACT_WINDOW_MS;
        boolean spin = lastGyroViolentAt != 0 && now - lastGyroViolentAt <= IMPACT_WINDOW_MS;
        if (mag > IMPACT_MS2 && (freeFall || spin) && now - lastFallAt > COOLDOWN_MS) {
            lastFallAt = now;
            lastFreeFallEnd = 0;
            lastGyroViolentAt = 0;
            cb.onFall(mag);
        }

        // ---- acelerometro: ventana de quietud
        if (winStart == 0) winStart = now;
        accSum += mag;
        accSumSq += (double) mag * mag;
        accN++;
        if (now - winStart >= WINDOW_MS) {
            if (accN >= MIN_SAMPLES) {
                double mean = accSum / accN;
                double std = Math.sqrt(Math.max(0, accSumSq / accN - mean * mean));
                double gyro = gyroN > 0 ? gyroSum / gyroN : 0; // sin giroscopio: solo cuenta la aceleracion
                cb.onWindow(std < STILL_ACC_STD && gyro < STILL_GYRO);
            }
            winStart = now;
            accN = gyroN = 0;
            accSum = accSumSq = gyroSum = 0;
        }
    }

    @Override public void onAccuracyChanged(Sensor sensor, int accuracy) { }
}
