package ar.exertion.casco;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Sin framework: javac GeoPolicy.java GeoPolicyCheck.java && java -ea GeoPolicyCheck */
public class GeoPolicyCheck {
    static void eq(Object exp, Object got, String what) {
        if (exp == null ? got != null : !exp.equals(got)) {
            throw new AssertionError(what + ": esperado " + exp + " obtenido " + got);
        }
    }

    // ~0.0001 grado de latitud = 11,1 m
    static final double LAT = -38.0, LNG = -68.0;

    public static void main(String[] a) {
        // haversine: 1 grado de latitud ~ 111,2 km
        double d = GeoPolicy.haversineM(0, 0, 1, 0);
        eq(true, Math.abs(d - 111_195) < 300, "haversine 1 grado");
        eq(0.0, GeoPolicy.haversineM(LAT, LNG, LAT, LNG), "haversine cero");

        GeoPolicy.Zone c = GeoPolicy.circle("c", "Pozo", "peligro", "voz_y_sirena", null, LAT, LNG, 30);
        eq(true, GeoPolicy.inside(c, LAT + 0.0001, LNG), "11 m dentro de 30");
        eq(false, GeoPolicy.inside(c, LAT + 0.0004, LNG), "44 m fuera de 30");

        // poligono (rectangulo) y concavo
        GeoPolicy.Zone p = GeoPolicy.polygon("p", "Planta", "permitida", "voz", "Volve a la planta",
                new double[]{LAT, LAT, LAT + 0.001, LAT + 0.001},
                new double[]{LNG, LNG + 0.001, LNG + 0.001, LNG});
        eq(true, GeoPolicy.inside(p, LAT + 0.0005, LNG + 0.0005), "centro dentro");
        eq(false, GeoPolicy.inside(p, LAT + 0.002, LNG + 0.0005), "afuera");
        eq(false, GeoPolicy.inside(p, LAT + 0.0005, LNG - 0.0005), "al costado");
        eq(null, GeoPolicy.polygon("x", "x", "permitida", "voz", null, new double[]{0, 1}, new double[]{0, 1}), "<3 puntos");
        GeoPolicy.Zone u = GeoPolicy.polygon("u", "U", "restringida", "voz", null,   // U: hueco en el medio
                new double[]{0, 0, 10, 10, 3, 3, 10, 10},
                new double[]{0, 10, 10, 7, 7, 3, 3, 0});
        eq(false, GeoPolicy.inside(u, 5, 5), "hueco de la U");
        eq(true, GeoPolicy.inside(u, 1, 5), "base de la U");

        // reglas de alarma y frases
        eq(true, GeoPolicy.alertOnEnter("restringida"), "restringida enter");
        eq(true, GeoPolicy.alertOnEnter("peligro"), "peligro enter");
        eq(true, GeoPolicy.alertOnExit("permitida"), "permitida exit");
        eq(false, GeoPolicy.alertOnEnter("informativa"), "informativa sin alerta");
        eq(true, GeoPolicy.wantsSiren(c) && GeoPolicy.wantsVoice(c), "voz_y_sirena");
        eq(false, GeoPolicy.wantsSiren(p), "voz sola: sin sirena");
        eq("Volve a la planta", GeoPolicy.phrase(p, "exit"), "mensaje de la zona");
        eq(true, GeoPolicy.phrase(c, "enter").contains("zona restringida: Pozo"), "frase por defecto");

        // histeresis de 2 fixes: restringida
        GeoPolicy.Zone r = GeoPolicy.circle("r", "Tanque", "restringida", "voz_y_sirena", null, LAT, LNG, 50);
        List<GeoPolicy.Zone> zs = Arrays.asList(r);
        GeoPolicy.Tracker t = new GeoPolicy.Tracker();
        double inLat = LAT, outLat = LAT + 0.01;
        eq(0, t.update(zs, outLat, LNG).size(), "fuera 1: base sin evento");
        eq(0, t.update(zs, outLat, LNG).size(), "fuera 2: base confirmada, sin evento");
        eq(0, t.update(zs, inLat, LNG).size(), "dentro 1: aun no");
        eq(0, t.update(zs, outLat, LNG).size(), "rebote: se cancela la cuenta");
        eq(0, t.update(zs, inLat, LNG).size(), "dentro 1 otra vez");
        List<GeoPolicy.Event> ev = t.update(zs, inLat, LNG);
        eq(1, ev.size(), "dentro 2: cruza");
        eq("enter", ev.get(0).action, "enter");
        eq(true, ev.get(0).alert, "enter restringida = alerta");
        eq(0, t.update(zs, inLat, LNG).size(), "no repite el evento");

        // alarma local: ya, luego cada 10 s, calla con el boton, vuelve a nacer en otro cruce
        eq(1, t.dueAlarms(1_000).size(), "alarma inmediata");
        eq(0, t.dueAlarms(5_000).size(), "no antes de 10 s");
        eq(1, t.dueAlarms(11_000).size(), "repite a los 10 s");
        t.silenceAll();
        eq(0, t.dueAlarms(30_000).size(), "silenciada");
        t.update(zs, outLat, LNG);
        eq(1, t.update(zs, outLat, LNG).size(), "sale: evento exit");
        eq(false, t.alarming(), "sin alarma tras salir");
        t.update(zs, inLat, LNG);
        t.update(zs, inLat, LNG);
        eq(1, t.dueAlarms(40_000).size(), "nuevo ingreso vuelve a sonar");

        // permitida: alerta al salir; arrancar afuera no alarma (base)
        GeoPolicy.Tracker t2 = new GeoPolicy.Tracker();
        List<GeoPolicy.Zone> pz = Arrays.asList(p);
        double in = LAT + 0.0005, lg = LNG + 0.0005;
        t2.update(pz, in, lg);
        eq(0, t2.update(pz, in, lg).size(), "base dentro de permitida: sin evento");
        t2.update(pz, LAT + 0.01, lg);
        List<GeoPolicy.Event> ex = t2.update(pz, LAT + 0.01, lg);
        eq(1, ex.size(), "salir de permitida");
        eq(true, ex.get(0).alert, "exit permitida = alerta");

        GeoPolicy.Tracker t3 = new GeoPolicy.Tracker();
        t3.update(pz, LAT + 0.01, lg);
        eq(0, t3.update(pz, LAT + 0.01, lg).size(), "arranca afuera de permitida: sin alarma");

        // arrancar DENTRO de una restringida alarma ya (2 fixes)
        GeoPolicy.Tracker t4 = new GeoPolicy.Tracker();
        t4.update(zs, inLat, LNG);
        eq(1, t4.update(zs, inLat, LNG).size(), "arranca dentro de restringida");

        // zona dada de baja: se olvida y cesa la alarma
        t4.update(new ArrayList<GeoPolicy.Zone>(), inLat, LNG);
        eq(false, t4.alarming(), "baja de zona apaga la alarma");

        // informativa: evento sin alerta
        GeoPolicy.Zone inf = GeoPolicy.circle("i", "Comedor", "informativa", "voz", null, LAT, LNG, 50);
        GeoPolicy.Tracker t5 = new GeoPolicy.Tracker();
        List<GeoPolicy.Zone> iz = Arrays.asList(inf);
        t5.update(iz, outLat, LNG);
        t5.update(iz, outLat, LNG);
        t5.update(iz, inLat, LNG);
        List<GeoPolicy.Event> ie = t5.update(iz, inLat, LNG);
        eq(1, ie.size(), "informativa enter");
        eq(false, ie.get(0).alert, "informativa no alarma");
        eq("Zona Comedor", GeoPolicy.phrase(inf, "enter"), "frase informativa");
        // histeresis: oscilar unos metros alrededor del borde (r=50 m) no genera salida; pasar la banda si
        GeoPolicy.Zone hz = GeoPolicy.circle("h", "Borde", "restringida", "voz", null, LAT, LNG, 50);
        List<GeoPolicy.Zone> hs = new ArrayList<GeoPolicy.Zone>();
        hs.add(hz);
        GeoPolicy.Tracker th = new GeoPolicy.Tracker();
        th.update(hs, LAT, LNG);
        eq(1, th.update(hs, LAT, LNG).size(), "base dentro de restringida: alerta");
        th.update(hs, LAT + 0.0005, LNG);
        eq(0, th.update(hs, LAT + 0.0005, LNG).size(), "55 m: dentro de la banda, sin salida");
        th.update(hs, LAT + 0.0007, LNG);
        eq(1, th.update(hs, LAT + 0.0007, LNG).size(), "78 m: sale de verdad");

        System.out.println("GeoPolicyCheck OK");
    }
}
