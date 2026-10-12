package ar.exertion.casco;

/**
 * Casco no puesto e inmovilidad (docs/PROTOCOLO-COMANDOS.md seccion 4). PURA (sin Android, un solo hilo):
 * se alimenta con la ventana de quietud de 1 s de FallDetector y la postura.
 *
 *  - Casco apoyado ("resting": plano o inmovil absoluto y, si hay proximidad, sin nada cerca) y quieto notWornS s
 *    -> NOT_WORN una vez por episodio.
 *  - Casco puesto (no apoyado) y quieto: a los 60 s PROMPT (aviso de voz) y a los inactivityS s INACTIVE
 *    (apagado con inactivityS = 0: ni aviso ni evento). Cualquier movimiento o boton antes del evento lo cancela.
 *  - Un episodio termina con 3 s de movimiento sostenido (ni la vibracion de una mesa lo reabre) o un boton.
 */
final class WearMonitor {
    enum Act { NONE, PROMPT, NOT_WORN, INACTIVE }

    static final long PROMPT_MS = 60_000L;
    static final long MOVE_END_MS = 3_000L;
    static final long WINDOW_MS = 1_000L;

    private long stillSince = -1, moveSince = -1;
    private boolean prompted, notWornFired, inactiveFired;
    private int stillS;

    /** Segundos de quietud al momento del ultimo evento (para el payload). */
    int stillSeconds() { return stillS; }

    /**
     * Postura de "apoyado": plano o inmovil absoluto (ruido de sensor: una cabeza viva siempre se mueve un
     * poco), y si el sensor de proximidad existe (near != null) nada cerca.
     */
    static boolean resting(boolean flat, boolean deadStill, Boolean proximityNear) {
        return (flat || deadStill) && (proximityNear == null || !proximityNear);
    }

    /**
     * Una ventana de 1 s que termina en {@code now}. {@code suspended}: hombre caido en curso (sin avisos).
     * notWornS <= 0 desactiva not_worn; inactivityS <= 0 desactiva el aviso y `inactive`.
     */
    Act onWindow(long now, boolean still, boolean resting, int notWornS, int inactivityS, boolean suspended) {
        if (suspended) {
            reset();
            return Act.NONE;
        }
        if (!still) {
            stillSince = -1;
            prompted = false;
            if (moveSince < 0) moveSince = now - WINDOW_MS;
            if (now - moveSince >= MOVE_END_MS) { // movimiento sostenido: nuevo episodio posible
                notWornFired = false;
                inactiveFired = false;
            }
            return Act.NONE;
        }
        moveSince = -1;
        if (stillSince < 0) stillSince = now - WINDOW_MS;
        long stillFor = now - stillSince;
        if (resting) {
            prompted = false;
            if (notWornS > 0 && !notWornFired && stillFor >= notWornS * 1000L) {
                notWornFired = true;
                stillS = (int) (stillFor / 1000);
                return Act.NOT_WORN;
            }
            return Act.NONE;
        }
        if (inactivityS <= 0) return Act.NONE;
        if (!inactiveFired && stillFor >= inactivityS * 1000L) {
            inactiveFired = true;
            stillS = (int) (stillFor / 1000);
            return Act.INACTIVE;
        }
        if (!prompted && !inactiveFired && stillFor >= PROMPT_MS) {
            prompted = true;
            return Act.PROMPT;
        }
        return Act.NONE;
    }

    /** Boton (F10/F12): el operario esta; se reinicia todo. */
    void onButton() { reset(); }

    private void reset() {
        stillSince = moveSince = -1;
        prompted = notWornFired = inactiveFired = false;
    }
}
