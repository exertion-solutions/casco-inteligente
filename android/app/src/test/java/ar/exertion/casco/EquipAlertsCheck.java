package ar.exertion.casco;

import java.util.List;

/** Sin framework: ver android/README-VOZ.md (seccion tanda 4). */
public class EquipAlertsCheck {
    static void eq(Object exp, Object got, String what) {
        if (exp == null ? got != null : !exp.equals(got)) {
            throw new AssertionError(what + ": esperado " + exp + " obtenido " + got);
        }
    }

    static String kinds(List<EquipAlerts.Alert> l) {
        StringBuilder s = new StringBuilder();
        for (EquipAlerts.Alert x : l) s.append(x.kind).append(',');
        return s.toString();
    }

    public static void main(String[] a) {
        EquipAlerts e = new EquipAlerts();
        // bateria: baja a 19 -> bat_low; oscilar 19-21 no repite; 25+ rearma
        eq("", kinds(e.update(50, false, 30.0, 3, "LTE", 5000L)), "todo normal");
        eq("bat_low,", kinds(e.update(19, false, null, null, null, null)), "19 % = baja");
        eq("", kinds(e.update(21, false, null, null, null, null)), "21 %: histeresis");
        eq("", kinds(e.update(19, false, null, null, null, null)), "19 % otra vez: mismo episodio");
        eq("bat_crit,", kinds(e.update(9, false, null, null, null, null)), "9 % = critica");
        eq("", kinds(e.update(11, false, null, null, null, null)), "11 %: histeresis critica");
        eq("", kinds(e.update(9, false, null, null, null, null)), "9 % de nuevo: sin repetir");
        eq("", kinds(e.update(30, false, null, null, null, null)), "recuperada");
        eq("bat_low,", kinds(e.update(18, false, null, null, null, null)), "nuevo episodio");
        // cargando: no avisa y limpia
        eq("", kinds(e.update(5, true, null, null, null, null)), "cargando no avisa");
        eq("bat_crit,", kinds(e.update(8, false, null, null, null, null)), "descargando a 8: critica directa");
        EquipAlerts f = new EquipAlerts();
        List<EquipAlerts.Alert> r = f.update(8, false, null, null, null, null);
        eq(1, r.size(), "una sola alerta si arranca en 8 %");
        eq("crit", r.get(0).level, "nivel crit");
        eq(8, r.get(0).value, "valor");

        // temperatura
        e = new EquipAlerts();
        eq("temp,", kinds(e.update(80, false, 46.0, null, null, null)), "46 C");
        eq("", kinds(e.update(80, false, 44.0, null, null, null)), "44 C: histeresis");
        eq("", kinds(e.update(80, false, 47.0, null, null, null)), "47 C: mismo episodio");
        eq("", kinds(e.update(80, false, 40.0, null, null, null)), "enfria");
        eq("temp,", kinds(e.update(80, false, 46.0, null, null, null)), "episodio nuevo");

        // almacenamiento
        e = new EquipAlerts();
        eq("storage,", kinds(e.update(null, null, null, null, null, 900L)), "900 MB");
        eq("", kinds(e.update(null, null, null, null, null, 1100L)), "1100 MB: histeresis");
        eq("", kinds(e.update(null, null, null, null, null, 2000L)), "libera");
        eq("storage,", kinds(e.update(null, null, null, null, null, 1000L)), "episodio nuevo");

        // sin senal: dos lecturas seguidas; una vez; se rearma al volver
        e = new EquipAlerts();
        eq("", kinds(e.update(null, null, null, 0, "NONE", null)), "primera lectura sin senal");
        eq("no_signal,", kinds(e.update(null, null, null, 0, "NONE", null)), "segunda: aviso");
        eq("", kinds(e.update(null, null, null, 0, "NONE", null)), "sin repetir");
        eq("", kinds(e.update(null, null, null, 3, "LTE", null)), "vuelve");
        eq("", kinds(e.update(null, null, null, 0, "NONE", null)), "parpadeo: 1 lectura");
        eq("", kinds(e.update(null, null, null, 2, "LTE", null)), "se recupera antes de avisar");
        eq("", kinds(e.update(null, null, null, null, null, null)), "sin datos: nada");
        System.out.println("EquipAlertsCheck OK");
    }
}
