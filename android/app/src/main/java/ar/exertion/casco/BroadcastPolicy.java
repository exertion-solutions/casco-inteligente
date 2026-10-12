package ar.exertion.casco;

import java.util.ArrayDeque;
import java.util.List;

/**
 * Logica pura (sin Android) de ordenes del supervisor (docs/PROTOCOLO-CENTRO.md seccion 4).
 * Testeable con BroadcastPolicyCheck. Texto con escapes unicode (no depender del encoding de javac).
 */
final class BroadcastPolicy {
    static final int MAX_SEEN = 50;
    static final long CYCLE_MS = 8_000L;        // una repeticion cada ~8 s
    static final long SIREN_MS = 3_000L;        // sirena al comienzo de cada ciclo de evacuacion
    static final long CALL_WAIT_MAX_MS = 60_000L;
    static final long WINDOW_MS = 120_000L;     // RLS: solo ordenes de los ultimos 2 min

    private BroadcastPolicy() { }

    static final String DEFAULT_EVAC = "Diríjase al punto de reunión";

    /** Frase hablada. kind: 'evacuacion' | 'mensaje'; otro -> null (se ignora). */
    static String phrase(String kind, String message) {
        String m = message == null ? "" : message.trim();
        if ("evacuacion".equals(kind)) {
            return "Atención. Evacuación. " + (m.isEmpty() ? DEFAULT_EVAC : m);
        }
        if ("mensaje".equals(kind)) {
            return m.isEmpty() ? null : "Mensaje del supervisor: " + m;
        }
        return null;
    }

    static int clampRepeat(int r) { return Math.max(1, Math.min(5, r)); }

    /** deviceIds == null (o vacio) = todos los cascos. */
    static boolean targets(List<String> deviceIds, String me) {
        if (deviceIds == null) return true;
        return deviceIds.contains(me);
    }

    /** Dedupe por id: ultimos MAX_SEEN ids, serializables a texto (un id por linea) para persistir. */
    static final class Seen {
        private final ArrayDeque<String> ids = new ArrayDeque<>();

        /** true si es la primera vez que se ve este id (y lo registra). */
        synchronized boolean add(String id) {
            if (id == null || id.isEmpty() || ids.contains(id)) return false;
            ids.addLast(id);
            while (ids.size() > MAX_SEEN) ids.pollFirst();
            return true;
        }

        synchronized String serialize() {
            StringBuilder sb = new StringBuilder();
            for (String s : ids) sb.append(s).append('\n');
            return sb.toString();
        }

        /** Ignora lineas vacias o con caracteres raros (archivo corrupto). */
        synchronized void load(String text) {
            ids.clear();
            if (text == null) return;
            for (String line : text.split("\n")) {
                String s = line.trim();
                if (s.matches("[A-Za-z0-9-]{1,64}")) add(s);
            }
        }

        synchronized int size() { return ids.size(); }
    }

    /** ISO-8601 UTC (segundos) del instante pedido; para created_at=gte.<...>. */
    static String isoUtc(long epochMs) {
        java.text.SimpleDateFormat f = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.US);
        f.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return f.format(new java.util.Date(epochMs));
    }

    /** Espera por llamada activa: true = ya se puede empezar (sin llamada, o vencio el tope de 60 s). */
    static boolean canStart(boolean inCall, long waitedMs) {
        return !inCall || waitedMs >= CALL_WAIT_MAX_MS;
    }

    /** Volumen del sistema (indice) para un porcentaje 0..100 y el maximo del stream. */
    static int volumeIndex(int percent, int max) {
        int p = Math.max(0, Math.min(100, percent));
        return Math.max(0, Math.min(max, Math.round(max * p / 100f)));
    }

    /** PCM 16-bit mono de una sirena (barrido 600-1200 Hz de ida y vuelta). */
    static short[] siren(int sampleRate, int ms) {
        int n = sampleRate * ms / 1000;
        short[] out = new short[n];
        double phase = 0;
        for (int i = 0; i < n; i++) {
            double t = (double) i / n;                       // 0..1
            double tri = t < 0.5 ? t * 2 : (1 - t) * 2;      // 0..1..0
            double f = 600 + 600 * tri;
            phase += 2 * Math.PI * f / sampleRate;
            out[i] = (short) (Math.sin(phase) * 0.9 * Short.MAX_VALUE);
        }
        return out;
    }
}
