package ar.exertion.casco;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;
import org.webrtc.AudioSource;
import org.webrtc.AudioTrack;
import org.webrtc.DataChannel;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RTCStats;
import org.webrtc.RTCStatsReport;
import org.webrtc.RtpReceiver;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;
import org.webrtc.audio.JavaAudioDeviceModule;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Llamada de voz bidireccional (docs/PROTOCOLO-VOZ.md seccion 2). WebRTC solo audio (Opus, AEC/NS/AGC
 * por software de WebRTC). Senalizacion por public.rtc_signals (REST, sondeo).
 *
 * Hilos: "casco-voice" (vh) corre el sondeo y TODO el estado de la llamada; las senales salientes van por
 * un ejecutor propio (tx) para que la red no frene ni el sondeo ni los callbacks de WebRTC.
 * Nada aqui toca la camara ni el video RTMP. Mic y AudioManager se liberan siempre (endCall).
 */
final class VoiceCallManager {
    private static final String TAG = "CascoAgente";

    /** true durante una llamada (SpanishVoice no habla). */
    static volatile boolean inCall;
    private static volatile VoiceCallManager instance;

    static final long POLL_IDLE_MS = 3_000L;
    static final long POLL_CALL_MS = 1_000L;
    static final long OFFER_MAX_AGE_MS = 30_000L;
    static final long MAX_CALL_MS = 30 * 60_000L;
    static final long NO_AUDIO_MS = 20_000L;
    static final long WATCHDOG_MS = 5_000L;
    static final long ACCEPT_WAIT_MS = 20_000L;
    private static final int MAX_ICE_SENT = 25;   // rtc_signals: 60 filas/min por call_id

    private static boolean rtcInitDone, rtcInitOk;

    private final Context app;
    private final Supabase sb;
    private final Config cfg;
    private final HandlerThread thread = new HandlerThread("casco-voice");
    private final ExecutorService tx = Executors.newSingleThreadExecutor(r -> new Thread(r, "casco-voice-tx"));
    private Handler vh;
    private final Set<String> seen = new LinkedHashSet<>();
    private int fails;
    private volatile boolean stopped;

    // oferta pendiente (voice_auto_answer = false): espera F12
    private Supabase.Signal pendingOffer;
    private long pendingAt;

    private Call call; // solo hilo vh

    VoiceCallManager(Context c, Supabase sb, Config cfg) {
        this.app = c.getApplicationContext();
        this.sb = sb;
        this.cfg = cfg;
    }

    void start() {
        thread.start();
        vh = new Handler(thread.getLooper());
        instance = this;
        vh.postDelayed(poll, 4_000L);
        Log.i(TAG, "voz: sondeo de llamadas activo (auto_answer=" + cfg.voiceAutoAnswer + ")");
    }

    void stop() {
        stopped = true;
        if (instance == this) instance = null;
        if (vh != null) {
            vh.removeCallbacksAndMessages(null);
            vh.post(() -> endCall("servicio detenido", true));
            vh.post(() -> thread.quitSafely());
        }
        tx.shutdown();
    }

    /** F12 (llamada pendiente con voice_auto_answer=false): atiende. Cualquier hilo. */
    static void acceptPending() {
        VoiceCallManager m = instance;
        if (m == null || m.vh == null) return;
        m.vh.post(() -> {
            Supabase.Signal o = m.pendingOffer;
            m.pendingOffer = null;
            if (o != null && m.call == null && SystemClock.elapsedRealtime() - m.pendingAt <= ACCEPT_WAIT_MS) {
                m.startCall(o);
            }
        });
    }

    // ---- sondeo ----

    private final Runnable poll = new Runnable() {
        @Override public void run() {
            if (stopped) return;
            try {
                List<Supabase.Signal> list = sb.viewerSignals(OFFER_MAX_AGE_MS);
                if (fails > 0) Log.i(TAG, "voz: sondeo recuperado");
                fails = 0;
                // offer + hangup del mismo call_id en la lista: la oferta ya esta colgada, no abrir el microfono
                List<String> ids = new ArrayList<>(), kinds = new ArrayList<>();
                for (Supabase.Signal s : list) { ids.add(s.callId); kinds.add(s.kind); }
                java.util.Set<String> hung = AgentPolicy.hungUpCalls(ids, kinds);
                for (Supabase.Signal s : list) {
                    if (!seen.add(s.id)) continue;
                    if ("offer".equals(s.kind) && hung.contains(s.callId)) {
                        Log.i(TAG, "voz: oferta ya colgada, se ignora");
                        continue;
                    }
                    handle(s);
                }
                while (seen.size() > 400) {
                    java.util.Iterator<String> it = seen.iterator();
                    it.next();
                    it.remove();
                }
            } catch (Exception e) {
                if (fails++ == 0) Log.w(TAG, "voz: sondeo fallo (backoff): " + e.getMessage());
            }
            boolean busy = call != null || pendingOffer != null;
            long d = StreamPolicy.pollDelayMs(fails);
            if (busy) d = fails > 0 ? Math.min(d, 5_000L) : POLL_CALL_MS;
            else if (fails == 0) d = POLL_IDLE_MS;
            vh.postDelayed(this, d);
        }
    };

    private void handle(Supabase.Signal s) {
        if (s.callId.isEmpty()) return;
        switch (s.kind) {
            case "offer":
                if (call != null) {
                    if (!s.callId.equals(call.callId)) {
                        Log.i(TAG, "voz: oferta con llamada en curso -> busy");
                        post(s.callId, "busy", new JSONObject());
                    }
                    return;
                }
                if (cfg.voiceAutoAnswer) {
                    startCall(s);
                } else {
                    pendingOffer = s;
                    pendingAt = SystemClock.elapsedRealtime();
                    SpanishVoice.say(SpanishVoice.LLAMADA);
                    Log.i(TAG, "voz: oferta pendiente (auto_answer=false): F12 para atender");
                }
                break;
            case "ice":
                if (call != null && s.callId.equals(call.callId)) call.addRemoteIce(s.payload);
                break;
            case "hangup":
                if (call != null && s.callId.equals(call.callId)) endCall("colgado por el supervisor", false);
                else if (pendingOffer != null && s.callId.equals(pendingOffer.callId)) pendingOffer = null;
                break;
            default:
                break;
        }
    }

    // ---- llamada ----

    private static synchronized boolean initRtc(Context c) {
        if (!rtcInitDone) {
            rtcInitDone = true;
            try {
                PeerConnectionFactory.initialize(
                        PeerConnectionFactory.InitializationOptions.builder(c).createInitializationOptions());
                rtcInitOk = true;
            } catch (Throwable t) {
                Log.e(TAG, "voz: no se pudo cargar WebRTC: " + t);
            }
        }
        return rtcInitOk;
    }

    private void startCall(Supabase.Signal offer) {
        final String callId = offer.callId;
        String sdp = offer.payload.optString("sdp", "");
        if (sdp.isEmpty()) {
            Log.w(TAG, "voz: oferta sin sdp");
            return;
        }
        if (app.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            Log.e(TAG, "voz: falta RECORD_AUDIO (adb shell pm grant ar.exertion.casco android.permission.RECORD_AUDIO)");
            post(callId, "hangup", new JSONObject());
            return;
        }
        SpanishVoice.say(SpanishVoice.LLAMADA); // antes de marcar inCall
        Call c = new Call(callId);
        call = c;
        inCall = true;
        Log.i(TAG, "voz: llamada entrante, atendiendo");
        try {
            if (!initRtc(app)) throw new IllegalStateException("WebRTC no disponible");
            JSONObject turn = sb.turnCredentials(); // bloqueante, <= ~6 s
            c.open(turn, sdp);
            vh.postDelayed(c.watchdog, WATCHDOG_MS);
            vh.postDelayed(c.maxTimer, MAX_CALL_MS);
        } catch (Throwable t) {
            Log.e(TAG, "voz: no se pudo iniciar la llamada: " + t);
            endCall("error al iniciar", true);
        }
    }

    /** Cierra la llamada actual (idempotente), libera mic/WebRTC/AudioManager y avisa al visor. */
    private void endCall(String why, boolean sendHangup) {
        Call c = call;
        if (c == null) return;
        call = null;
        Log.i(TAG, "voz: llamada finalizada (" + why + ")");
        if (sendHangup) post(c.callId, "hangup", new JSONObject());
        try {
            c.release();
        } finally {
            inCall = false;
            SpanishVoice.say(SpanishVoice.LLAMADA_FIN);
        }
    }

    /** Encola una senal saliente (orden garantizado: ejecutor de un hilo). */
    private void post(String callId, String kind, JSONObject payload) {
        try {
            tx.execute(() -> sb.postSignal(callId, kind, payload));
        } catch (RuntimeException e) {
            Log.w(TAG, "voz: no se pudo encolar " + kind + ": " + e);
        }
    }

    private final class Call {
        final String callId;
        private final AudioManager am = (AudioManager) app.getSystemService(Context.AUDIO_SERVICE);
        private PeerConnectionFactory factory;
        private JavaAudioDeviceModule adm;
        private AudioSource source;
        private AudioTrack track;
        private PeerConnection pc;
        private AudioFocusRequest focus;
        private boolean audioSaved, remoteSet;
        private int savedMode, savedVolume;
        private boolean savedSpeaker;
        private final List<IceCandidate> pendingIce = new ArrayList<>();
        private final Set<String> iceSentKeys = new HashSet<>();
        private int iceSent;
        private final long startedAt = SystemClock.elapsedRealtime();
        private long lastAudioAt = startedAt;
        private long lastPackets = -1;

        final Runnable maxTimer = () -> endCall("tope de 30 min", true);

        final Runnable watchdog = new Runnable() {
            @Override public void run() {
                if (call != Call.this) return;
                long now = SystemClock.elapsedRealtime();
                if (now - lastAudioAt > NO_AUDIO_MS) {
                    endCall("sin audio recibido en " + NO_AUDIO_MS / 1000 + " s", true);
                    return;
                }
                try {
                    pc.getStats(report -> vh.post(() -> onStats(report)));
                } catch (Throwable t) {
                    Log.w(TAG, "voz: getStats: " + t);
                }
                vh.postDelayed(this, WATCHDOG_MS);
            }
        };

        Call(String callId) { this.callId = callId; }

        private void onStats(RTCStatsReport report) {
            if (call != this) return;
            long pk = 0;
            for (RTCStats st : report.getStatsMap().values()) {
                if (!"inbound-rtp".equals(st.getType())) continue;
                Object kind = st.getMembers().get("kind");
                if (kind != null && !"audio".equals(kind.toString())) continue;
                Object v = st.getMembers().get("packetsReceived");
                if (v instanceof Number) pk += ((Number) v).longValue();
            }
            if (pk > lastPackets) {
                lastPackets = pk;
                lastAudioAt = SystemClock.elapsedRealtime();
            }
        }

        void open(JSONObject turn, String offerSdp) {
            setupAudioManager();

            JavaAudioDeviceModule.Builder b = JavaAudioDeviceModule.builder(app)
                    // AEC/NS por software de WebRTC: los de hardware del MediaTek son poco fiables
                    .setUseHardwareAcousticEchoCanceler(false)
                    .setUseHardwareNoiseSuppressor(false);
            adm = b.createAudioDeviceModule();
            factory = PeerConnectionFactory.builder().setAudioDeviceModule(adm).createPeerConnectionFactory();

            MediaConstraints ac = new MediaConstraints();
            ac.mandatory.add(new MediaConstraints.KeyValuePair("googEchoCancellation", "true"));
            ac.mandatory.add(new MediaConstraints.KeyValuePair("googNoiseSuppression", "true"));
            ac.mandatory.add(new MediaConstraints.KeyValuePair("googAutoGainControl", "true"));
            ac.optional.add(new MediaConstraints.KeyValuePair("googHighpassFilter", "true"));
            source = factory.createAudioSource(ac);
            track = factory.createAudioTrack("casco-mic", source);
            track.setEnabled(true);

            PeerConnection.RTCConfiguration rc = new PeerConnection.RTCConfiguration(iceServers(turn));
            rc.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
            rc.continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY;
            pc = factory.createPeerConnection(rc, observer);
            if (pc == null) throw new IllegalStateException("createPeerConnection devolvio null");
            pc.addTrack(track, java.util.Collections.singletonList("casco-stream"));

            pc.setRemoteDescription(new Sdp() {
                @Override public void onSetSuccess() {
                    vh.post(() -> {
                        if (call != Call.this) return;
                        remoteSet = true;
                        for (IceCandidate ic : pendingIce) addIce(ic);
                        pendingIce.clear();
                        answer();
                    });
                }
                @Override public void onSetFailure(String e) { fail("setRemoteDescription: " + e); }
            }, new SessionDescription(SessionDescription.Type.OFFER, offerSdp));
        }

        private void answer() {
            MediaConstraints mc = new MediaConstraints();
            mc.mandatory.add(new MediaConstraints.KeyValuePair("OfferToReceiveAudio", "true"));
            pc.createAnswer(new Sdp() {
                @Override public void onCreateSuccess(SessionDescription sd) {
                    vh.post(() -> {
                        if (call != Call.this) return;
                        try {
                            // la respuesta se encola ANTES de setLocalDescription: los ice salen despues
                            post(callId, "answer", new JSONObject().put("sdp", sd.description));
                            pc.setLocalDescription(new Sdp() {
                                @Override public void onSetFailure(String e) { fail("setLocalDescription: " + e); }
                            }, sd);
                        } catch (Throwable t) {
                            fail("answer: " + t);
                        }
                    });
                }
                @Override public void onCreateFailure(String e) { fail("createAnswer: " + e); }
            }, mc);
        }

        private void fail(String why) {
            vh.post(() -> {
                if (call == Call.this) {
                    Log.e(TAG, "voz: " + why);
                    endCall(why, true);
                }
            });
        }

        void addRemoteIce(JSONObject p) {
            String cand = p.optString("candidate", "");
            if (cand.isEmpty()) return; // fin de candidatos
            IceCandidate ic = new IceCandidate(p.optString("sdpMid", "0"), p.optInt("sdpMLineIndex", 0), cand);
            if (!remoteSet) pendingIce.add(ic);
            else addIce(ic);
        }

        private void addIce(IceCandidate ic) {
            try {
                pc.addIceCandidate(ic);
            } catch (Throwable t) {
                Log.w(TAG, "voz: addIceCandidate: " + t);
            }
        }

        private List<PeerConnection.IceServer> iceServers(JSONObject turn) {
            List<PeerConnection.IceServer> out = new ArrayList<>();
            if (turn == null) {
                Log.w(TAG, "voz: sin credenciales TURN: solo candidatos locales");
                return out;
            }
            try {
                JSONArray urls = turn.getJSONArray("urls");
                List<String> stun = new ArrayList<>(), relay = new ArrayList<>();
                for (int i = 0; i < urls.length(); i++) {
                    String u = urls.getString(i);
                    if (u.startsWith("stun:")) stun.add(u);
                    else if (u.startsWith("turn:") || u.startsWith("turns:")) relay.add(u);
                }
                if (!stun.isEmpty()) out.add(PeerConnection.IceServer.builder(stun).createIceServer());
                if (!relay.isEmpty()) {
                    out.add(PeerConnection.IceServer.builder(relay)
                            .setUsername(turn.getString("username"))
                            .setPassword(turn.getString("credential")).createIceServer());
                }
            } catch (Exception e) {
                Log.w(TAG, "voz: respuesta TURN invalida: " + e);
            }
            return out;
        }

        private final PeerConnection.Observer observer = new PeerConnection.Observer() {
            @Override public void onIceCandidate(IceCandidate ic) {
                vh.post(() -> {
                    if (call != Call.this || iceSent >= MAX_ICE_SENT) return;
                    String key = ic.sdpMid + "|" + ic.sdp;
                    if (!iceSentKeys.add(key)) return; // sin duplicados
                    iceSent++;
                    try {
                        post(callId, "ice", new JSONObject().put("candidate", ic.sdp)
                                .put("sdpMid", ic.sdpMid).put("sdpMLineIndex", ic.sdpMLineIndex));
                    } catch (Exception ignored) { }
                });
            }
            @Override public void onIceConnectionChange(PeerConnection.IceConnectionState s) {
                Log.i(TAG, "voz: ICE " + s);
                if (s == PeerConnection.IceConnectionState.FAILED) fail("ICE fallo");
            }
            @Override public void onSignalingChange(PeerConnection.SignalingState s) { }
            @Override public void onIceConnectionReceivingChange(boolean b) { }
            @Override public void onIceGatheringChange(PeerConnection.IceGatheringState s) { }
            @Override public void onIceCandidatesRemoved(IceCandidate[] c) { }
            @Override public void onAddStream(MediaStream m) { }
            @Override public void onRemoveStream(MediaStream m) { }
            @Override public void onDataChannel(DataChannel d) { }
            @Override public void onRenegotiationNeeded() { }
            @Override public void onAddTrack(RtpReceiver r, MediaStream[] m) { }
        };

        // ---- AudioManager ----

        private void setupAudioManager() {
            savedMode = am.getMode();
            savedSpeaker = am.isSpeakerphoneOn();
            savedVolume = am.getStreamVolume(AudioManager.STREAM_VOICE_CALL);
            audioSaved = true;
            try {
                focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                        .setAudioAttributes(new AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                        .setOnAudioFocusChangeListener(f -> { }).build();
                am.requestAudioFocus(focus);
            } catch (RuntimeException e) {
                Log.w(TAG, "voz: audio focus: " + e);
            }
            am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            am.setSpeakerphoneOn(true);
            am.setMicrophoneMute(false);
            am.setStreamVolume(AudioManager.STREAM_VOICE_CALL,
                    am.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL), 0);
        }

        private void restoreAudioManager() {
            if (!audioSaved) return;
            try { am.setStreamVolume(AudioManager.STREAM_VOICE_CALL, savedVolume, 0); } catch (RuntimeException e) { Log.w(TAG, "voz: restaurar volumen: " + e); }
            try { am.setSpeakerphoneOn(savedSpeaker); } catch (RuntimeException e) { Log.w(TAG, "voz: restaurar altavoz: " + e); }
            try { am.setMode(savedMode); } catch (RuntimeException e) { Log.w(TAG, "voz: restaurar modo: " + e); }
            try { if (focus != null) am.abandonAudioFocusRequest(focus); } catch (RuntimeException e) { Log.w(TAG, "voz: abandonar focus: " + e); }
            audioSaved = false;
        }

        /** Libera todo, cada paso aislado: un fallo no deja el mic ni el AudioManager tomados. */
        void release() {
            vh.removeCallbacks(watchdog);
            vh.removeCallbacks(maxTimer);
            try { if (pc != null) pc.close(); } catch (Throwable t) { Log.w(TAG, "voz: pc.close: " + t); }
            try { if (pc != null) pc.dispose(); } catch (Throwable t) { Log.w(TAG, "voz: pc.dispose: " + t); }
            try { if (track != null) track.dispose(); } catch (Throwable t) { Log.w(TAG, "voz: track.dispose: " + t); }
            try { if (source != null) source.dispose(); } catch (Throwable t) { Log.w(TAG, "voz: source.dispose: " + t); }
            try { if (factory != null) factory.dispose(); } catch (Throwable t) { Log.w(TAG, "voz: factory.dispose: " + t); }
            try { if (adm != null) adm.release(); } catch (Throwable t) { Log.w(TAG, "voz: adm.release: " + t); }
            restoreAudioManager();
        }
    }

    /** SdpObserver con valores por defecto. */
    private static class Sdp implements SdpObserver {
        @Override public void onCreateSuccess(SessionDescription sd) { }
        @Override public void onSetSuccess() { }
        @Override public void onCreateFailure(String e) { }
        @Override public void onSetFailure(String e) { }
    }
}
