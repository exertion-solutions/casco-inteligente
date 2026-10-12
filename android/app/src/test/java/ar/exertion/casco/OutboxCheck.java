package ar.exertion.casco;

import java.io.File;
import java.nio.file.Files;

/**
 * Sin framework: javac AgentPolicy.java Outbox.java OutboxCheck.java && java -ea OutboxCheck
 * Verifica que SOS/caida sobreviven a un "reinicio" (nueva instancia que lee el archivo) y los topes.
 */
public class OutboxCheck {
    static void eq(Object exp, Object got, String what) {
        if (exp == null ? got != null : !exp.equals(got)) {
            throw new AssertionError(what + ": esperado " + exp + " obtenido " + got);
        }
    }

    public static void main(String[] a) throws Exception {
        File dir = Files.createTempDirectory("outbox").toFile();
        File f = new File(dir, "outbox.jsonl");
        Outbox o = new Outbox(f);

        Outbox.Entry sos = o.newEntry("sos", 1_000L);
        sos.key = "KEY_F11";
        sos.pressMs = 1200;
        sos.battery = 77;
        sos.lat = -38.95;
        sos.lng = -68.06;
        sos.payload = "{\"reason\":\"a\tb\\c\",\"t\":1000}"; // TAB y barra: deben sobrevivir
        o.add(sos);
        Outbox.Entry ph = o.newEntry("photo", 2_000L);
        ph.path = "4132/photo/1_x.jpg";
        o.add(ph);
        eq(true, o.hasCritical(), "hay critico");

        // "reinicio del servicio": otra instancia lee el archivo
        Outbox o2 = new Outbox(f);
        o2.load();
        eq(2, o2.size(), "sobrevive al reinicio");
        Outbox.Entry r = o2.next(true);
        eq("sos", r.type, "tipo");
        eq("KEY_F11", r.key, "key");
        eq(1200, r.pressMs, "press_ms");
        eq(77, r.battery, "bateria");
        eq(true, r.hasPos(), "posicion");
        eq(-38.95, r.lat, "lat");
        eq(1_000L, r.t, "t original");
        eq("{\"reason\":\"a\tb\\c\",\"t\":1000}", r.payload, "payload intacto");
        eq("4132/photo/1_x.jpg", o2.next(false).path, "photo aparte");
        eq(null, o2.next(false).key, "key nula");

        // sin posicion
        Outbox.Entry nopos = o2.newEntry("fall", 3_000L);
        o2.add(nopos);
        eq(false, o2.next(true) == null, "next critico");
        o2.done(r);
        eq("fall", o2.next(true).type, "orden: sigue la caida");

        // rechazo del servidor: se reintenta sin posicion ni payload
        Outbox.Entry fall = o2.next(true);
        fall.lat = 1;
        fall.lng = 2;
        fall.payload = "{}";
        o2.strip(fall);
        eq(false, fall.hasPos(), "strip sin pos");
        eq(null, fall.payload, "strip sin payload");
        eq(true, fall.stripped, "strip marcado");

        // enviado: sale del archivo
        o2.done(fall);
        eq(false, o2.hasCritical(), "sin criticos");
        Outbox o3 = new Outbox(f);
        o3.load();
        eq(1, o3.size(), "solo queda la foto");

        // topes: 200 location como maximo; los criticos nunca se descartan
        Outbox big = new Outbox(new File(dir, "big.jsonl"));
        Outbox.Entry keep = big.newEntry("sos", 1L);
        big.add(keep);
        for (int i = 0; i < 300; i++) big.add(big.newEntry("location", 10L + i));
        eq(Outbox.MAX_LOCATION + 1, big.size(), "tope location");
        eq("sos", big.next(true).type, "el SOS sigue");
        eq(110L, big.next(false).t, "se perdieron las mas viejas");
        for (int i = 0; i < 600; i++) big.add(big.newEntry("photo", 5000L + i));
        eq(Outbox.MAX_TOTAL, big.size(), "tope total");
        eq(true, big.hasCritical(), "SOS sobrevive al tope total");

        // archivo con basura: se ignora la linea, no rompe
        Files.write(new File(dir, "bad.jsonl").toPath(), "basura\n\n".getBytes("UTF-8"));
        Outbox bad = new Outbox(new File(dir, "bad.jsonl"));
        bad.load();
        eq(0, bad.size(), "basura ignorada");
        System.out.println("OutboxCheck OK");
    }
}
