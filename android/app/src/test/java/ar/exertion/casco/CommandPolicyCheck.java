package ar.exertion.casco;

/** Sin framework: ver android/README-VOZ.md (seccion tanda 4). */
public class CommandPolicyCheck {
    static void eq(Object exp, Object got, String what) {
        if (exp == null ? got != null : !exp.equals(got)) {
            throw new AssertionError(what + ": esperado " + exp + " obtenido " + got);
        }
    }

    public static void main(String[] a) {
        eq(CommandPolicy.Action.PHOTO, CommandPolicy.parse("photo"), "photo");
        eq(CommandPolicy.Action.TORCH_ON, CommandPolicy.parse("torch_on"), "torch_on");
        eq(CommandPolicy.Action.TORCH_OFF, CommandPolicy.parse("torch_off"), "torch_off");
        eq(CommandPolicy.Action.RESTART_AGENT, CommandPolicy.parse("restart_agent"), "restart");
        eq(CommandPolicy.Action.PING, CommandPolicy.parse("ping"), "ping");
        eq(null, CommandPolicy.parse("format_disk"), "accion desconocida");
        eq(null, CommandPolicy.parse(null), "accion null");

        eq(true, CommandPolicy.validId("123e4567-e89b-12d3-a456-426614174000"), "uuid");
        eq(false, CommandPolicy.validId(""), "id vacio");
        eq(false, CommandPolicy.validId("a b"), "id con espacio");
        eq(false, CommandPolicy.validId("../x"), "id con ruta");
        eq(false, CommandPolicy.validId(null), "id null");

        // dedupe + persistencia: lo visto no vuelve a correr, ni tras reiniciar (serialize/load)
        BroadcastPolicy.Seen seen = new BroadcastPolicy.Seen();
        eq(CommandPolicy.Verdict.RUN, CommandPolicy.decide(seen, "c1", "photo"), "primera vez");
        eq(CommandPolicy.Verdict.DUP, CommandPolicy.decide(seen, "c1", "photo"), "duplicado");
        eq(CommandPolicy.Verdict.IGNORE, CommandPolicy.decide(seen, "c2", "otra"), "accion invalida");
        eq(CommandPolicy.Verdict.RUN, CommandPolicy.decide(seen, "c2", "ping"), "invalido no se registro");
        BroadcastPolicy.Seen again = new BroadcastPolicy.Seen();
        again.load(seen.serialize());
        eq(CommandPolicy.Verdict.DUP, CommandPolicy.decide(again, "c2", "restart_agent"), "persistido: no reejecuta");
        eq(CommandPolicy.Verdict.IGNORE, CommandPolicy.decide(again, "bad id", "ping"), "id invalido");

        // linterna
        eq(true, CommandPolicy.torchAllowed(null), "sin config: permitida");
        eq(true, CommandPolicy.torchAllowed(Boolean.TRUE), "permitida");
        eq(false, CommandPolicy.torchAllowed(Boolean.FALSE), "bloqueada");

        // detail del ack
        eq(null, CommandPolicy.detail("  "), "detail vacio");
        eq("a b", CommandPolicy.detail("a\r\nb"), "detail sin saltos");
        StringBuilder big = new StringBuilder();
        for (int i = 0; i < 300; i++) big.append('x');
        eq(200, CommandPolicy.detail(big.toString()).length(), "detail <= 200");

        // reintento de foto dentro de la vigencia del comando
        eq(true, CommandPolicy.photoRetryOk(30_000), "reintento temprano");
        eq(false, CommandPolicy.photoRetryOk(100_000), "comando por vencer");
        System.out.println("CommandPolicyCheck OK");
    }
}
