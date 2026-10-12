package ar.exertion.casco;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Logica pura (sin Android) de robustez del agente: testeable con AgentPolicyCheck. */
final class AgentPolicy {
    private AgentPolicy() { }

    /** SOS y caida: nunca se descartan ni se rinden (cola persistente, backoff sin tope de intentos). */
    static boolean critical(String type) {
        return "sos".equals(type) || "fall".equals(type);
    }

    /** Solo el SOS (incluye hombre caido) anuncia por voz que salio o que quedo registrado. */
    static boolean announces(String type) {
        return "sos".equals(type);
    }

    /** Espera tras el fallo n (1..): critico 2,4,8,16,30,30 s; resto 10 s .. 5 min. */
    static long retryMs(boolean critical, int failures) {
        int n = Math.max(0, Math.min(failures - 1, 10));
        return critical ? Math.min(30_000L, 2_000L << n) : Math.min(5 * 60_000L, 10_000L << n);
    }

    /** Subida de medios: 30 s, 1, 2, 4, 8 y 10 min (tope). */
    static long uploadRetryMs(int attempt) {
        return Math.min(10 * 60_000L, 30_000L << Math.max(0, Math.min(attempt, 5)));
    }

    /** Cuantos archivos (los mas viejos primero) hay que borrar para que el spool entre en {@code cap} bytes. */
    static int dropOldest(long[] sizesOldestFirst, long cap) {
        long total = 0;
        for (long s : sizesOldestFirst) total += s;
        int n = 0;
        while (total > cap && n < sizesOldestFirst.length) total -= sizesOldestFirst[n++];
        return n;
    }

    // ---- ubicacion (docs/PROTOCOLO-GEO.md seccion 1) ----

    static final float MAX_ACC_M = 50f;

    /** Evento location: cada 60 s, cada 30 s con alerta (SOS / hombre caido / transmision local). */
    static long locationIntervalMs(boolean alert) {
        return alert ? 30_000L : 60_000L;
    }

    /** Un fix sirve para publicar si su precision es conocida y <= 50 m. */
    static boolean accuracyOk(boolean hasAccuracy, float acc) {
        return hasAccuracy && acc <= MAX_ACC_M;
    }

    /** Un fix mas viejo que esto no se publica como "posicion actual" (si va en un SOS, con loc_age_s). */
    static boolean fixFresh(long ageS) {
        return ageS <= 120;
    }

    /** No republicar el mismo fix (sin satelites): solo si cambio su marca de tiempo. */
    static boolean newFix(long fixTime, long lastPublishedFixTime) {
        return fixTime != lastPublishedFixTime;
    }

    // ---- llamadas ----

    /** call_id con hangup en la lista: sus offers no se atienden (no abrir el microfono para nada). */
    static Set<String> hungUpCalls(List<String> callIds, List<String> kinds) {
        Set<String> out = new HashSet<>();
        for (int i = 0; i < callIds.size() && i < kinds.size(); i++) {
            if ("hangup".equals(kinds.get(i))) out.add(callIds.get(i));
        }
        return out;
    }

    // ---- logs ----

    /** Quita tokens (JWT) y pass= de un texto antes de loguearlo. */
    static String redact(String s) {
        if (s == null) return "";
        return s.replaceAll("pass=[^&\\s]+", "pass=***")
                .replaceAll("eyJ[A-Za-z0-9_-]{8,}(\\.[A-Za-z0-9_-]+)*", "***");
    }
}
