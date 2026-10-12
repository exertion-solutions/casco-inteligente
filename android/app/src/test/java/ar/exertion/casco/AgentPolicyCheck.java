package ar.exertion.casco;

import java.util.Arrays;

/**
 * Sin framework: javac AgentPolicy.java AgentPolicyCheck.java && java -ea AgentPolicyCheck
 * Falla con AssertionError si la logica cambia.
 */
public class AgentPolicyCheck {
    static void eq(Object exp, Object got, String what) {
        if (exp == null ? got != null : !exp.equals(got)) {
            throw new AssertionError(what + ": esperado " + exp + " obtenido " + got);
        }
    }

    public static void main(String[] a) {
        // SOS/caida: criticos, jamas se descartan; solo el SOS anuncia
        eq(true, AgentPolicy.critical("sos"), "sos critico");
        eq(true, AgentPolicy.critical("fall"), "fall critico");
        eq(false, AgentPolicy.critical("photo"), "photo no critico");
        eq(false, AgentPolicy.critical("location"), "location no critico");
        eq(true, AgentPolicy.announces("sos"), "sos anuncia");
        eq(false, AgentPolicy.announces("fall"), "fall no anuncia 'enviada'");

        // backoff critico: 2,4,8,16,30 s y se queda en 30 s (no se rinde)
        eq(2_000L, AgentPolicy.retryMs(true, 1), "crit 1");
        eq(8_000L, AgentPolicy.retryMs(true, 3), "crit 3");
        eq(30_000L, AgentPolicy.retryMs(true, 5), "crit tope");
        eq(30_000L, AgentPolicy.retryMs(true, 5000), "crit muchos intentos");
        eq(10_000L, AgentPolicy.retryMs(false, 1), "no crit 1");
        eq(300_000L, AgentPolicy.retryMs(false, 99), "no crit tope 5 min");

        // subida de medios: nunca se rinde, tope 10 min
        eq(30_000L, AgentPolicy.uploadRetryMs(0), "upload 0");
        eq(120_000L, AgentPolicy.uploadRetryMs(2), "upload 2");
        eq(600_000L, AgentPolicy.uploadRetryMs(5), "upload tope");
        eq(600_000L, AgentPolicy.uploadRetryMs(500), "upload muchos");

        // spool: borra los mas viejos hasta entrar en el tope
        eq(0, AgentPolicy.dropOldest(new long[]{10, 10, 10}, 30), "spool justo");
        eq(1, AgentPolicy.dropOldest(new long[]{10, 10, 10}, 25), "spool -1");
        eq(2, AgentPolicy.dropOldest(new long[]{10, 10, 10}, 10), "spool -2");
        eq(3, AgentPolicy.dropOldest(new long[]{50, 10, 10}, 0), "spool todo");
        eq(1, AgentPolicy.dropOldest(new long[]{500, 10, 10}, 100), "spool uno enorme");

        // ubicacion: 60 s normal, 30 s con alerta; filtro de precision y de fix repetido/viejo
        eq(60_000L, AgentPolicy.locationIntervalMs(false), "loc normal");
        eq(30_000L, AgentPolicy.locationIntervalMs(true), "loc alerta");
        eq(true, AgentPolicy.accuracyOk(true, 50f), "acc 50 ok");
        eq(false, AgentPolicy.accuracyOk(true, 50.1f), "acc 50.1 no");
        eq(false, AgentPolicy.accuracyOk(false, 5f), "sin acc declarada no");
        eq(false, AgentPolicy.newFix(1000L, 1000L), "mismo fix");
        eq(true, AgentPolicy.newFix(2000L, 1000L), "fix nuevo");
        eq(true, AgentPolicy.fixFresh(120), "fix 120 s");
        eq(false, AgentPolicy.fixFresh(121), "fix 121 s viejo");
        eq(true, AgentPolicy.staleDue(300_000L, 0), "stale a los 5 min");
        eq(false, AgentPolicy.staleDue(299_999L, 0), "stale antes de 5 min");
        eq(true, AgentPolicy.staleDue(0, -AgentPolicy.STALE_REPUBLISH_MS), "stale la primera vez");

        // llamadas: offer con hangup del mismo call_id se ignora
        eq("[c1]", AgentPolicy.hungUpCalls(Arrays.asList("c1", "c1", "c2"),
                Arrays.asList("offer", "hangup", "offer")).toString(), "offer colgada");
        eq(0, AgentPolicy.hungUpCalls(Arrays.asList("c1"), Arrays.asList("offer")).size(), "sin hangup");

        // logs sin secretos
        String jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.firmaFirma123";
        String r = AgentPolicy.redact("RTMP fallo rtmp://h/live/1?user=device&pass=" + jwt + "&x=1 y " + jwt);
        eq(false, r.contains("eyJ"), "sin jwt");
        eq(true, r.contains("pass=***&x=1"), "pass redactado");
        eq("", AgentPolicy.redact(null), "null");
        // 0.6.0: press_ms se recorta (nunca se descarta el SOS), solo mime admitidos por el bucket
        eq(600_000, AgentPolicy.clampPressMs(900_000), "press recortado");
        eq(0, AgentPolicy.clampPressMs(-5), "press negativo");
        eq(1234, AgentPolicy.clampPressMs(1234), "press normal");
        eq("image/jpeg", AgentPolicy.mimeFor("A.JPG"), "jpg");
        eq("image/png", AgentPolicy.mimeFor("a.png"), "png");
        eq("video/mp4", AgentPolicy.mimeFor("v.mp4"), "mp4");
        eq(null, AgentPolicy.mimeFor("v.3gp"), "3gp no admitido");
        eq(null, AgentPolicy.mimeFor("v.mkv"), "mkv no admitido");
        eq(true, AgentPolicy.uploadRejected(415), "415 definitivo");
        eq(true, AgentPolicy.uploadRejected(400), "400 definitivo");
        eq(false, AgentPolicy.uploadRejected(500), "500 reintenta");
        eq(false, AgentPolicy.uploadRejected(403), "403 reintenta");
        eq("confirmando", AgentPolicy.countdownLabel(true, -1), "cuenta en curso");
        eq("cancelado", AgentPolicy.countdownLabel(false, 60_000), "cancelado reciente");
        eq(null, AgentPolicy.countdownLabel(false, 7 * 60_000), "cancelado viejo se omite");
        eq(null, AgentPolicy.countdownLabel(false, -1), "nunca cancelado");
        eq(60_000L, AgentPolicy.geoRefreshMs(0), "geo 60 s");
        eq(120_000L, AgentPolicy.geoRefreshMs(1), "geo backoff 1");
        eq(300_000L, AgentPolicy.geoRefreshMs(50), "geo tope 5 min");
        System.out.println("AgentPolicyCheck OK");
    }
}
