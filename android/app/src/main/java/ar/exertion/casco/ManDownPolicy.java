package ar.exertion.casco;

/**
 * Hombre caido (docs/PROTOCOLO-VOZ.md seccion 6). Maquina de estados PURA (sin Android, sin hilos):
 * el reloj entra por parametro (ms monotonos) y todo se llama desde un unico hilo.
 * Ver tabla de decision en android/README-VOZ.md. Testeable con ManDownPolicyCheck.
 *
 * Entradas: onImpact (FallDetector), update (una vez por ventana de 1 s: quieto / en movimiento),
 * onCancelButton (F10/F12) y onManualSos (F11 soltada).
 */
final class ManDownPolicy {
    enum State { NORMAL, OBSERVANDO, CONFIRMANDO, ALERTA }

    /** Que debe hacer quien llama: CONFIRM = hablar y arrancar beeps; BEEP; ALERT = enviar SOS. */
    enum Act { NONE, CONFIRM, BEEP, ALERT, RECOVERED, CANCELLED }

    static final long WINDOW_MS = 1_000L;
    static final long MOVE_RECOVER_MS = 3_000L;       // movimiento sostenido que cancela/recupera
    static final long BEEP_EVERY_MS = 3_000L;
    static final long COOLDOWN_MS = 60_000L;          // tras ALERTA
    static final long ACTIVITY_MAX_AGE_MS = 10 * 60_000L;
    static final int ACTIVITY_MIN_WINDOWS = 10;       // 10 s de movimiento = "uso reciente"

    static final String REASON_FALL = "hombre_caido";
    static final String REASON_MANUAL = "manual_en_caida";

    private final boolean enabled;
    private final long stillMs, confirmMs, inactivityMs;

    private State state = State.NORMAL;
    private long stillSince = -1, moveSince = -1;
    private long confirmStart, lastBeep, cooldownUntil;
    private long lastActiveAt;
    private int motionWindows;
    // datos del ultimo evento (para el payload del SOS)
    private float impact;
    private int stillS, confirmS;
    private String reason = REASON_FALL, trigger = "impacto";

    ManDownPolicy(boolean enabled, int stillSeconds, int confirmSeconds, int inactivitySeconds) {
        this.enabled = enabled;
        this.stillMs = stillSeconds * 1000L;
        this.confirmMs = confirmSeconds * 1000L;
        this.inactivityMs = inactivitySeconds * 1000L;
    }

    State state() { return state; }
    String reason() { return reason; }
    String trigger() { return trigger; }
    float impact() { return impact; }
    int stillSeconds() { return stillS; }
    int confirmSeconds() { return confirmS; }

    /** Impacto detectado (caida libre + impacto, o giro violento + impacto). Solo cuenta desde NORMAL. */
    Act onImpact(long now, float peakMs2) {
        if (!enabled || state != State.NORMAL || now < cooldownUntil) return Act.NONE;
        state = State.OBSERVANDO;
        impact = peakMs2;
        trigger = "impacto";
        stillSince = -1;   // se cuentan solo las ventanas posteriores al impacto
        moveSince = -1;
        return Act.NONE;
    }

    /** Resultado de una ventana de 1 s que termina en {@code now}. */
    Act update(long now, boolean still) {
        if (still) {
            if (stillSince < 0) stillSince = now - WINDOW_MS;
            moveSince = -1;
        } else {
            if (moveSince < 0) moveSince = now - WINDOW_MS;
            stillSince = -1;
            if (lastActiveAt > 0 && now - lastActiveAt > ACTIVITY_MAX_AGE_MS) motionWindows = 0;
            lastActiveAt = now;
            motionWindows++;
        }
        long stillFor = stillSince < 0 ? 0 : now - stillSince;
        long moveFor = moveSince < 0 ? 0 : now - moveSince;

        switch (state) {
            case NORMAL:
                if (enabled && inactivityMs > 0 && stillFor >= inactivityMs
                        && motionWindows >= ACTIVITY_MIN_WINDOWS && now - lastActiveAt <= ACTIVITY_MAX_AGE_MS
                        && now >= cooldownUntil) {
                    motionWindows = 0; // para rearmar hace falta volver a usar el casco
                    impact = 0;
                    trigger = "inactividad";
                    return enterConfirm(now, stillFor);
                }
                return Act.NONE;
            case OBSERVANDO:
                if (moveFor >= MOVE_RECOVER_MS) {
                    state = State.NORMAL;
                    return Act.RECOVERED;
                }
                if (stillFor >= stillMs) return enterConfirm(now, stillFor);
                return Act.NONE;
            case CONFIRMANDO:
                if (moveFor >= MOVE_RECOVER_MS) {
                    state = State.NORMAL;
                    return Act.CANCELLED;
                }
                if (now - confirmStart >= confirmMs) return alert(now, REASON_FALL);
                if (now - lastBeep >= BEEP_EVERY_MS) {
                    lastBeep = now;
                    return Act.BEEP;
                }
                return Act.NONE;
            case ALERTA:
            default:
                if (now >= cooldownUntil) state = State.NORMAL;
                return Act.NONE;
        }
    }

    /** F10 / F12 (no consumidas): cancelan la observacion o la cuenta regresiva. */
    Act onCancelButton(long now) {
        if (state == State.OBSERVANDO || state == State.CONFIRMANDO) {
            state = State.NORMAL;
            return Act.CANCELLED;
        }
        return Act.NONE;
    }

    /**
     * F11 soltada (SOS manual). En CONFIRMANDO dispara el SOS ya, con reason manual_en_caida: quien llama
     * NO debe enviar ademas el SOS normal de F11. En otros estados devuelve NONE (el SOS normal sigue
     * su camino); si estaba OBSERVANDO se abandona (el SOS manual ya cubre la emergencia).
     */
    Act onManualSos(long now) {
        if (state == State.CONFIRMANDO) return alert(now, REASON_MANUAL);
        if (state == State.OBSERVANDO) state = State.NORMAL;
        return Act.NONE;
    }

    private Act enterConfirm(long now, long stillFor) {
        state = State.CONFIRMANDO;
        confirmStart = now;
        lastBeep = now;
        stillS = (int) (stillFor / 1000);
        return Act.CONFIRM;
    }

    private Act alert(long now, String why) {
        state = State.ALERTA;
        reason = why;
        confirmS = (int) ((now - confirmStart) / 1000);
        cooldownUntil = now + COOLDOWN_MS;
        return Act.ALERT;
    }
}
