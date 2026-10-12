package ar.exertion.casco;

/**
 * Logica pura (sin Android) de los comandos a pedido (docs/PROTOCOLO-COMANDOS.md seccion 1).
 * Testeable con CommandPolicyCheck. El dedupe persistente reusa BroadcastPolicy.Seen (ultimos 50 ids).
 */
final class CommandPolicy {
    private CommandPolicy() { }

    static final long WINDOW_MS = 120_000L; // RLS del device: solo comandos de los ultimos 2 min
    static final int MAX_DETAIL = 200;      // device_command_acks.detail

    enum Action { PHOTO, TORCH_ON, TORCH_OFF, RESTART_AGENT, PING }

    /** RUN = ejecutar; DUP = ya visto; IGNORE = id o accion invalidos (sin ack: el CHECK del servidor no los deja pasar). */
    enum Verdict { RUN, DUP, IGNORE }

    static Action parse(String action) {
        if (action == null) return null;
        switch (action) {
            case "photo": return Action.PHOTO;
            case "torch_on": return Action.TORCH_ON;
            case "torch_off": return Action.TORCH_OFF;
            case "restart_agent": return Action.RESTART_AGENT;
            case "ping": return Action.PING;
            default: return null;
        }
    }

    static boolean validId(String id) {
        return id != null && id.matches("[A-Za-z0-9-]{1,64}");
    }

    /**
     * Registra el id en {@code seen} (el que llama lo persiste ANTES de ejecutar: un restart_agent no debe
     * reejecutarse al volver a arrancar el proceso).
     */
    static Verdict decide(BroadcastPolicy.Seen seen, String id, String action) {
        if (!validId(id) || parse(action) == null) return Verdict.IGNORE;
        return seen.add(id) ? Verdict.RUN : Verdict.DUP;
    }

    /** torch_allowed (device_config) en false bloquea la linterna; null = sin restriccion. */
    static boolean torchAllowed(Boolean remote) {
        return remote == null || remote;
    }

    /** detail del ack: sin saltos de linea, <= 200 caracteres; vacio = null. */
    static String detail(String s) {
        if (s == null) return null;
        String t = s.replaceAll("[\\r\\n\\t]+", " ").trim();
        if (t.isEmpty()) return null;
        return t.length() > MAX_DETAIL ? t.substring(0, MAX_DETAIL) : t;
    }

    /** Un intento de foto sigue valiendo mientras el comando no haya vencido (margen de 20 s). */
    static boolean photoRetryOk(long elapsedSinceReceivedMs) {
        return elapsedSinceReceivedMs < WINDOW_MS - 20_000L;
    }
}
