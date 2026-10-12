package ar.exertion.casco;

import static ar.exertion.casco.StreamPolicy.Act;
import static ar.exertion.casco.StreamPolicy.SRC_LOCAL;
import static ar.exertion.casco.StreamPolicy.SRC_NONE;
import static ar.exertion.casco.StreamPolicy.SRC_REMOTE;

/**
 * Sin framework: javac StreamPolicy.java StreamPolicyCheck.java && java -ea StreamPolicyCheck
 * (ver android/README-VIDEO.md). Falla con AssertionError si la logica cambia.
 */
public class StreamPolicyCheck {
    static void eq(Object exp, Object got, String what) {
        if (!exp.equals(got)) throw new AssertionError(what + ": esperado " + exp + " obtenido " + got);
    }

    public static void main(String[] a) {
        // comando start nuevo, sin transmitir -> arranca
        eq(Act.START, StreamPolicy.decide("c1", "start", null, SRC_NONE), "start nuevo");
        // mismo start otra vez (ya procesado) -> nada
        eq(Act.NONE, StreamPolicy.decide("c1", "start", "c1", SRC_REMOTE), "start repetido");
        // start ya procesado y la transmision termino por tope/fallo -> NO reiniciar
        eq(Act.NONE, StreamPolicy.decide("c1", "start", "c1", SRC_NONE), "no reiniciar tras tope");
        // start nuevo con SOS local en curso -> promueve
        eq(Act.START, StreamPolicy.decide("c2", "start", "c1", SRC_LOCAL), "promover local");
        // start nuevo con remoto en curso -> nada (el tope sigue corriendo)
        eq(Act.NONE, StreamPolicy.decide("c2", "start", "c1", SRC_REMOTE), "start durante remoto");
        // stop nuevo transmitiendo (remoto o local) -> para
        eq(Act.STOP, StreamPolicy.decide("c3", "stop", "c2", SRC_REMOTE), "stop remoto");
        eq(Act.STOP, StreamPolicy.decide("c3", "stop", "c2", SRC_LOCAL), "stop local");
        // stop viejo (ya visto) no mata un SOS local posterior
        eq(Act.NONE, StreamPolicy.decide("c3", "stop", "c3", SRC_LOCAL), "stop viejo vs SOS");
        // stop sin transmitir -> nada
        eq(Act.NONE, StreamPolicy.decide("c3", "stop", "c2", SRC_NONE), "stop en reposo");
        // vencido (RLS ya no devuelve fila): corta remoto, no toca el SOS local ni el reposo
        eq(Act.STOP, StreamPolicy.decide(null, null, "c1", SRC_REMOTE), "vencido remoto");
        eq(Act.NONE, StreamPolicy.decide(null, null, "c1", SRC_LOCAL), "vencido no toca SOS");
        eq(Act.NONE, StreamPolicy.decide(null, null, null, SRC_NONE), "sin comandos");
        // accion desconocida
        eq(Act.NONE, StreamPolicy.decide("c9", "pause", null, SRC_NONE), "accion rara");
        // backoff
        eq(3_000L, StreamPolicy.pollDelayMs(0), "poll normal");
        eq(6_000L, StreamPolicy.pollDelayMs(1), "poll 1");
        eq(12_000L, StreamPolicy.pollDelayMs(2), "poll 2");
        eq(24_000L, StreamPolicy.pollDelayMs(3), "poll 3");
        eq(30_000L, StreamPolicy.pollDelayMs(4), "poll tope 30 s");
        eq(30_000L, StreamPolicy.pollDelayMs(99), "poll tope 30 s (muchos)");
        eq(2_000L, StreamPolicy.retryDelayMs(1), "retry 1");
        eq(32_000L, StreamPolicy.retryDelayMs(5), "retry 5");
        // audio del casco: ruta y condiciones
        eq("live", StreamPolicy.ingestPath(false, "live"), "sin audio -> live");
        eq("ingest", StreamPolicy.ingestPath(true, "live"), "con audio -> ingest");
        eq("ingest", StreamPolicy.ingestPath(true, null), "con audio, sin config -> ingest");
        eq("otra", StreamPolicy.ingestPath(true, "otra"), "ruta configurada se respeta");
        eq("otra", StreamPolicy.ingestPath(false, "otra"), "ruta configurada sin audio");
        eq(true, StreamPolicy.wantAudio(true, true, false), "audio ok");
        eq(false, StreamPolicy.wantAudio(false, true, false), "stream_audio=false: nunca mic");
        eq(false, StreamPolicy.wantAudio(true, false, false), "sin RECORD_AUDIO: solo video");
        eq(false, StreamPolicy.wantAudio(true, true, true), "audio fallo antes: solo video");
        eq(true, StreamPolicy.audioMuted(true), "silencia en llamada");
        eq(false, StreamPolicy.audioMuted(false), "reanuda al colgar");
        System.out.println("StreamPolicyCheck OK");
    }
}
