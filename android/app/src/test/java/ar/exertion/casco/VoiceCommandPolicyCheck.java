package ar.exertion.casco;

import ar.exertion.casco.VoiceCommandPolicy.Cmd;
import ar.exertion.casco.VoiceCommandPolicy.Outcome;
import ar.exertion.casco.VoiceCommandPolicy.Session;

/** Sin framework: java -ea ar.exertion.casco.VoiceCommandPolicyCheck */
public class VoiceCommandPolicyCheck {
    static int n;

    static void eq(Object exp, Object got, String what) {
        n++;
        if (exp == null ? got != null : !exp.equals(got)) throw new AssertionError(what + ": esperaba " + exp + " y fue " + got);
    }

    static Cmd cmd(Session s, long now, String text, boolean countdown) {
        return s.feed(now, text, -1, countdown) == Outcome.COMMAND ? s.cmd() : null;
    }

    public static void main(String[] a) {
        // normalizacion
        eq("activar camara", VoiceCommandPolicy.norm("Activar CÁMARA"), "tildes");
        eq("bateria", VoiceCommandPolicy.norm("batería!"), "tilde+signo");
        eq("casco foto", VoiceCommandPolicy.norm("  Casco,   foto. "), "puntuacion");
        eq("casco", VoiceCommandPolicy.sanitizeWake("Casco"), "wake ok");
        eq("casco", VoiceCommandPolicy.sanitizeWake("hola mundo"), "wake con dos palabras -> default");
        eq("casco", VoiceCommandPolicy.sanitizeWake(""), "wake vacio");
        eq("robot", VoiceCommandPolicy.sanitizeWake("ROBOT"), "wake propio");

        // frase -> comando con palabra de activacion
        Session s = new Session("casco");
        long t = 100_000;
        eq(Cmd.SOS, cmd(s, t += 5000, "casco emergencia", false), "emergencia");
        eq(Cmd.SOS, cmd(s, t += 5000, "casco auxilio", false), "auxilio");
        eq(Cmd.SOS, cmd(s, t += 5000, "casco socorro", false), "socorro");
        eq(Cmd.SOS, cmd(s, t += 5000, "casco activar sos", false), "activar sos");
        eq(Cmd.PHOTO, cmd(s, t += 5000, "casco sacar foto", false), "sacar foto");
        eq(Cmd.PHOTO, cmd(s, t += 5000, "casco foto", false), "foto");
        eq(Cmd.VIDEO_ON, cmd(s, t += 5000, "casco activar cámara", false), "camara on (tilde)");
        eq(Cmd.VIDEO_ON, cmd(s, t += 5000, "casco iniciar video", false), "iniciar video");
        eq(Cmd.VIDEO_OFF, cmd(s, t += 5000, "casco desactivar camara", false), "camara off");
        eq(Cmd.VIDEO_OFF, cmd(s, t += 5000, "casco detener video", false), "detener video");
        eq(Cmd.AUDIO_ON, cmd(s, t += 5000, "casco activar audio", false), "audio on");
        eq(Cmd.AUDIO_OFF, cmd(s, t += 5000, "casco desactivar audio", false), "audio off");
        eq(Cmd.TORCH_ON, cmd(s, t += 5000, "casco activar linterna", false), "linterna on");
        eq(Cmd.TORCH_ON, cmd(s, t += 5000, "casco prender linterna", false), "prender linterna");
        eq(Cmd.TORCH_OFF, cmd(s, t += 5000, "casco desactivar linterna", false), "linterna off");
        eq(Cmd.TORCH_OFF, cmd(s, t += 5000, "casco apagar linterna", false), "apagar linterna");
        eq(Cmd.STATUS, cmd(s, t += 5000, "casco estado", false), "estado");
        eq(Cmd.STATUS, cmd(s, t += 5000, "casco batería", false), "bateria");
        eq(Cmd.HELP, cmd(s, t += 5000, "casco ayuda", false), "ayuda");
        eq(Cmd.REPEAT, cmd(s, t += 5000, "casco repetir", false), "repetir");
        eq(Cmd.CANCEL, cmd(s, t += 5000, "casco cancelar", false), "cancelar con wake");

        // sin palabra de activacion: nada (falso positivo de conversacion)
        eq(null, cmd(s, t += 5000, "emergencia", false), "emergencia suelta no dispara");
        eq(null, cmd(s, t += 5000, "foto", false), "foto suelta no dispara");
        eq(null, cmd(s, t += 5000, "casco bailar", false), "frase fuera de gramatica");
        eq(null, cmd(s, t += 5000, "[unk]", false), "unk");
        eq(null, cmd(s, t += 5000, "casco [unk] foto", false), "unk en medio");
        eq(Cmd.PHOTO, cmd(s, t += 5000, "[unk] casco foto", false), "unk al inicio se descarta");

        // "cancelar" suelto solo durante una cuenta regresiva
        eq(null, cmd(s, t += 5000, "cancelar", false), "cancelar suelto sin cuenta");
        eq(Cmd.CANCEL, cmd(s, t += 5000, "cancelar", true), "cancelar suelto con cuenta");

        // ventana: "casco" solo y luego la frase suelta
        Session w = new Session("casco");
        t = 500_000;
        eq(Outcome.WAKE, w.feed(t, "casco", -1, false), "wake solo");
        eq(Cmd.PHOTO, cmd(w, t + 3000, "foto", false), "frase suelta dentro de la ventana");
        eq(null, cmd(w, t + 4000, "estado", false), "la ventana se consume con el comando");
        eq(Outcome.WAKE, w.feed(t + 10_000, "casco", -1, false), "wake otra vez");
        eq(null, cmd(w, t + 10_000 + VoiceCommandPolicy.WINDOW_MS + 1, "estado", false), "ventana vencida");

        // duplicados y confianza
        Session d = new Session("casco");
        t = 900_000;
        eq(Cmd.TORCH_ON, cmd(d, t, "casco activar linterna", false), "primero");
        eq(null, cmd(d, t + 1000, "casco activar linterna", false), "duplicado en 2,5 s");
        eq(Cmd.TORCH_ON, cmd(d, t + 3000, "casco activar linterna", false), "mismo comando pasado el filtro");
        eq(Outcome.IGNORED, d.feed(t + 9000, "casco emergencia", 0.3, false), "confianza baja");
        eq(Outcome.COMMAND, d.feed(t + 9500, "casco emergencia", 0.9, false), "confianza alta");

        // wake word propia
        Session r = new Session("Robot");
        eq(Cmd.PHOTO, cmd(r, 1, "robot foto", false), "wake configurable");
        eq(null, cmd(r, 99_999, "casco foto", false), "la wake por defecto ya no vale");

        // JSON de Vosk
        String j = "{\"result\":[{\"conf\":1.0,\"end\":1.2,\"start\":0.8,\"word\":\"casco\"},"
                + "{\"conf\":0.5,\"end\":1.9,\"start\":1.3,\"word\":\"foto\"}],\"text\":\"casco foto\"}";
        eq("casco foto", VoiceCommandPolicy.text(j), "text");
        eq(0.75, VoiceCommandPolicy.meanConf(j), "conf media");
        eq("", VoiceCommandPolicy.text("{\"partial\":\"\"}"), "sin text");
        eq(-1.0, VoiceCommandPolicy.meanConf("{\"text\":\"\"}"), "sin conf");

        // gramatica
        String g = VoiceCommandPolicy.grammarJson("casco");
        eq(true, g.startsWith("[\"casco\",") && g.endsWith("\"[unk]\"]"), "json gramatica");
        eq(true, g.contains("\"casco activar cámara\"") && g.contains("\"prender linterna\""), "frases en la gramatica");

        // energia
        long m = 60_000L;
        eq(false, VoiceCommandPolicy.idleOff(9 * m, 0, 10), "9 min: sigue");
        eq(true, VoiceCommandPolicy.idleOff(10 * m, 0, 10), "10 min: apaga");
        eq(false, VoiceCommandPolicy.idleOff(999 * m, 0, 0), "0 = nunca");

        // SOS por voz: 5 s despues de que termino de hablar; tope de seguridad 15 s
        eq(false, VoiceCommandPolicy.sosDue(2_000, 0, -1), "todavia habla");
        eq(false, VoiceCommandPolicy.sosDue(4_000, 0, 3_000), "1 s de silencio");
        eq(true, VoiceCommandPolicy.sosDue(8_000, 0, 3_000), "5 s de silencio");
        eq(true, VoiceCommandPolicy.sosDue(15_000, 0, -1), "tope de seguridad aunque la voz no termine");

        // frases
        eq("Batería al 80 por ciento, señal buena, sin video.", VoiceCommandPolicy.status(80, 4, false, false), "estado");
        eq("Batería al 15 por ciento, sin señal, con video y audio.", VoiceCommandPolicy.status(15, 0, true, true), "estado 2");
        eq("sin video.", VoiceCommandPolicy.status(null, null, false, false), "estado sin datos");
        eq(VoiceCommandPolicy.TORCH_BUSY, VoiceCommandPolicy.torchError("camara ocupada", true), "linterna con stream");
        eq(VoiceCommandPolicy.TORCH_BUSY_APP, VoiceCommandPolicy.torchError("camara ocupada", false), "linterna otra app");
        eq(VoiceCommandPolicy.PHOTO_ERR, VoiceCommandPolicy.photoError("tiempo agotado", false), "foto error generico");
        eq(true, VoiceCommandPolicy.help("casco").startsWith("Diga casco"), "ayuda");

        System.out.println("VoiceCommandPolicyCheck OK (" + n + " verificaciones)");
    }
}
