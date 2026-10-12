package ar.exertion.casco;

/**
 * Logica pura (sin Android) de la auto-orientacion (docs/PROTOCOLO-VOZ.md seccion 1). Testeable con
 * OrientationCheck. La formula del angulo es la de OrientationEventListener (AOSP).
 */
final class OrientationMath {
    /** Histeresis: se cambia de paso recien al pasar 45 + 15 grados del paso actual. */
    static final int HYSTERESIS_DEG = 15;
    static final long REPUBLISH_MS = 30_000L;
    static final int MAX_PER_MINUTE = 6;

    private OrientationMath() { }

    /** Angulo 0..359 (como OrientationEventListener) con valores crudos del acelerometro; -1 si esta plano. */
    static int angle(float rawX, float rawY, float rawZ) {
        float x = -rawX, y = -rawY, z = -rawZ;
        float mag = x * x + y * y;
        if (mag * 4 < z * z) return -1; // |z| domina: el angulo no es confiable
        int a = 90 - Math.round((float) Math.toDegrees(Math.atan2(-y, x)));
        return ((a % 360) + 360) % 360;
    }

    /** Paso (0/90/180/270) resultante de un angulo nuevo, con histeresis. angle < 0 = plano: sin cambio. */
    static int quantize(int current, int angle) {
        if (angle < 0) return current;
        int diff = ((angle - current) % 360 + 360) % 360;
        int dist = Math.min(diff, 360 - diff);
        if (dist < 45 + HYSTERESIS_DEG) return current;
        return ((angle + 45) / 90 * 90) % 360;
    }

    /** Formula de Camera2 para la camara trasera. */
    static int rot(int sensorOrientation, int orientation) {
        return ((sensorOrientation - orientation) % 360 + 360) % 360;
    }

    /** Publicar el heartbeat de orientacion: solo si cambio o pasaron 30 s, y como mucho 6 por minuto. */
    static boolean shouldPublish(boolean changed, long now, long lastPublishAt, int publishedLastMinute) {
        if (publishedLastMinute >= MAX_PER_MINUTE) return false;
        return changed || lastPublishAt <= 0 || now - lastPublishAt >= REPUBLISH_MS;
    }
}
