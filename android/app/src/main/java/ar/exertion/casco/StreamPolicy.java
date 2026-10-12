package ar.exertion.casco;

/**
 * Logica pura (sin Android) de decision de transmision: testeable con StreamPolicyCheck.
 * Ver tabla de decision en android/README-VIDEO.md.
 */
final class StreamPolicy {
    enum Act { NONE, START, STOP }

    static final int SRC_NONE = 0, SRC_REMOTE = 1, SRC_LOCAL = 2;

    static final long POLL_MS = 3_000L;
    static final long POLL_BACKOFF_MAX_MS = 30_000L;
    static final long MAX_STREAM_MS = 10 * 60_000L;   // tope duro por transmision
    static final long LOCAL_SOS_MS = 120_000L;        // SOS/caida
    static final int MAX_RETRIES = 5;

    private StreamPolicy() { }

    /**
     * @param id        id del ultimo comando vigente (RLS: <2 min) o null si no hay ninguno
     * @param action    'start' / 'stop' (ignorado si id == null)
     * @param lastSeen  ultimo id ya procesado (o null)
     * @param source    quien mantiene la transmision ahora (SRC_*)
     */
    static Act decide(String id, String action, String lastSeen, int source) {
        if (id == null || id.isEmpty()) {
            // sin comando vigente: el comando 'start' vencio -> cortar solo lo que el comando habia arrancado
            return source == SRC_REMOTE ? Act.STOP : Act.NONE;
        }
        if (id.equals(lastSeen)) return Act.NONE; // ya procesado: no reiniciar tras tope/fallo ni re-parar
        if ("start".equals(action)) return source == SRC_REMOTE ? Act.NONE : Act.START; // LOCAL se promueve
        if ("stop".equals(action)) return source != SRC_NONE ? Act.STOP : Act.NONE;
        return Act.NONE;
    }

    /** Espera del poll de comandos tras N errores seguidos de red: 3 s normal; 6, 12, 24, 30 s. */
    static long pollDelayMs(int failures) {
        if (failures <= 0) return POLL_MS;
        return Math.min(POLL_BACKOFF_MAX_MS, POLL_MS << Math.min(failures, 4));
    }

    /** Espera antes del intento de reconexion n (1..MAX_RETRIES): 2, 4, 8, 16, 32 s. */
    static long retryDelayMs(int attempt) {
        return 2_000L << Math.max(0, Math.min(attempt - 1, 4));
    }

    // ---- audio del casco en el video (docs/PROTOCOLO-CENTRO.md seccion 5) ----

    /** Ruta RTMP: con audio activo el casco publica en ingest/<id> (el servidor lo pasa a Opus y republica en live/<id>). */
    static String ingestPath(boolean audioActive, String configuredPath) {
        String p = configuredPath == null || configuredPath.isEmpty() ? "live" : configuredPath;
        return audioActive && p.equals("live") ? "ingest" : p;
    }

    /** Intentos fallidos consecutivos a partir de los cuales se abandona el audio para no perder el video. */
    static final int AUDIO_GIVE_UP_ATTEMPT = 2;

    /** Audio del stream: solo si esta configurado, hay permiso, no fallo antes y se pudo preparar. */
    static boolean wantAudio(boolean cfgAudio, boolean permission, boolean failedBefore) {
        return cfgAudio && permission && !failedBefore;
    }

    /** El microfono del stream se silencia mientras haya llamada de voz (el microfono es del WebRTC). */
    static boolean audioMuted(boolean inCall) {
        return inCall;
    }
}
