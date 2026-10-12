package ar.exertion.casco;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.os.Handler;
import android.util.Log;

/**
 * Orientacion del casco en pasos de 90 (docs/PROTOCOLO-VOZ.md seccion 1). La matematica esta en
 * OrientationMath (pura, testeada). Callback solo hace cuentas: nada de red.
 */
final class OrientationTracker implements SensorEventListener {
    private static final String TAG = "CascoAgente";
    private final SensorManager sm;
    private volatile int orientation = 0;
    private float sx, sy, sz;
    private boolean seeded;

    OrientationTracker(SensorManager sm) { this.sm = sm; }

    boolean start(Handler h) {
        Sensor acc = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        return acc != null && sm.registerListener(this, acc, SensorManager.SENSOR_DELAY_NORMAL, h);
    }

    void stop() { sm.unregisterListener(this); }

    /** 0/90/180/270. */
    int orientation() { return orientation; }

    @Override
    public void onSensorChanged(SensorEvent e) {
        final float k = 0.4f; // suavizado de la gravedad
        if (!seeded) {
            sx = e.values[0]; sy = e.values[1]; sz = e.values[2];
            seeded = true;
        } else {
            sx += k * (e.values[0] - sx);
            sy += k * (e.values[1] - sy);
            sz += k * (e.values[2] - sz);
        }
        orientation = OrientationMath.quantize(orientation, OrientationMath.angle(sx, sy, sz));
    }

    @Override public void onAccuracyChanged(Sensor sensor, int accuracy) { }

    /** SENSOR_ORIENTATION de la camara trasera (Camera2, sin abrirla); 90 si no se puede leer. */
    static int readSensorOrientation(Context c) {
        try {
            CameraManager cm = (CameraManager) c.getSystemService(Context.CAMERA_SERVICE);
            for (String id : cm.getCameraIdList()) {
                CameraCharacteristics ch = cm.getCameraCharacteristics(id);
                Integer facing = ch.get(CameraCharacteristics.LENS_FACING);
                Integer so = ch.get(CameraCharacteristics.SENSOR_ORIENTATION);
                if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK && so != null) {
                    Log.i(TAG, "SENSOR_ORIENTATION camara trasera = " + so);
                    return so;
                }
            }
            Log.w(TAG, "sin camara trasera para leer SENSOR_ORIENTATION: se usa 90");
        } catch (Throwable t) {
            Log.w(TAG, "SENSOR_ORIENTATION no legible (" + t.getClass().getSimpleName() + "): se usa 90");
        }
        return 90;
    }
}
