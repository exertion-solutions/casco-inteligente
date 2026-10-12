package ar.exertion.casco;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Configuracion remota por casco (docs/PROTOCOLO-COMANDOS.md seccion 3). PURA (sin Android): valida rangos y
 * guarda el valor vigente; la descarga y la persistencia las hace CommandAgent. Un valor ausente (null) =
 * "usar la config local". Claves desconocidas se ignoran; un valor fuera de rango se descarta (queda el local).
 * La config del servidor es el estado completo: cada descarga reemplaza a la anterior.
 */
final class RemoteConfig {
    private RemoteConfig() { }

    static final class Values {
        final Double fallG;              // fall_g_threshold: umbral de impacto en g (2.0..8.0)
        final Integer inactivityS;       // 0 (apagado) o 120..3600
        final Integer notWornS;          // 30..1800
        final Integer heartbeatS;        // 60..1800
        final Integer locationS;         // 10..600
        final Integer locationSAlert;    // 5..300
        final Integer broadcastVolume;   // 0..100
        final Boolean streamAudio, voiceCommands, torchAllowed;
        /** Claves conocidas con valor invalido (para el log). */
        final List<String> rejected;

        Values(Double fallG, Integer inactivityS, Integer notWornS, Integer heartbeatS, Integer locationS,
               Integer locationSAlert, Integer broadcastVolume, Boolean streamAudio, Boolean voiceCommands,
               Boolean torchAllowed, List<String> rejected) {
            this.fallG = fallG; this.inactivityS = inactivityS; this.notWornS = notWornS;
            this.heartbeatS = heartbeatS; this.locationS = locationS; this.locationSAlert = locationSAlert;
            this.broadcastVolume = broadcastVolume; this.streamAudio = streamAudio;
            this.voiceCommands = voiceCommands; this.torchAllowed = torchAllowed; this.rejected = rejected;
        }
    }

    static final Values NONE = new Values(null, null, null, null, null, null, null, null, null, null,
            new ArrayList<String>());

    private static volatile Values cur = NONE;

    static Values current() { return cur; }

    static void set(Values v) { cur = v == null ? NONE : v; }

    /** Entero de un valor JSON (Integer/Long/Double integral); null si no es un entero. */
    private static Integer asInt(Object o) {
        if (!(o instanceof Number)) return null;
        double d = ((Number) o).doubleValue();
        if (Double.isNaN(d) || Double.isInfinite(d) || d != Math.rint(d) || Math.abs(d) > 1e9) return null;
        return (int) d;
    }

    /** Valida {@code raw} (objeto config del servidor, ya convertido a Map) y devuelve los valores aceptados. */
    static Values parse(Map<String, Object> raw) {
        if (raw == null) return NONE;
        List<String> bad = new ArrayList<>();
        Double fallG = null;
        Object o = raw.get("fall_g_threshold");
        if (o instanceof Number) {
            double d = ((Number) o).doubleValue();
            if (d >= 2.0 && d <= 8.0) fallG = d; else bad.add("fall_g_threshold");
        } else if (o != null) {
            bad.add("fall_g_threshold");
        }
        Integer inact = null;
        o = raw.get("inactivity_s");
        if (o != null) {
            Integer i = asInt(o);
            if (i != null && (i == 0 || (i >= 120 && i <= 3600))) inact = i; else bad.add("inactivity_s");
        }
        return new Values(fallG, inact,
                intKey(raw, "not_worn_s", 30, 1800, bad), intKey(raw, "heartbeat_s", 60, 1800, bad),
                intKey(raw, "location_s", 10, 600, bad), intKey(raw, "location_s_alert", 5, 300, bad),
                intKey(raw, "broadcast_volume", 0, 100, bad),
                boolKey(raw, "stream_audio", bad), boolKey(raw, "voice_commands", bad),
                boolKey(raw, "torch_allowed", bad), bad);
    }

    private static Integer intKey(Map<String, Object> raw, String k, int lo, int hi, List<String> bad) {
        Object o = raw.get(k);
        if (o == null) return null;
        Integer i = asInt(o);
        if (i == null || i < lo || i > hi) { bad.add(k); return null; }
        return i;
    }

    private static Boolean boolKey(Map<String, Object> raw, String k, List<String> bad) {
        Object o = raw.get(k);
        if (o == null) return null;
        if (o instanceof Boolean) return (Boolean) o;
        bad.add(k);
        return null;
    }

    // ---- lectores: el valor remoto, o el local que pasa quien llama ----

    /** Umbral de impacto en m/s2. */
    static float impactMs2(float local) {
        Double g = cur.fallG;
        return g == null ? local : (float) (g * 9.80665);
    }

    static long heartbeatMs(long local) { Integer s = cur.heartbeatS; return s == null ? local : s * 1000L; }
    static long locationMs(long local) { Integer s = cur.locationS; return s == null ? local : s * 1000L; }
    static long locationAlertMs(long local) { Integer s = cur.locationSAlert; return s == null ? local : s * 1000L; }
    static int broadcastVolume(int local) { Integer v = cur.broadcastVolume; return v == null ? local : v; }
    static boolean streamAudio(boolean local) { Boolean b = cur.streamAudio; return b == null ? local : b; }
    static boolean voiceCommands(boolean local) { Boolean b = cur.voiceCommands; return b == null ? local : b; }
    static int notWornS() { Integer s = cur.notWornS; return s == null ? 120 : s; }
    static int inactivityS() { Integer s = cur.inactivityS; return s == null ? 0 : s; }
}
