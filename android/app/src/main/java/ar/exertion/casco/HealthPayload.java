package ar.exertion.casco;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Logica pura (sin Android) del payload de salud del equipo (docs/PROTOCOLO-CENTRO.md seccion 3).
 * Todo valor desconocido es null y el campo se OMITE. Testeable con HealthPayloadCheck.
 */
final class HealthPayload {
    private HealthPayload() { }

    /** Claves en el orden del protocolo. Los nulos no se incluyen. */
    static Map<String, Object> build(Integer bat, Boolean chg, Double tempC, Integer sig, Integer lvl,
                                     String net, Integer sim, String app, Long freeMb, Long upS) {
        Map<String, Object> m = new LinkedHashMap<>();
        put(m, "bat", bat);
        put(m, "chg", chg);
        put(m, "temp_c", tempC);
        put(m, "sig", sig);
        put(m, "lvl", lvl);
        put(m, "net", net == null || net.isEmpty() ? null : net);
        put(m, "sim", sim);
        put(m, "app", app == null || app.isEmpty() ? null : app);
        put(m, "free_mb", freeMb);
        put(m, "up_s", upS);
        return m;
    }

    private static void put(Map<String, Object> m, String k, Object v) {
        if (v != null) m.put(k, v);
    }

    /** Porcentaje 0..100 o null si el sistema no informa. */
    static Integer batteryPct(int level, int scale) {
        if (level < 0 || scale <= 0) return null;
        return Math.min(100, level * 100 / scale);
    }

    /** BatteryManager.EXTRA_TEMPERATURE viene en decimas de grado; fuera de -40..150 C es dato invalido. */
    static Double tempC(int tenths) {
        if (tenths < -400 || tenths > 1500) return null;
        return tenths / 10.0;
    }

    /** Nivel de senal 0..4 (SignalStrength.getLevel) o null. */
    static Integer level(int l) {
        return (l < 0 || l > 4) ? null : l;
    }

    /** dBm plausible (-140..-30); Integer.MAX_VALUE es el "no disponible" de Android. */
    static Integer dbm(int d) {
        return (d < -140 || d > -30) ? null : d;
    }

    static Long freeMb(long bytes) {
        return bytes < 0 ? null : bytes / (1024L * 1024L);
    }

    static Long upSeconds(long elapsedMs) {
        return elapsedMs < 0 ? null : elapsedMs / 1000L;
    }

    /** Subtipo de red movil (TelephonyManager.NETWORK_TYPE_*) -> "2G"/"3G"/"LTE"/"5G"; null si desconocido. */
    static String netName(int subtype) {
        switch (subtype) {
            case 1: case 2: case 4: case 7: case 11: case 16:
                return "2G";
            case 3: case 5: case 6: case 8: case 9: case 10: case 12: case 14: case 15: case 17:
                return "3G";
            case 13: case 19:
                return "LTE";
            case 20:
                return "5G";
            case 18:
                return "IWLAN";
            default:
                return null;
        }
    }

    /** Mezcla (sin pisar) los campos de salud en el mapa base (orientacion). */
    static Map<String, Object> merge(Map<String, Object> base, Map<String, Object> health) {
        Map<String, Object> m = new LinkedHashMap<>();
        if (base != null) m.putAll(base);
        if (health != null) for (Map.Entry<String, Object> e : health.entrySet()) m.putIfAbsent(e.getKey(), e.getValue());
        return m;
    }
}
