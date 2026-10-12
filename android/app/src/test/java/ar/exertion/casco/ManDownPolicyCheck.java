package ar.exertion.casco;

import static ar.exertion.casco.ManDownPolicy.Act;
import static ar.exertion.casco.ManDownPolicy.State;

/**
 * Sin framework: javac -d out ManDownPolicy.java OrientationMath.java ManDownPolicyCheck.java && java -ea ...
 * (ver android/README-VOZ.md). Falla con AssertionError si la logica cambia.
 */
public class ManDownPolicyCheck {
    static int n = 0;
    static long t = 100_000;

    static void eq(Object exp, Object got, String what) {
        n++;
        if (!exp.equals(got)) throw new AssertionError(what + ": esperado " + exp + " obtenido " + got);
    }

    /** Avanza k ventanas de 1 s; devuelve la ultima accion distinta de NONE (o NONE). */
    static Act run(ManDownPolicy p, int k, boolean still) {
        Act last = Act.NONE;
        for (int i = 0; i < k; i++) {
            t += 1000;
            Act a = p.update(t, still);
            if (a != Act.NONE) last = a;
        }
        return last;
    }

    /** Avanza ventanas quietas hasta que pase algo distinto de BEEP/NONE o se acaben. */
    static Act runUntil(ManDownPolicy p, int max, boolean still, Act want) {
        for (int i = 0; i < max; i++) {
            t += 1000;
            Act a = p.update(t, still);
            if (a == want) return a;
        }
        return Act.NONE;
    }

    static ManDownPolicy std() { return new ManDownPolicy(true, 15, 10, 0); }

    public static void main(String[] args) {
        // --- caida y recuperacion por movimiento sostenido
        ManDownPolicy p = std();
        eq(State.NORMAL, p.state(), "inicio NORMAL");
        eq(Act.NONE, p.update(t += 1000, true), "quieto en NORMAL no hace nada");
        eq(Act.NONE, p.onImpact(t, 31f), "impacto: sin accion inmediata");
        eq(State.OBSERVANDO, p.state(), "impacto -> OBSERVANDO");
        eq(Act.NONE, run(p, 2, false), "2 s de movimiento no alcanzan");
        eq(State.OBSERVANDO, p.state(), "sigue OBSERVANDO");
        eq(Act.RECOVERED, run(p, 1, false), "3 s de movimiento -> recuperado");
        eq(State.NORMAL, p.state(), "vuelve a NORMAL sin SOS");

        // --- quietud corta rompe la cuenta de quietud
        p = std();
        p.onImpact(t, 28f);
        eq(Act.NONE, run(p, 14, true), "14 s quieto: aun observando");
        eq(Act.NONE, run(p, 1, false), "un movimiento corto no recupera");
        eq(Act.NONE, run(p, 14, true), "la quietud reinicia: 14 s");
        eq(State.OBSERVANDO, p.state(), "sigue OBSERVANDO tras quietud interrumpida");
        eq(Act.CONFIRM, run(p, 1, true), "15 s continuos -> CONFIRMANDO");
        eq(State.CONFIRMANDO, p.state(), "estado CONFIRMANDO");
        eq(15, p.stillSeconds(), "still_s = 15");

        // --- cancelacion por boton (F10/F12) en CONFIRMANDO
        eq(Act.CANCELLED, p.onCancelButton(t), "boton cancela");
        eq(State.NORMAL, p.state(), "cancelado -> NORMAL");
        eq(Act.NONE, p.onCancelButton(t), "boton en NORMAL no hace nada");

        // --- cancelacion por boton ya durante OBSERVANDO
        p.onImpact(t, 30f);
        eq(Act.CANCELLED, p.onCancelButton(t), "boton cancela observando");
        eq(State.NORMAL, p.state(), "NORMAL tras cancelar observando");

        // --- cancelacion por movimiento sostenido en CONFIRMANDO
        p = std();
        p.onImpact(t, 30f);
        runUntil(p, 20, true, Act.CONFIRM);
        eq(State.CONFIRMANDO, p.state(), "CONFIRMANDO para cancelar por movimiento");
        eq(Act.NONE, run(p, 2, false), "2 s de movimiento no cancelan");
        eq(Act.CANCELLED, run(p, 1, false), "3 s de movimiento cancelan");
        eq(State.NORMAL, p.state(), "NORMAL por movimiento");

        // --- caida sin cancelar -> SOS hombre_caido, con beeps cada 3 s
        p = std();
        p.onImpact(t, 33.5f);
        runUntil(p, 20, true, Act.CONFIRM);
        int beeps = 0;
        Act a = Act.NONE;
        for (int i = 0; i < 12 && a != Act.ALERT; i++) {
            t += 1000;
            a = p.update(t, true);
            if (a == Act.BEEP) beeps++;
        }
        eq(Act.ALERT, a, "sin cancelar -> ALERT");
        eq(3, beeps, "3 beeps (3, 6 y 9 s) antes del SOS");
        eq(State.ALERTA, p.state(), "estado ALERTA");
        eq("hombre_caido", p.reason(), "reason hombre_caido");
        eq(10, p.confirmSeconds(), "confirm_s = 10");
        eq(33.5f, p.impact(), "impact = pico");
        eq("impacto", p.trigger(), "trigger impacto");

        // --- cooldown: durante 60 s un impacto no reabre nada
        eq(Act.NONE, p.onImpact(t + 1000, 40f), "impacto en ALERTA ignorado");
        eq(State.ALERTA, p.state(), "sigue ALERTA");
        eq(Act.NONE, p.onCancelButton(t), "boton en ALERTA no hace nada");
        run(p, 30, true);
        eq(State.ALERTA, p.state(), "aun en cooldown a los 30 s");
        run(p, 31, true);
        eq(State.NORMAL, p.state(), "cooldown cumplido -> NORMAL");
        eq(Act.NONE, p.onImpact(t, 29f), "impacto nuevo");
        eq(State.OBSERVANDO, p.state(), "tras cooldown se vuelve a observar");

        // --- F11 durante CONFIRMANDO: SOS inmediato manual_en_caida
        p = std();
        p.onImpact(t, 30f);
        runUntil(p, 20, true, Act.CONFIRM);
        run(p, 4, true);
        eq(Act.ALERT, p.onManualSos(t), "F11 en CONFIRMANDO -> ALERT inmediato");
        eq("manual_en_caida", p.reason(), "reason manual_en_caida");
        eq(State.ALERTA, p.state(), "ALERTA por F11");
        eq(Act.NONE, p.onManualSos(t), "segundo F11: SOS normal, no de la politica");

        // --- F11 observando: abandona sin alerta propia
        p = std();
        p.onImpact(t, 30f);
        eq(Act.NONE, p.onManualSos(t), "F11 observando: NONE");
        eq(State.NORMAL, p.state(), "F11 observando -> NORMAL");
        eq(Act.NONE, p.onManualSos(t), "F11 en NORMAL: NONE");

        // --- configuracion deshabilitada
        ManDownPolicy off = new ManDownPolicy(false, 15, 10, 0);
        eq(Act.NONE, off.onImpact(t, 50f), "deshabilitado: impacto ignorado");
        eq(State.NORMAL, off.state(), "deshabilitado: NORMAL");
        eq(Act.NONE, run(off, 40, true), "deshabilitado: nada tras 40 s quieto");

        // --- tiempos de config distintos (clamp se hace en Config)
        ManDownPolicy fast = new ManDownPolicy(true, 5, 5, 0);
        fast.onImpact(t, 30f);
        eq(Act.CONFIRM, run(fast, 5, true), "still 5 s -> CONFIRM");
        eq(Act.ALERT, runUntil(fast, 10, true, Act.ALERT), "confirm 5 s -> ALERT");
        eq(5, fast.confirmSeconds(), "confirm_s = 5");

        // --- inmovilidad prolongada (opcional): 60 s quieto tras 20 s de uso
        ManDownPolicy ina = new ManDownPolicy(true, 15, 10, 60);
        run(ina, 59, true);
        eq(State.NORMAL, ina.state(), "sin uso previo no dispara (casco en la mesa)");
        run(ina, 20, false);
        eq(Act.NONE, run(ina, 59, true), "59 s quieto: nada");
        eq(Act.CONFIRM, run(ina, 1, true), "60 s quieto tras uso -> CONFIRMANDO");
        eq("inactividad", ina.trigger(), "trigger inactividad");
        eq(Act.ALERT, runUntil(ina, 15, true, Act.ALERT), "inactividad sin cancelar -> ALERT");
        eq("hombre_caido", ina.reason(), "reason hombre_caido tambien por inactividad");
        run(ina, 70, true); // fin del cooldown y mas quietud
        eq(State.NORMAL, ina.state(), "vuelve a NORMAL");
        eq(Act.NONE, run(ina, 120, true), "no re-dispara sin uso nuevo");

        // --- inmovilidad al tope (600 s): dispara justo al limite de "actividad reciente"
        ManDownPolicy old = new ManDownPolicy(true, 15, 10, 600);
        run(old, 20, false);
        eq(Act.NONE, run(old, 590, true), "590 s quieto: nada aun");
        eq(Act.CONFIRM, run(old, 10, true), "600 s quieto -> CONFIRMANDO");

        // --- OrientationMath
        eq(0, OrientationMath.angle(0f, 9.8f, 0f), "vertical natural = 0");
        eq(-1, OrientationMath.angle(0.3f, 0.2f, 9.8f), "plano = -1");
        eq(90, OrientationMath.angle(-9.8f, 0f, 0f), "lado -> 90");
        eq(270, OrientationMath.angle(9.8f, 0f, 0f), "lado opuesto -> 270");
        eq(180, OrientationMath.angle(0f, -9.8f, 0f), "invertido -> 180");
        eq(0, OrientationMath.quantize(0, 40), "40 grados: histeresis, sin cambio");
        eq(0, OrientationMath.quantize(0, 59), "59 grados: sin cambio");
        eq(90, OrientationMath.quantize(0, 70), "70 grados: cambia a 90");
        eq(90, OrientationMath.quantize(90, 40), "vuelta a 40: se queda en 90");
        eq(0, OrientationMath.quantize(270, 350), "270 -> 0 por cruce de 360");
        eq(90, OrientationMath.quantize(90, -1), "plano: sin cambio");
        eq(0, OrientationMath.rot(90, 90), "rot = sens - ori");
        eq(90, OrientationMath.rot(90, 0), "rot ori 0");
        eq(270, OrientationMath.rot(90, 180), "rot ori 180");
        eq(true, OrientationMath.shouldPublish(true, 1000, 900, 0), "publica si cambio");
        eq(false, OrientationMath.shouldPublish(false, 10_000, 5_000, 0), "no publica sin cambio < 30 s");
        eq(true, OrientationMath.shouldPublish(false, 40_000, 5_000, 0), "publica a los 30 s");
        eq(false, OrientationMath.shouldPublish(true, 40_000, 5_000, 6), "tope 6/min");

        // bug 15: F11 dispara SOS; la frase nunca dice "cualquier boton" y nombra camara/microfono
        String ph = ManDownPolicy.CANCEL_PHRASE;
        eq(false, ph.contains("cualquier"), "sin 'cualquier boton'");
        eq(true, ph.contains("cámara") && ph.contains("micrófono"), "indica F10/F12");
        System.out.println("ManDownPolicyCheck OK (" + n + " aserciones)");
    }
}
