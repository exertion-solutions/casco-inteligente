package ar.exertion.casco;

import android.content.Context;
import android.media.AudioAttributes;
import android.speech.tts.TextToSpeech;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Voz del casco en espanol (docs/PROTOCOLO-VOZ.md seccion 3). Motor Google (con respaldo al motor por
 * defecto), idioma es-AR -> es-ES -> es. Si no hay voz en espanol: se loguea una vez y no se habla.
 * No habla durante una llamada activa. speak() no bloquea y puede llamarse desde cualquier hilo.
 * Texto con escapes unicode para no depender de la codificacion del compilador.
 */
final class SpanishVoice implements TextToSpeech.OnInitListener {
    private static final String TAG = "CascoAgente";
    private static final String GOOGLE_TTS = "com.google.android.tts";

    // Frases (seccion 3 y 6)
    static final String EMERGENCIA = "Emergencia enviada";
    static final String EMERGENCIA_SIN_RED = "Emergencia registrada, sin conexión, reintentando";
    static final String FOTO = "Foto tomada";
    static final String STREAM_ON = "Transmisión de video iniciada";
    static final String STREAM_OFF = "Transmisión detenida";
    static final String LLAMADA = "Llamada del supervisor";
    static final String LLAMADA_FIN = "Llamada finalizada";
    static final String AUDIO_ON = "Transmisión con audio";
    static final String CAIDA = "Caída detectada. Presione cualquier botón para cancelar la alerta";

    /** Instancia del proceso (la crea MediaWatcherService si voice_prompts es true). */
    static volatile SpanishVoice instance;

    /** voice_prompts: false = las frases de estado callan, pero las ordenes del supervisor (announce) siguen. */
    static volatile boolean promptsOn = true;

    static void say(String text) {
        SpanishVoice v = instance;
        if (v != null && promptsOn) v.speak(text);
    }

    /** Orden del supervisor: se habla aunque voice_prompts sea false. */
    static void announce(String text) {
        SpanishVoice v = instance;
        if (v != null) v.speak(text);
    }

    private final Context app;
    private TextToSpeech tts;
    private boolean ready, failed, triedDefault;
    private final List<String> pending = new ArrayList<>();

    SpanishVoice(Context c) {
        app = c.getApplicationContext();
        synchronized (this) {
            tts = new TextToSpeech(app, this, GOOGLE_TTS);
        }
    }

    @Override
    public synchronized void onInit(int status) {
        if (status != TextToSpeech.SUCCESS) {
            if (!triedDefault) { // Google TTS no esta: probar el motor por defecto
                triedDefault = true;
                try { tts.shutdown(); } catch (RuntimeException ignored) { }
                tts = new TextToSpeech(app, this);
                return;
            }
            fail("TTS no inicializa (status " + status + ")");
            return;
        }
        Locale[] cand = {new Locale("es", "AR"), new Locale("es", "ES"), new Locale("es")};
        for (Locale l : cand) {
            int r = tts.isLanguageAvailable(l);
            if (r >= TextToSpeech.LANG_AVAILABLE && tts.setLanguage(l) >= TextToSpeech.LANG_AVAILABLE) {
                tts.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA) // STREAM_MUSIC
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
                ready = true;
                Log.i(TAG, "voz: idioma " + l);
                List<String> p = new ArrayList<>(pending);
                pending.clear();
                for (String s : p) doSpeak(s);
                return;
            }
        }
        fail("sin voz en espanol instalada (es-AR/es-ES/es): el casco no hablara");
    }

    private void fail(String why) {
        if (!failed) Log.w(TAG, "voz: " + why);
        failed = true;
        pending.clear();
    }

    synchronized void speak(String text) {
        if (failed || VoiceCallManager.inCall) return; // no hablar durante una llamada activa
        if (!ready) {
            if (pending.size() < 3) pending.add(text);
            return;
        }
        doSpeak(text);
    }

    private void doSpeak(String text) {
        try {
            tts.speak(text, TextToSpeech.QUEUE_ADD, null, "casco-" + System.nanoTime());
        } catch (RuntimeException e) {
            Log.w(TAG, "voz: speak fallo: " + e);
        }
    }

    synchronized void shutdown() {
        instance = null;
        try {
            if (tts != null) tts.shutdown();
        } catch (RuntimeException ignored) { }
    }
}
