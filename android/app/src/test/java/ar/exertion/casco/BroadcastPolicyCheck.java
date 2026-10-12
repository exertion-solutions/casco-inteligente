package ar.exertion.casco;

import java.util.Arrays;

/**
 * Sin framework: javac BroadcastPolicy.java BroadcastPolicyCheck.java && java -ea ar.exertion.casco.BroadcastPolicyCheck
 */
public class BroadcastPolicyCheck {
    static void eq(Object exp, Object got, String what) {
        if (exp == null ? got != null : !exp.equals(got)) {
            throw new AssertionError(what + ": esperado " + exp + " obtenido " + got);
        }
    }

    public static void main(String[] a) {
        String evac = "Atención. Evacuación. ";
        // frases
        eq(evac + "Diríjase al punto de reunión", BroadcastPolicy.phrase("evacuacion", ""), "evac sin texto");
        eq(evac + "Diríjase al punto de reunión", BroadcastPolicy.phrase("evacuacion", null), "evac null");
        eq(evac + "Salida norte", BroadcastPolicy.phrase("evacuacion", " Salida norte "), "evac con texto");
        eq("Mensaje del supervisor: Parar la tarea", BroadcastPolicy.phrase("mensaje", "Parar la tarea"), "mensaje");
        eq(null, BroadcastPolicy.phrase("mensaje", "  "), "mensaje vacio se ignora");
        eq(null, BroadcastPolicy.phrase("otra", "x"), "kind desconocido");
        // repeat
        eq(1, BroadcastPolicy.clampRepeat(0), "repeat min");
        eq(5, BroadcastPolicy.clampRepeat(99), "repeat max");
        eq(3, BroadcastPolicy.clampRepeat(3), "repeat 3");
        // destinatarios
        eq(true, BroadcastPolicy.targets(null, "4132"), "null = todos");
        eq(true, BroadcastPolicy.targets(Arrays.asList("1", "4132"), "4132"), "incluido");
        eq(false, BroadcastPolicy.targets(Arrays.asList("1", "2"), "4132"), "no incluido");
        // dedupe: primera vez true, repetido false, vacio false
        BroadcastPolicy.Seen s = new BroadcastPolicy.Seen();
        eq(true, s.add("a1"), "nuevo");
        eq(false, s.add("a1"), "repetido");
        eq(false, s.add(""), "vacio");
        eq(false, s.add(null), "null");
        // tope 50: el mas viejo sale y vuelve a contar como nuevo
        for (int i = 0; i < 60; i++) s.add("id-" + i);
        eq(50, s.size(), "tope 50");
        eq(true, s.add("a1"), "a1 ya salio de la ventana");
        eq(false, s.add("id-59"), "reciente sigue");
        // persistencia ida y vuelta + archivo corrupto
        BroadcastPolicy.Seen t = new BroadcastPolicy.Seen();
        t.load(s.serialize() + "basura con espacios\n\n");
        eq(s.size(), t.size(), "round trip");
        eq(false, t.add("id-59"), "persistido");
        // ventana de llamada: espera y tope de 60 s
        eq(true, BroadcastPolicy.canStart(false, 0), "sin llamada");
        eq(false, BroadcastPolicy.canStart(true, 0), "llamada: esperar");
        eq(false, BroadcastPolicy.canStart(true, 59_000), "llamada 59 s");
        eq(true, BroadcastPolicy.canStart(true, 60_000), "llamada 60 s: arrancar igual");
        // volumen
        eq(7, BroadcastPolicy.volumeIndex(100, 7), "vol 100");
        eq(0, BroadcastPolicy.volumeIndex(0, 7), "vol 0");
        eq(4, BroadcastPolicy.volumeIndex(50, 7), "vol 50");
        eq(7, BroadcastPolicy.volumeIndex(500, 7), "vol acotado");
        // ISO en UTC con Z (apto para query, sin signo mas)
        eq("1970-01-01T00:00:00Z", BroadcastPolicy.isoUtc(0), "iso");
        // sirena: largo y amplitud
        short[] pcm = BroadcastPolicy.siren(16_000, 1000);
        eq(16_000, pcm.length, "sirena largo");
        int max = 0;
        for (short v : pcm) max = Math.max(max, Math.abs(v));
        if (max < 20_000 || max > 32_767) throw new AssertionError("amplitud " + max);
        System.out.println("BroadcastPolicyCheck OK");
    }
}
