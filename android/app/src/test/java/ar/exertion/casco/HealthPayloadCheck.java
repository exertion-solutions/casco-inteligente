package ar.exertion.casco;

import java.util.Map;

/**
 * Sin framework: javac HealthPayload.java HealthPayloadCheck.java && java -ea ar.exertion.casco.HealthPayloadCheck
 */
public class HealthPayloadCheck {
    static void eq(Object exp, Object got, String what) {
        if (exp == null ? got != null : !exp.equals(got)) {
            throw new AssertionError(what + ": esperado " + exp + " obtenido " + got);
        }
    }

    public static void main(String[] a) {
        // todo presente: orden del protocolo
        Map<String, Object> m = HealthPayload.build(87, true, 31.5, -98, 3, "LTE", 1, "0.3.0", 20400L, 5400L);
        eq("[bat, chg, temp_c, sig, lvl, net, sim, app, free_mb, up_s]", m.keySet().toString(), "claves");
        eq(87, m.get("bat"), "bat");
        eq(31.5, m.get("temp_c"), "temp");
        // todo nulo: payload vacio, sin romper
        eq(0, HealthPayload.build(null, null, null, null, null, null, null, null, null, null).size(), "vacio");
        // parcial: solo lo conocido
        m = HealthPayload.build(50, false, null, null, null, "", 0, null, null, 12L);
        eq("[bat, chg, sim, up_s]", m.keySet().toString(), "parcial");
        eq(0, m.get("sim"), "sim 0 se conserva (no es null)");
        // conversiones
        eq(87, HealthPayload.batteryPct(87, 100), "bat pct");
        eq(50, HealthPayload.batteryPct(1, 2), "bat escala 2");
        eq(null, HealthPayload.batteryPct(-1, 100), "bat sin nivel");
        eq(null, HealthPayload.batteryPct(10, 0), "bat sin escala");
        eq(31.5, HealthPayload.tempC(315), "temp decimas");
        eq(0.0, HealthPayload.tempC(0), "temp 0 valida");
        eq(null, HealthPayload.tempC(Integer.MIN_VALUE), "temp ausente");
        eq(null, HealthPayload.tempC(9999), "temp absurda");
        eq(3, HealthPayload.level(3), "lvl");
        eq(null, HealthPayload.level(-1), "lvl -1");
        eq(null, HealthPayload.level(7), "lvl 7");
        eq(-98, HealthPayload.dbm(-98), "dbm");
        eq(null, HealthPayload.dbm(Integer.MAX_VALUE), "dbm no disponible");
        eq(null, HealthPayload.dbm(0), "dbm 0");
        eq(20400L, HealthPayload.freeMb(20400L * 1024 * 1024), "free");
        eq(null, HealthPayload.freeMb(-1), "free neg");
        eq(5400L, HealthPayload.upSeconds(5_400_999L), "up");
        eq("LTE", HealthPayload.netName(13), "net lte");
        eq("3G", HealthPayload.netName(15), "net hspa+");
        eq("2G", HealthPayload.netName(2), "net edge");
        eq(null, HealthPayload.netName(0), "net desconocida");
        // merge: la orientacion manda, la salud rellena
        Map<String, Object> base = new java.util.LinkedHashMap<>();
        base.put("rot", 90);
        base.put("bat", 1);
        Map<String, Object> mg = HealthPayload.merge(base,
                HealthPayload.build(87, null, null, null, null, null, null, null, null, 5L));
        eq(1, mg.get("bat"), "merge no pisa");
        eq(5L, mg.get("up_s"), "merge agrega");
        eq(90, mg.get("rot"), "merge conserva rot");
        System.out.println("HealthPayloadCheck OK");
    }
}
