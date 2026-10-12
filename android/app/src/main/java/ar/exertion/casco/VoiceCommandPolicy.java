package ar.exertion.casco;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Comandos de voz en espanol (docs/PROTOCOLO-GEO.md seccion 5). Logica PURA (sin Android): gramatica cerrada,
 * normalizacion de tildes, palabra de activacion + ventana, filtro de duplicados, apagado por inactividad y
 * frases habladas. El reloj entra por parametro (ms monotonos). Testeable con VoiceCommandPolicyCheck.
 *
 * Frases con tildes: la gramatica de Vosk usa las palabras tal como estan en el vocabulario del modelo; el
 * reconocido se normaliza (sin tildes, minusculas) antes de buscarlo.
 */
final class VoiceCommandPolicy {
    enum Cmd { SOS, CANCEL, PHOTO, VIDEO_ON, VIDEO_OFF, AUDIO_ON, AUDIO_OFF, TORCH_ON, TORCH_OFF, STATUS, HELP, REPEAT }

    /** Resultado de procesar una frase reconocida. */
    enum Outcome { IGNORED, WAKE, COMMAND }

    /** Frase -> comando (la frase se dice despues de la palabra de activacion). */
    private static final Object[][] PHRASES = {
        {"emergencia", Cmd.SOS}, {"auxilio", Cmd.SOS}, {"socorro", Cmd.SOS}, {"activar sos", Cmd.SOS},
        {"cancelar", Cmd.CANCEL},
        {"foto", Cmd.PHOTO}, {"sacar foto", Cmd.PHOTO},
        {"activar cámara", Cmd.VIDEO_ON}, {"iniciar video", Cmd.VIDEO_ON},
        {"desactivar cámara", Cmd.VIDEO_OFF}, {"detener video", Cmd.VIDEO_OFF},
        {"activar audio", Cmd.AUDIO_ON}, {"desactivar audio", Cmd.AUDIO_OFF},
        {"activar linterna", Cmd.TORCH_ON}, {"prender linterna", Cmd.TORCH_ON},
        {"desactivar linterna", Cmd.TORCH_OFF}, {"apagar linterna", Cmd.TORCH_OFF},
        {"estado", Cmd.STATUS}, {"batería", Cmd.STATUS},
        {"ayuda", Cmd.HELP}, {"repetir", Cmd.REPEAT},
    };

    static final String DEFAULT_WAKE = "casco";
    static final long WINDOW_MS = 8_000L;      // tras decir solo "casco": se aceptan frases sin la palabra
    static final long DUPLICATE_MS = 2_500L;   // mismo comando repetido (Vosk a veces parte una frase en dos)
    static final double MIN_CONF = 0.5;        // confianza media por palabra (Vosk, setWords)
    static final long SOS_COUNTDOWN_MS = 5_000L;
    static final long SOS_FAILSAFE_MS = 15_000L; // si la voz no termina nunca de hablar, el SOS sale igual

    private VoiceCommandPolicy() { }

    // ---- texto ----

    /** Minusculas, sin tildes, solo letras y numeros separados por un espacio. */
    static String norm(String s) {
        if (s == null) return "";
        String d = Normalizer.normalize(s.toLowerCase(Locale.ROOT), Normalizer.Form.NFD).replaceAll("\\p{M}+", "");
        return d.replaceAll("[^a-z0-9\\[\\]]+", " ").trim();
    }

    /** Una sola palabra de 3 a 20 letras; si no, "casco". */
    static String sanitizeWake(String w) {
        String n = norm(w);
        return n.matches("[a-z]{3,20}") ? n : DEFAULT_WAKE;
    }

    static Cmd lookup(String phraseNorm) {
        for (Object[] p : PHRASES) if (norm((String) p[0]).equals(phraseNorm)) return (Cmd) p[1];
        return null;
    }

    /** Frases de la gramatica: "<wake> <frase>", la frase suelta (solo valida con la ventana abierta), y "<wake>". */
    static List<String> grammar(String wake) {
        List<String> g = new ArrayList<>();
        g.add(wake);
        for (Object[] p : PHRASES) {
            g.add(wake + " " + p[0]);
            g.add((String) p[0]);
        }
        g.add("[unk]");
        return g;
    }

    /** JSON de la gramatica para Recognizer(model, rate, grammar): lista JSON de frases. */
    static String grammarJson(String wake) {
        StringBuilder sb = new StringBuilder("[");
        boolean first = true;
        for (String s : grammar(wake)) {
            if (!first) sb.append(',');
            first = false;
            sb.append('"').append(s.replace("\\", "\\\\").replace("\"", "\\\"")).append('"');
        }
        return sb.append(']').toString();
    }

    /** Campo "text" de un resultado de Vosk ({"text":"..."} o con "result":[{conf,word}...]); "" si no hay. */
    static String text(String json) {
        if (json == null) return "";
        int k = json.indexOf("\"text\"");
        if (k < 0) return "";
        int a = json.indexOf('"', json.indexOf(':', k) + 1);
        if (a < 0) return "";
        int b = json.indexOf('"', a + 1);
        return b < 0 ? "" : json.substring(a + 1, b);
    }

    /** Confianza media de "conf" en el resultado; -1 si no hay palabras con confianza. */
    static double meanConf(String json) {
        if (json == null) return -1;
        double sum = 0;
        int n = 0, i = 0;
        while ((i = json.indexOf("\"conf\"", i)) >= 0) {
            int c = json.indexOf(':', i);
            int e = c + 1;
            while (e < json.length() && " 0123456789.eE-+".indexOf(json.charAt(e)) >= 0) e++;
            try {
                sum += Double.parseDouble(json.substring(c + 1, e).trim());
                n++;
            } catch (NumberFormatException ignored) { }
            i = e;
        }
        return n == 0 ? -1 : sum / n;
    }

    // ---- sesion: palabra de activacion y ventana ----

    /** Estado de la ventana de activacion. Un solo hilo (el del reconocedor). */
    static final class Session {
        private final String wake;
        private long windowUntil = -1, lastAt = -1;
        private Cmd last;
        private Cmd cmd;

        Session(String wakeWord) { wake = sanitizeWake(wakeWord); }

        /** Comando de la ultima llamada a feed() que devolvio COMMAND. */
        Cmd cmd() { return cmd; }

        boolean windowOpen(long now) { return now < windowUntil; }

        /**
         * @param text      texto reconocido (crudo)
         * @param conf      confianza media (-1 = desconocida)
         * @param countdown hay una cuenta regresiva de SOS por voz o de hombre caido en curso: "cancelar" suelto vale
         */
        Outcome feed(long now, String text, double conf, boolean countdown) {
            cmd = null;
            if (conf >= 0 && conf < MIN_CONF) return Outcome.IGNORED;
            String t = norm(text);
            while (t.startsWith("[unk]")) t = t.substring(5).trim();
            if (t.isEmpty() || t.contains("[unk]")) return Outcome.IGNORED;
            Cmd c;
            if (t.equals(wake)) {
                windowUntil = now + WINDOW_MS;
                return Outcome.WAKE;
            } else if (t.startsWith(wake + " ")) {
                c = lookup(t.substring(wake.length() + 1));
            } else {
                c = lookup(t);
                if (c != null && !(windowOpen(now) || (c == Cmd.CANCEL && countdown))) return Outcome.IGNORED;
            }
            if (c == null) return Outcome.IGNORED;
            if (c == last && now - lastAt < DUPLICATE_MS) return Outcome.IGNORED;
            last = c;
            lastAt = now;
            windowUntil = -1; // un comando consume la ventana
            cmd = c;
            return Outcome.COMMAND;
        }
    }

    // ---- energia ----

    /**
     * Apagar el reconocimiento: sin movimiento durante {@code idleMin} minutos (0 = nunca). lastMotionMs es el
     * ultimo movimiento (o comando) en ms monotonos.
     */
    static boolean idleOff(long now, long lastMotionMs, int idleMin) {
        return idleMin > 0 && now - lastMotionMs >= idleMin * 60_000L;
    }

    // ---- SOS por voz: la cuenta de 5 s corre cuando el casco termino de hablar ----

    /**
     * @param requestedAt   instante en que se pidio el SOS
     * @param quietSince    instante en que el casco dejo de hablar (-1 = todavia habla)
     * @return true = enviar el SOS ahora
     */
    static boolean sosDue(long now, long requestedAt, long quietSince) {
        if (now - requestedAt >= SOS_FAILSAFE_MS) return true;
        return quietSince >= 0 && now - quietSince >= SOS_COUNTDOWN_MS;
    }

    // ---- frases habladas (es-AR) ----

    static final String SOS_START = "Emergencia en cinco segundos. Diga cancelar para anular.";
    static final String CANCELLED = "Cancelado.";
    static final String NOTHING_TO_CANCEL = "No hay nada para cancelar.";
    static final String PHOTO_OK = "Foto enviada.";
    static final String VIDEO_OFF_OK = "Transmisión detenida.";
    static final String NO_VIDEO = "No hay transmisión en curso.";
    static final String ALREADY_VIDEO = "Ya estoy transmitiendo.";
    static final String VIDEO_NO_HOST = "No puedo transmitir: el casco no tiene servidor de video configurado.";
    static final String VIDEO_EMERGENCY = "No puedo detener la transmisión: hay una emergencia en curso.";
    static final String AUDIO_EMERGENCY = "No puedo cambiar el audio: hay una emergencia en curso.";
    static final String AUDIO_ON_NEXT = "Audio activado. Se usará en la próxima transmisión.";
    static final String AUDIO_OFF_OK = "Audio desactivado.";
    static final String AUDIO_ON_STREAM = "Transmisión con audio.";
    static final String AUDIO_OFF_STREAM = "Transmisión sin audio.";
    static final String TORCH_ON_OK = "Linterna encendida.";
    static final String TORCH_OFF_OK = "Linterna apagada.";
    static final String TORCH_BUSY = "No puedo usar la linterna: la cámara está ocupada por la transmisión de video.";
    static final String TORCH_BUSY_APP = "No puedo usar la linterna: la cámara está ocupada por otra aplicación.";
    static final String PHOTO_BUSY_APP = "No puedo sacar la foto: la cámara está ocupada por otra aplicación.";
    static final String TORCH_ERR = "No puedo usar la linterna en este momento.";
    static final String PHOTO_BUSY = "No puedo sacar la foto: la cámara está ocupada por la transmisión de video.";
    static final String PHOTO_ERR = "No pude sacar la foto.";
    static final String NOTHING_TO_REPEAT = "No tengo nada para repetir.";

    /** Motivo (CommandAgent) -> frase para la linterna. */
    static String torchError(String reason, boolean streaming) {
        if (reason != null && reason.contains("ocupada")) return streaming ? TORCH_BUSY : TORCH_BUSY_APP;
        return TORCH_ERR;
    }

    static String photoError(String reason, boolean streaming) {
        if (reason != null && reason.contains("ocupada")) return streaming ? PHOTO_BUSY : PHOTO_BUSY_APP;
        return PHOTO_ERR;
    }

    /** "Batería al 80 por ciento, señal buena, sin video." (null = dato desconocido: se omite). */
    static String status(Integer bat, Integer lvl, boolean video, boolean audio) {
        StringBuilder s = new StringBuilder();
        if (bat != null) s.append("Batería al ").append(bat).append(" por ciento");
        if (lvl != null) {
            if (s.length() > 0) s.append(", ");
            s.append(lvl <= 0 ? "sin señal" : lvl == 1 ? "señal mala" : lvl == 2 ? "señal regular" : "señal buena");
        }
        if (s.length() > 0) s.append(", ");
        s.append(!video ? "sin video" : audio ? "con video y audio" : "con video");
        return s.append('.').toString();
    }

    /** Lista de comandos que lee "ayuda". */
    static String help(String wake) {
        return "Diga " + wake + " y el comando. Emergencia. Cancelar. Foto. Activar cámara. Desactivar cámara. "
                + "Activar audio. Desactivar audio. Activar linterna. Desactivar linterna. Estado. Repetir.";
    }
}
