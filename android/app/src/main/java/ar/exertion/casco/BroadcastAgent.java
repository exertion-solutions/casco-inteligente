package ar.exertion.casco;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.media.ToneGenerator;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.util.ArrayDeque;
import java.util.List;

/**
 * Ordenes del supervisor (docs/PROTOCOLO-CENTRO.md seccion 4): evacuacion (sirena + voz) y mensajes.
 *
 * Hilos propios para no demorar eventos SOS (h) ni el video:
 *  - "casco-bpoll": red (GET broadcasts, con backoff). Lo dispara el poll de comandos (tick()) cada ~3 s.
 *  - "casco-balert": reproduccion (sirena AudioTrack USAGE_ALARM + TTS) y volumenes.
 * Dedupe por id persistente (filesDir/broadcast_seen.txt, ultimos 50). No interrumpe una llamada activa:
 * espera su fin (max 60 s) y avisa con un beep. El ack va AL INICIAR la reproduccion (RLS: ordenes < 2 min).
 */
final class BroadcastAgent {
    private static final String TAG = "CascoAgente";
    private static volatile BroadcastAgent instance;

    private final Context app;
    private final Supabase sb;
    private final Config cfg;
    private final File seenFile;
    private final BroadcastPolicy.Seen seen = new BroadcastPolicy.Seen();

    private HandlerThread pollT, alertT;
    private Handler ph, ah;

    // hilo bpoll
    private volatile boolean pending;
    private int fails;
    private long nextPollAt;

    // hilo balert
    private final ArrayDeque<Supabase.Broadcast> queue = new ArrayDeque<>();
    private boolean busy;
    private AudioTrack siren;
    private boolean sirenMuted;
    private int savedAlarm = -1, savedMusic = -1;

    BroadcastAgent(Context c, Supabase sb, Config cfg) {
        this.app = c.getApplicationContext();
        this.sb = sb;
        this.cfg = cfg;
        this.seenFile = new File(app.getFilesDir(), "broadcast_seen.txt");
    }

    private android.content.SharedPreferences prefs() {
        return app.getSharedPreferences("casco_volumes", Context.MODE_PRIVATE);
    }

    /** Si el proceso murio con el volumen subido por una orden, lo devuelve a lo que habia. */
    private void restoreStaleVolumes() {
        android.content.SharedPreferences p = prefs();
        int a = p.getInt("alarm", -1), m = p.getInt("music", -1);
        if (a < 0 && m < 0) return;
        try {
            AudioManager am = (AudioManager) app.getSystemService(Context.AUDIO_SERVICE);
            if (a >= 0) am.setStreamVolume(AudioManager.STREAM_ALARM, a, 0);
            if (m >= 0) am.setStreamVolume(AudioManager.STREAM_MUSIC, m, 0);
            Log.i(TAG, "volumen restaurado tras un cierre inesperado");
        } catch (RuntimeException e) {
            Log.w(TAG, "no se pudo restaurar el volumen previo: " + e);
        } finally {
            p.edit().clear().commit();
        }
    }

    void start() {
        restoreStaleVolumes();
        try (FileInputStream in = new FileInputStream(seenFile)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[2048];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
            seen.load(out.toString("UTF-8"));
        } catch (Exception ignored) { /* primer arranque o archivo ilegible: lista vacia */ }
        pollT = new HandlerThread("casco-bpoll");
        pollT.start();
        ph = new Handler(pollT.getLooper());
        alertT = new HandlerThread("casco-balert");
        alertT.start();
        ah = new Handler(alertT.getLooper());
        instance = this;
        Log.i(TAG, "ordenes del supervisor: activas (volumen " + cfg.broadcastVolume + ")");
    }

    void stop() {
        instance = null;
        if (ah != null) {
            ah.removeCallbacksAndMessages(null);
            ah.post(() -> { stopSiren(); restoreVolumes(); });
        }
        if (ph != null) ph.removeCallbacksAndMessages(null);
        if (pollT != null) pollT.quitSafely();
        if (alertT != null) alertT.quitSafely();
    }

    /** Desde el poll de comandos (hilo h, cada 3 s). No bloquea: la red corre en bpoll. */
    void tick() {
        if (ph == null || pending) return;
        pending = true;
        ph.post(this::pollOnce);
    }

    /** F10/F12 (SosKeyService): silencia la sirena; la voz sigue. No consume el evento. */
    static void silenceSiren() {
        final BroadcastAgent a = instance;
        if (a == null || a.ah == null) return;
        a.ah.post(() -> {
            if (a.siren != null || a.busy) Log.i(TAG, "evacuacion: sirena silenciada por boton");
            a.sirenMuted = true;
            a.stopSiren();
        });
    }

    // ---- hilo bpoll ----

    private void pollOnce() {
        try {
            long now = SystemClock.elapsedRealtime();
            if (now < nextPollAt) return;
            try {
                List<Supabase.Broadcast> list = sb.recentBroadcasts();
                if (fails > 0) Log.i(TAG, "poll de ordenes recuperado");
                fails = 0;
                for (Supabase.Broadcast b : list) {
                    if (!seen.add(b.id)) continue;
                    persist();
                    Log.i(TAG, "orden recibida kind=" + b.kind + " repeat=" + b.repeat);
                    ah.post(() -> enqueue(b));
                }
            } catch (Exception e) {
                if (fails++ == 0) Log.w(TAG, "poll de ordenes fallo (backoff hasta 30 s): " + e.getMessage());
                nextPollAt = SystemClock.elapsedRealtime() + StreamPolicy.pollDelayMs(fails);
            }
        } finally {
            pending = false;
        }
    }

    private void persist() {
        try (FileOutputStream o = new FileOutputStream(seenFile)) {
            o.write(seen.serialize().getBytes("UTF-8"));
        } catch (Exception e) {
            Log.w(TAG, "no se pudo guardar broadcast_seen: " + e);
        }
    }

    // ---- hilo balert ----

    private void enqueue(Supabase.Broadcast b) {
        queue.addLast(b);
        if (!busy) next();
    }

    private void next() {
        final Supabase.Broadcast b = queue.pollFirst();
        if (b == null) { busy = false; return; }
        busy = true;
        if (VoiceCallManager.inCall) {
            Log.i(TAG, "orden en espera: llamada activa (max 60 s)");
            beep(); // aviso: hay una orden esperando
        }
        waitCall(b, 0);
    }

    private void waitCall(Supabase.Broadcast b, long waited) {
        if (BroadcastPolicy.canStart(VoiceCallManager.inCall, waited)) {
            play(b);
        } else {
            ah.postDelayed(() -> waitCall(b, waited + 1000), 1000);
        }
    }

    private void play(Supabase.Broadcast b) {
        final String phrase = BroadcastPolicy.phrase(b.kind, b.message);
        if (phrase == null) { next(); return; }
        ackAsync(b.id); // AL INICIAR: la policy solo acepta acks de ordenes de < 2 min
        sirenMuted = false;
        setVolumes();
        cycle(b, phrase, 0);
    }

    private void cycle(Supabase.Broadcast b, String phrase, int i) {
        if (i >= b.repeat) { finish(); return; }
        if ("evacuacion".equals(b.kind) && !sirenMuted) {
            startSiren();
            ah.postDelayed(() -> { stopSiren(); SpanishVoice.announce(phrase); }, BroadcastPolicy.SIREN_MS);
        } else {
            SpanishVoice.announce(phrase);
        }
        ah.postDelayed(() -> cycle(b, phrase, i + 1), BroadcastPolicy.CYCLE_MS);
    }

    private void finish() {
        stopSiren();
        restoreVolumes();
        next();
    }

    /** Un hilo corto por ack: no demora la sirena. 3 intentos (5 s) dentro de la ventana de 2 min. */
    private void ackAsync(final String id) {
        new Thread(() -> {
            for (int i = 0; i < 3; i++) {
                if (sb.ackBroadcast(id)) { Log.i(TAG, "ack de orden enviado"); return; }
                try { Thread.sleep(5_000L); } catch (InterruptedException e) { return; }
            }
            Log.w(TAG, "ack de orden descartado tras 3 intentos");
        }, "casco-back").start();
    }

    private void setVolumes() {
        try {
            AudioManager am = (AudioManager) app.getSystemService(Context.AUDIO_SERVICE);
            if (savedAlarm < 0) {
                savedAlarm = am.getStreamVolume(AudioManager.STREAM_ALARM);
                savedMusic = am.getStreamVolume(AudioManager.STREAM_MUSIC);
                // antes de subirlo: si el proceso muere, al arrancar se restaura (restoreStaleVolumes)
                prefs().edit().putInt("alarm", savedAlarm).putInt("music", savedMusic).commit();
            }
            am.setStreamVolume(AudioManager.STREAM_ALARM,
                    BroadcastPolicy.volumeIndex(cfg.broadcastVolume, am.getStreamMaxVolume(AudioManager.STREAM_ALARM)), 0);
            am.setStreamVolume(AudioManager.STREAM_MUSIC,
                    BroadcastPolicy.volumeIndex(cfg.broadcastVolume, am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)), 0);
        } catch (RuntimeException e) {
            Log.w(TAG, "orden: no se pudo subir el volumen: " + e);
        }
    }

    private void restoreVolumes() {
        if (savedAlarm < 0) return;
        try {
            AudioManager am = (AudioManager) app.getSystemService(Context.AUDIO_SERVICE);
            am.setStreamVolume(AudioManager.STREAM_ALARM, savedAlarm, 0);
            am.setStreamVolume(AudioManager.STREAM_MUSIC, savedMusic, 0);
        } catch (RuntimeException e) {
            Log.w(TAG, "orden: no se pudo restaurar el volumen: " + e);
        } finally {
            savedAlarm = savedMusic = -1;
            prefs().edit().clear().commit();
        }
    }

    private void startSiren() {
        stopSiren();
        try {
            final int rate = 16_000;
            short[] pcm = BroadcastPolicy.siren(rate, 1000);
            AudioTrack t = new AudioTrack.Builder()
                    .setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_ALARM)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                    .setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                    .setBufferSizeInBytes(pcm.length * 2)
                    .setTransferMode(AudioTrack.MODE_STATIC).build();
            t.write(pcm, 0, pcm.length);
            t.setLoopPoints(0, pcm.length, -1);
            t.play();
            siren = t;
        } catch (RuntimeException e) {
            Log.w(TAG, "sirena: AudioTrack fallo, uso beep: " + e);
            beep();
        }
    }

    private void stopSiren() {
        AudioTrack t = siren;
        siren = null;
        if (t == null) return;
        try { t.stop(); } catch (RuntimeException ignored) { }
        try { t.release(); } catch (RuntimeException ignored) { }
    }

    private void beep() {
        try {
            final ToneGenerator tg = new ToneGenerator(AudioManager.STREAM_ALARM, 100);
            tg.startTone(ToneGenerator.TONE_PROP_BEEP, 250);
            if (ah != null) ah.postDelayed(tg::release, 600);
        } catch (RuntimeException e) {
            Log.w(TAG, "beep: " + e);
        }
    }
}
