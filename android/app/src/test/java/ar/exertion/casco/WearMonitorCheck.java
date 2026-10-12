package ar.exertion.casco;

/** Sin framework: ver android/README-VOZ.md (seccion tanda 4). */
public class WearMonitorCheck {
    static void eq(Object exp, Object got, String what) {
        if (exp == null ? got != null : !exp.equals(got)) {
            throw new AssertionError(what + ": esperado " + exp + " obtenido " + got);
        }
    }

    static long t;

    /** Alimenta n ventanas de 1 s y devuelve la primera accion distinta de NONE (o NONE). */
    static WearMonitor.Act run(WearMonitor w, int n, boolean still, boolean resting, int nw, int in, boolean susp) {
        WearMonitor.Act first = WearMonitor.Act.NONE;
        for (int i = 0; i < n; i++) {
            t += 1000;
            WearMonitor.Act r = w.onWindow(t, still, resting, nw, in, susp);
            if (first == WearMonitor.Act.NONE) first = r;
        }
        return first;
    }

    public static void main(String[] a) {
        eq(true, WearMonitor.resting(true, false, null), "plano sin proximidad");
        eq(true, WearMonitor.resting(true, false, false), "plano, nada cerca");
        eq(false, WearMonitor.resting(true, false, true), "algo cerca = puesto");
        eq(false, WearMonitor.resting(false, false, null), "vertical con micro-movimiento = puesto");
        eq(true, WearMonitor.resting(false, true, null), "inmovil absoluto (sobre una mesa) = apoyado");
        eq(false, WearMonitor.resting(false, true, true), "inmovil pero algo cerca = puesto");

        // not_worn: una vez por episodio a los not_worn_s
        t = 0;
        WearMonitor w = new WearMonitor();
        eq(WearMonitor.Act.NONE, run(w, 119, true, true, 120, 0, false), "antes de 120 s");
        eq(WearMonitor.Act.NOT_WORN, run(w, 2, true, true, 120, 0, false), "a los 120 s");
        eq(true, w.stillSeconds() >= 120, "still_s >= 120");
        eq(WearMonitor.Act.NONE, run(w, 600, true, true, 120, 0, false), "una sola vez por episodio");
        // un sacudon corto no abre episodio nuevo; 3 s sostenidos si
        run(w, 1, false, true, 120, 0, false);
        eq(WearMonitor.Act.NONE, run(w, 130, true, true, 120, 0, false), "sacudon corto: sigue el episodio");
        run(w, 4, false, false, 120, 0, false); // lo levantan: movimiento sostenido
        eq(WearMonitor.Act.NOT_WORN, run(w, 130, true, true, 120, 0, false), "episodio nuevo tras moverlo");

        // not_worn apagado con 0
        t = 0;
        w = new WearMonitor();
        eq(WearMonitor.Act.NONE, run(w, 500, true, true, 0, 0, false), "not_worn_s=0 apaga");

        // inactividad apagada por defecto: puesto y quieto 1 h no avisa
        t = 0;
        w = new WearMonitor();
        eq(WearMonitor.Act.NONE, run(w, 3600, true, false, 120, 0, false), "inactivity_s=0: nada");

        // inactividad: PROMPT a 60 s, INACTIVE a inactivity_s
        t = 0;
        w = new WearMonitor();
        eq(WearMonitor.Act.NONE, run(w, 59, true, false, 120, 300, false), "antes de 60 s");
        eq(WearMonitor.Act.PROMPT, run(w, 2, true, false, 120, 300, false), "aviso a 60 s");
        eq(WearMonitor.Act.NONE, run(w, 200, true, false, 120, 300, false), "sin repetir aviso");
        eq(WearMonitor.Act.INACTIVE, run(w, 50, true, false, 120, 300, false), "inactive a 300 s");
        eq(WearMonitor.Act.NONE, run(w, 900, true, false, 120, 300, false), "inactive una sola vez");

        // movimiento antes de inactivity_s: cancela y reinicia
        t = 0;
        w = new WearMonitor();
        run(w, 100, true, false, 120, 300, false);
        run(w, 1, false, false, 120, 300, false);
        eq(WearMonitor.Act.NONE, run(w, 50, true, false, 120, 300, false), "se reinicio el conteo");
        eq(WearMonitor.Act.PROMPT, run(w, 20, true, false, 120, 300, false), "nuevo aviso a 60 s");

        // boton cancela
        t = 0;
        w = new WearMonitor();
        run(w, 250, true, false, 120, 300, false);
        w.onButton();
        eq(WearMonitor.Act.NONE, run(w, 40, true, false, 120, 300, false), "boton: reinicia");

        // hombre caido en curso: suspendido
        t = 0;
        w = new WearMonitor();
        eq(WearMonitor.Act.NONE, run(w, 400, true, false, 120, 300, true), "suspendido por hombre caido");
        System.out.println("WearMonitorCheck OK");
    }
}
