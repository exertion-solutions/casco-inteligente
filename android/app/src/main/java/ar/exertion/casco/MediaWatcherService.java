package ar.exertion.casco;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.hardware.SensorManager;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.os.PowerManager;
import android.os.SystemClock;
import android.os.BatteryManager;
import android.os.FileObserver;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Servicio en primer plano: observa CapPicture/CapCamera de RundeCap, copia cada archivo nuevo a
 * almacenamiento propio (RundeCap lo borra tras subirlo), lo sube y publica eventos
 * (photo/video/sos/fall/heartbeat) en Supabase.
 *
 * Eventos: TODO evento sale por Outbox (cola en archivo, sobrevive a reinicios). SOS/caida reintentan sin
 * tope y avisan por voz/beep al instante (con o sin red).
 * Hilos: observer = FileObserver (solo copia rapida), h = decisiones (hombre caido, SOS; sin red),
 * net = envio de SOS/caida, bg = heartbeat/polls/envio del resto, up = subidas (lentas),
 * tele = ubicacion/orientacion/poll de carpetas, sensores en su hilo.
 */
public class MediaWatcherService extends Service {
    static final String ACTION_SOS = "ar.exertion.casco.SOS";
    static final String ACTION_WATCHDOG = "ar.exertion.casco.WATCHDOG";
    private static final String TAG = "CascoAgente";
    private static final long HEARTBEAT_MS = 5 * 60_000L;
    private static final long POLL_MS = 5_000L;
    private static final long SPOOL_CAP_BYTES = 200L * 1024 * 1024;
    private static final String[][] DIRS = {{"CapPicture", "photo"}, {"CapCamera", "video"}};

    private HandlerThread hThread, upThread, netThread, bgThread;
    private Handler h, up, net, bg;
    private Outbox outbox;
    private LocationTracker loc;
    private long lastLocFixTime = -1;
    private PowerManager.WakeLock sosWake, upWake;
    private Supabase sb;
    private Config cfg;
    private File spool;
    private FallDetector fall;
    private OrientationTracker orient;
    private ManDownPolicy mandown;
    private VoiceCallManager voiceCall;
    private BroadcastAgent bcast;
    private HandlerThread sensorThread, teleThread;
    private Handler tele;
    private int sensorOrientation = 90;
    private static volatile MediaWatcherService instance;
    private boolean started;
    private final FileObserver[] observers = new FileObserver[DIRS.length]; // referencia viva
    private final Set<String> seen = new HashSet<>();

    @Override
    public void onCreate() {
        super.onCreate();
        goForeground(); // primero: si algo falla despues, igual se cumple startForeground()
        hThread = new HandlerThread("casco-events");
        hThread.start();
        h = new Handler(hThread.getLooper());
        upThread = new HandlerThread("casco-upload");
        upThread.start();
        up = new Handler(upThread.getLooper());
        netThread = new HandlerThread("casco-net", android.os.Process.THREAD_PRIORITY_URGENT_AUDIO);
        netThread.start();
        net = new Handler(netThread.getLooper());
        bgThread = new HandlerThread("casco-bg");
        bgThread.start();
        bg = new Handler(bgThread.getLooper());
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        sosWake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "casco:sos");
        sosWake.setReferenceCounted(false);
        upWake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "casco:upload");
        upWake.setReferenceCounted(false);
        spool = new File(getFilesDir(), "spool");
        spool.mkdirs();
        outbox = new Outbox(new File(getFilesDir(), "outbox.jsonl"));
        outbox.load(); // SOS/caida que no salieron antes de un reinicio del servicio
        instance = this;
        Log.i(TAG, "MediaWatcherService onCreate");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        Log.i(TAG, "MediaWatcherService onStartCommand action=" + action + " started=" + started);
        if (!started) {
            cfg = Config.load(this);
            if (cfg == null || !cfg.valid()) {
                Log.e(TAG, "config.json ausente o incompleto en getExternalFilesDir");
            } else {
                sb = new Supabase(cfg);
                if (checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE)
                        != PackageManager.PERMISSION_GRANTED) {
                    Log.w(TAG, "falta READ_EXTERNAL_STORAGE: otorgar con 'pm grant'; no se veran fotos");
                }
                StreamService.shared = sb;
                recoverSpool();
                armObservers(true);
                if (cfg.streamHost.isEmpty()) {
                    Log.w(TAG, "sin stream_host valido en config.json: video deshabilitado");
                }
                SpanishVoice.promptsOn = cfg.voicePrompts;
                // el TTS siempre: el aviso de emergencia suena aunque voice_prompts sea false
                SpanishVoice.instance = new SpanishVoice(this);
                mandown = new ManDownPolicy(cfg.mandownEnabled, cfg.mandownStillSeconds,
                        cfg.mandownConfirmSeconds, cfg.mandownInactivitySeconds);
                SensorManager smgr = (SensorManager) getSystemService(SENSOR_SERVICE);
                // sensores en su propio hilo: el callback solo hace matematica y despacha a h
                sensorThread = new HandlerThread("casco-sensors");
                sensorThread.start();
                Handler sensH = new Handler(sensorThread.getLooper());
                fall = new FallDetector(smgr, new FallDetector.Callback() {
                    @Override public void onFall(float impact) {
                        h.post(() -> {
                            startLocalStream(); // primero el video (sin red), luego el evento
                            emit("fall", null, null, null, null);
                            handleMandown(mandown.onImpact(SystemClock.elapsedRealtime(), impact));
                        });
                    }
                    @Override public void onWindow(boolean still) {
                        h.post(() -> handleMandown(mandown.update(SystemClock.elapsedRealtime(), still)));
                    }
                });
                if (!fall.start(sensH)) {
                    Log.w(TAG, "sin acelerometro: deteccion de caida deshabilitada");
                }
                orient = new OrientationTracker(smgr);
                if (!orient.start(sensH)) Log.w(TAG, "sin acelerometro: orientacion fija en 0");
                teleThread = new HandlerThread("casco-tele");
                teleThread.start();
                tele = new Handler(teleThread.getLooper());
                tele.post(() -> sensorOrientation = OrientationTracker.readSensorOrientation(this));
                tele.postDelayed(oriTick, 5_000L);
                tele.postDelayed(poll, POLL_MS);
                loc = new LocationTracker(this);
                tele.post(locTick);
                // el poll corre siempre: comandos de video (si hay stream_host) y ordenes del supervisor
                bg.postDelayed(cmdPoll, 5_000L);
                scheduleHeartbeat();
                voiceCall = new VoiceCallManager(this, sb, cfg);
                voiceCall.start();
                if (cfg.broadcastEnabled) {
                    bcast = new BroadcastAgent(this, sb, cfg);
                    bcast.start();
                }
                started = true;
                Log.i(TAG, "agente iniciado device_id=" + cfg.deviceId);
                if (outbox.hasCritical()) { // quedaron SOS/caida de antes del reinicio
                    if (!online()) announceOffline(null);
                    kick(true);
                }
                kick(false);
            }
        }
        WatchdogReceiver.schedule(this); // proxima alarma de vigilancia (~5 min)
        if (ACTION_SOS.equals(action)) {
            final int ms = intent.getIntExtra("press_ms", 0);
            // sin config valida igual se encola: sale cuando el agente logre arrancar (watchdog)
            h.post(() -> {
                startLocalStream();
                if (mandown != null && mandown.onManualSos(SystemClock.elapsedRealtime())
                        == ManDownPolicy.Act.ALERT) {
                    // F11 durante la cuenta regresiva: un solo SOS, con reason manual_en_caida
                    emit("sos", "KEY_F11", ms, null, mandownPayload());
                } else {
                    emit("sos", "KEY_F11", ms, null, null);
                }
            });
        }
        return START_STICKY;
    }

    /** SOS/caida: transmite 120 s sin esperar comando (si hay stream_host y no hay ya una transmision). */
    private void startLocalStream() {
        if (cfg == null || cfg.streamHost.isEmpty() || StreamService.source != StreamPolicy.SRC_NONE) return;
        StreamService.start(this, StreamPolicy.SRC_LOCAL);
    }

    private String lastCmdId;
    private int cmdFails;

    /** Cada 3 s (en bg): ultimo comando de stream -> StreamPolicy decide. Backoff hasta 30 s si falla la red. */
    private final Runnable cmdPoll = new Runnable() {
        @Override public void run() {
            if (sb != null && !cfg.streamHost.isEmpty()) {
                try {
                    String[] c = sb.latestStreamCommand();
                    String id = c == null ? null : c[0];
                    StreamPolicy.Act act = StreamPolicy.decide(id, c == null ? null : c[1], lastCmdId, StreamService.source);
                    if (act == StreamPolicy.Act.START) {
                        Log.i(TAG, "comando start recibido");
                        StreamService.start(MediaWatcherService.this, StreamPolicy.SRC_REMOTE);
                    } else if (act == StreamPolicy.Act.STOP) {
                        Log.i(TAG, "comando stop/vencido: deteniendo transmision");
                        StreamService.stop(MediaWatcherService.this);
                    }
                    if (id != null) lastCmdId = id;
                    if (cmdFails > 0) Log.i(TAG, "poll de comandos recuperado");
                    cmdFails = 0;
                } catch (Exception e) {
                    if (cmdFails++ == 0) Log.w(TAG, "poll de comandos fallo (backoff hasta 30 s): " + e.getMessage());
                }
            }
            // ordenes del supervisor: la red corre en su propio hilo (no demora SOS en h); backoff propio
            if (bcast != null) bcast.tick();
            bg.postDelayed(this, StreamPolicy.pollDelayMs(cmdFails));
        }
    };

    // ---- eventos: cola persistente + envio ----

    /**
     * Cualquier hilo. Persiste el evento (con payload.t y, en SOS/caida, la ultima posicion conocida; sin fix
     * sale igual), avisa por voz si es una emergencia sin red y dispara el envio.
     */
    private void emit(String type, String key, Integer ms, String path, JSONObject payload) {
        emit(type, key, ms, path, payload, null);
    }

    private void emit(String type, String key, Integer ms, String path, JSONObject payload,
                      LocationTracker.Fix fix) {
        boolean crit = AgentPolicy.critical(type);
        Outbox.Entry e = outbox.newEntry(type, System.currentTimeMillis());
        e.key = key;
        if (ms != null) e.pressMs = ms;
        e.path = path;
        Integer b = battery();
        if (b != null) e.battery = b;
        if (fix == null && crit && loc != null) fix = loc.last();
        try {
            JSONObject p = payload != null ? payload : new JSONObject();
            p.put("t", e.t);
            if (fix != null) {
                e.lat = fix.lat;
                e.lng = fix.lng;
                if (crit) {
                    p.put("loc_age_s", fix.ageS());
                    if (fix.hasAcc) p.put("acc", Math.round(fix.acc));
                }
            }
            e.payload = p.toString();
        } catch (Exception ex) {
            e.payload = null;
        }
        if (crit) hold(sosWake, 90_000L);
        outbox.add(e);
        if (AgentPolicy.announces(type) && !online()) announceOffline(e); // al instante, antes de intentar
        kick(crit);
    }

    private void kick(boolean crit) {
        Handler hd = crit ? net : bg;
        Drain d = crit ? drainCritical : drainOther;
        d.holdUntil = 0; // evento nuevo: intentar ya, sin esperar el backoff del anterior
        if (hd != null) hd.post(d);
    }

    /** Envio con backoff propio: criticas en hilo net (sin tope de intentos), el resto en bg (2,5 s entre envios). */
    private final class Drain implements Runnable {
        private final boolean crit;
        private int fails;
        private volatile long holdUntil;

        Drain(boolean crit) { this.crit = crit; }

        @Override public void run() {
            Handler hd = crit ? net : bg;
            hd.removeCallbacks(this);
            long now = SystemClock.elapsedRealtime();
            if (now < holdUntil) { hd.postDelayed(this, holdUntil - now); return; }
            Outbox.Entry e = outbox.next(crit);
            if (e == null) {
                if (crit) drop(sosWake);
                return;
            }
            if (crit) hold(sosWake, 90_000L); // se renueva en cada intento; nunca queda tomado
            int r = send(e);
            if (r == Supabase.EV_OK) {
                fails = 0;
                outbox.done(e);
                Log.i(TAG, "evento " + e.type + " enviado");
                if (AgentPolicy.announces(e.type)) {
                    SpanishVoice.announce(SpanishVoice.EMERGENCIA);
                    if (VoiceCallManager.inCall) beep(); // durante una llamada la voz calla
                }
                hd.postDelayed(this, crit ? 0 : 2_500L); // limite del servidor: 30 por minuto y tipo
            } else if (r == Supabase.EV_REJECTED) {
                if (AgentPolicy.critical(e.type) && !e.stripped) {
                    Log.w(TAG, "evento " + e.type + " rechazado: se reintenta sin posicion ni payload");
                    outbox.strip(e);
                } else {
                    Log.e(TAG, "evento " + e.type + " rechazado por el servidor, se descarta");
                    outbox.done(e);
                }
                hd.post(this);
            } else {
                fails++;
                if (AgentPolicy.announces(e.type)) announceOffline(e);
                long d = AgentPolicy.retryMs(crit, fails);
                holdUntil = SystemClock.elapsedRealtime() + d;
                if (fails == 1 || fails % 10 == 0) {
                    Log.w(TAG, "evento " + e.type + " sin enviar (intento " + fails + "), reintento en " + d + " ms");
                }
                hd.postDelayed(this, d);
            }
        }
    }

    private final Drain drainCritical = new Drain(true), drainOther = new Drain(false);

    private int send(Outbox.Entry e) {
        if (sb == null) return Supabase.EV_RETRY; // config todavia no cargo
        JSONObject p = null;
        try {
            if (e.payload != null) p = new JSONObject(e.payload);
        } catch (Exception ignored) { /* payload ilegible: sale sin el */ }
        return sb.postEvent(e.type, e.key, e.pressMs < 0 ? null : e.pressMs, e.path,
                e.battery < 0 ? null : e.battery, p,
                e.hasPos() ? e.lat : null, e.hasPos() ? e.lng : null);
    }

    private boolean online() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            NetworkInfo ni = cm == null ? null : cm.getActiveNetworkInfo();
            return ni != null && ni.isConnected();
        } catch (RuntimeException ex) {
            return true; // sin dato: no inventar un "sin red"
        }
    }

    /** Voz es-AR + beep ya mismo: el operario sabe que el SOS quedo registrado aunque no haya red. */
    private void announceOffline(Outbox.Entry e) {
        if (e != null) {
            if (e.announcedOffline) return;
            e.announcedOffline = true;
        }
        SpanishVoice.announce(SpanishVoice.EMERGENCIA_SIN_RED);
        beep();
    }

    private void hold(PowerManager.WakeLock w, long ms) {
        try { w.acquire(ms); } catch (RuntimeException ignored) { }
    }

    private void drop(PowerManager.WakeLock w) {
        try { if (w.isHeld()) w.release(); } catch (RuntimeException ignored) { }
    }
    // ---- hombre caido (docs/PROTOCOLO-VOZ.md seccion 6) ----

    /** En h. Ejecuta lo que pide la politica. */
    private void handleMandown(ManDownPolicy.Act act) {
        switch (act) {
            case CONFIRM:
                Log.i(TAG, "hombre caido: CONFIRMANDO (" + mandown.trigger() + ")");
                SpanishVoice.say(SpanishVoice.CAIDA);
                beep();
                break;
            case BEEP:
                beep();
                break;
            case ALERT:
                Log.w(TAG, "hombre caido: ALERTA");
                startLocalStream();
                emit("sos", null, null, null, mandownPayload());
                break;
            case RECOVERED:
                Log.i(TAG, "hombre caido: recuperado por movimiento");
                break;
            case CANCELLED:
                Log.i(TAG, "hombre caido: cancelado");
                break;
            default:
                break;
        }
    }

    private JSONObject mandownPayload() {
        try {
            return new JSONObject().put("reason", mandown.reason())
                    .put("still_s", mandown.stillSeconds())
                    .put("impact", Math.round(mandown.impact() * 10) / 10.0)
                    .put("confirm_s", mandown.confirmSeconds())
                    .put("trigger", mandown.trigger());
        } catch (Exception e) {
            return null;
        }
    }

    private void beep() {
        try {
            final ToneGenerator tg = new ToneGenerator(AudioManager.STREAM_ALARM, 100);
            tg.startTone(ToneGenerator.TONE_PROP_BEEP, 250);
            bg.postDelayed(tg::release, 600);
        } catch (RuntimeException e) {
            Log.w(TAG, "beep: " + e);
        }
    }

    /** F10/F12 (SosKeyService, sin consumir): cancelan la cuenta regresiva de hombre caido. */
    static void onCancelKey() {
        MediaWatcherService s = instance;
        if (s == null || s.h == null) return;
        s.h.post(() -> {
            if (s.mandown != null) s.handleMandown(s.mandown.onCancelButton(SystemClock.elapsedRealtime()));
        });
    }

    // ---- orientacion (docs/PROTOCOLO-VOZ.md seccion 1) ----

    private final ArrayDeque<Long> oriPubs = new ArrayDeque<>();
    private long lastOriPubAt;
    private int lastOriPub = -1;

    /** En tele (nunca en h ni en callbacks de sensores): cada 5 s, solo mientras transmite. */
    private final Runnable oriTick = new Runnable() {
        @Override public void run() {
            try {
                if (StreamService.source != StreamPolicy.SRC_NONE && orient != null && sb != null) {
                    long now = SystemClock.elapsedRealtime();
                    while (!oriPubs.isEmpty() && now - oriPubs.peekFirst() > 60_000L) oriPubs.pollFirst();
                    int o = orient.orientation();
                    if (OrientationMath.shouldPublish(o != lastOriPub, now, lastOriPubAt, oriPubs.size())) {
                        oriPubs.addLast(now);
                        lastOriPubAt = now;
                        lastOriPub = o;
                        final JSONObject p = orientationPayload();
                        final Integer bat = battery();
                        bg.post(() -> sb.insertEvent("heartbeat", null, null, null, bat, p));
                    }
                }
            } catch (RuntimeException e) {
                Log.w(TAG, "orientacion: " + e);
            }
            tele.postDelayed(this, 5_000L);
        }
    };

    // ---- ubicacion (docs/PROTOCOLO-GEO.md seccion 1) ----

    /** SOS/caida pendiente, hombre caido confirmando/en alerta o transmision local de emergencia. */
    private boolean alertActive() {
        ManDownPolicy m = mandown;
        ManDownPolicy.State st = m != null ? m.state() : ManDownPolicy.State.NORMAL;
        return outbox.hasCritical() || StreamService.source == StreamPolicy.SRC_LOCAL
                || st == ManDownPolicy.State.CONFIRMANDO || st == ManDownPolicy.State.ALERTA;
    }

    /** En tele. Evento location cada 60 s (30 s con alerta); sin fix reciente y preciso no publica nada. */
    private final Runnable locTick = new Runnable() {
        @Override public void run() {
            try {
                loc.ensureStarted(teleThread.getLooper());
                LocationTracker.Fix f = loc.last();
                if (f != null && AgentPolicy.fixFresh(f.ageS()) && AgentPolicy.accuracyOk(f.hasAcc, (float) f.acc)
                        && AgentPolicy.newFix(f.time, lastLocFixTime)) {
                    lastLocFixTime = f.time;
                    JSONObject p = new JSONObject().put("acc", Math.round(f.acc)).put("src", "gps");
                    if (f.spd >= 0) p.put("spd", Math.round(f.spd * 10) / 10.0);
                    if (f.brg >= 0) p.put("brg", Math.round(f.brg));
                    if (!Double.isNaN(f.alt)) p.put("alt", Math.round(f.alt));
                    if (f.sats >= 0) p.put("n", f.sats);
                    emit("location", null, null, null, p, f);
                }
            } catch (Exception e) {
                Log.w(TAG, "ubicacion: " + e);
            }
            tele.postDelayed(this, AgentPolicy.locationIntervalMs(alertActive()));
        }
    };
    private JSONObject orientationPayload() {
        try {
            int ori = orient != null ? orient.orientation() : 0;
            JSONObject p = new JSONObject().put("rot", OrientationMath.rot(sensorOrientation, ori))
                    .put("ori", ori).put("sens", sensorOrientation).put("enc", cfg.streamRotation);
            DeviceHealth.addTo(this, p); // bat/chg/temp_c/sig/lvl/net/sim/app/free_mb/up_s (omite lo que falte)
            return p;
        } catch (Exception e) {
            return null;
        }
    }

    // ---- observacion de carpetas de RundeCap ----

    /** Arma (o re-arma si la carpeta recien aparecio) los FileObserver. */
    private void armObservers(boolean firstRun) {
        long now = System.currentTimeMillis();
        for (int i = 0; i < DIRS.length; i++) {
            if (observers[i] != null) continue;
            final File d = new File(Config.RUNDE_FILES, DIRS[i][0]);
            final String type = DIRS[i][1];
            if (!d.isDirectory()) {
                if (firstRun) Log.w(TAG, "carpeta inexistente por ahora: " + d);
                continue;
            }
            // FileObserver(String) esta deprecado en API 29 pero es el unico disponible en minSdk 26
            FileObserver o = new FileObserver(d.getAbsolutePath(), FileObserver.CLOSE_WRITE | FileObserver.MOVED_TO) {
                @Override public void onEvent(int event, String name) {
                    if (name != null) ingest(new File(d, name), type);
                }
            };
            o.startWatching();
            observers[i] = o;
            // lo que ya estaba (hace mas de 60 s) es historico: no se sube
            File[] old = d.listFiles();
            if (old != null) {
                for (File f : old) if (now - f.lastModified() > 60_000L) claim(f);
            }
            Log.i(TAG, "observando " + d);
        }
    }

    /** En tele. Red de seguridad: re-arma carpetas que aparecen tarde y detecta archivos que inotify no avise. */
    private final Runnable poll = new Runnable() {
        @Override public void run() {
            try {
                armObservers(false);
                long now = System.currentTimeMillis();
                for (String[] dt : DIRS) {
                    File[] fs = new File(Config.RUNDE_FILES, dt[0]).listFiles();
                    if (fs == null) continue;
                    long quiet = dt[1].equals("video") ? 10_000L : 3_000L; // no tocar videos en escritura
                    for (File f : fs) if (now - f.lastModified() > quiet) ingest(f, dt[1]);
                }
            } catch (RuntimeException e) {
                Log.w(TAG, "poll: " + e);
            }
            tele.postDelayed(this, POLL_MS);
        }
    };

    private static String ext(String n) {
        n = n.toLowerCase(Locale.ROOT);
        return n.substring(n.lastIndexOf('.') + 1);
    }

    private static boolean wanted(String name, String type) {
        if (name.startsWith(".")) return false; // temporales
        String e = ext(name);
        return type.equals("photo")
                ? (e.equals("jpg") || e.equals("jpeg") || e.equals("png"))
                : (e.equals("mp4") || e.equals("3gp") || e.equals("mkv"));
    }

    /** true la primera vez que se ve este archivo (nombre+tamano). Hilo-seguro. */
    private boolean claim(File f) {
        synchronized (seen) {
            if (seen.size() > 5000) seen.clear(); // ponytail: tope simple, solo duplicaria subidas viejas
            return seen.add(f.getName() + ":" + f.length());
        }
    }

    /**
     * Corre en el hilo del FileObserver (o en h por poll). Copia de inmediato al spool propio porque
     * RundeCap borra el original tras subirlo a su plataforma; la subida va por el hilo up.
     */
    private void ingest(File f, String type) {
        if (!wanted(f.getName(), type) || !f.isFile() || f.length() == 0 || !claim(f)) return;
        final String origName = f.getName();
        Log.i(TAG, "archivo nuevo " + type + ": " + origName + " (" + f.length() + " bytes)");
        if (f.length() > Config.MAX_UPLOAD_BYTES) {
            emit(type, null, null, null, null);
            return;
        }
        final File copy = new File(spool, type + "_" + System.currentTimeMillis() + "_"
                + origName.replaceAll("[^A-Za-z0-9._-]", "_"));
        try {
            copyFile(f, copy);
        } catch (Exception e) {
            // el original ya no esta (RundeCap lo borro antes de poder copiarlo): queda al menos el evento
            Log.w(TAG, "no se pudo copiar " + origName + ": " + e);
            copy.delete();
            emit(type, null, null, null, null);
            return;
        }
        if (type.equals("photo")) SpanishVoice.say(SpanishVoice.FOTO);
        trimSpool();
        up.post(() -> upload(copy, type, origName, 0));
    }

    private static void copyFile(File src, File dst) throws Exception {
        try (InputStream in = new FileInputStream(src); OutputStream out = new FileOutputStream(dst)) {
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        }
    }

    /**
     * En hilo up. La copia del spool NO se borra hasta subirla (RundeCap ya borro el original): reintenta con
     * backoff 30 s .. 10 min mientras haya espacio; si el spool la descarto, sale el evento sin media_path.
     */
    private void upload(File copy, String type, String origName, int attempt) {
        if (!copy.exists()) {
            emit(type, null, null, null, null);
            return;
        }
        hold(upWake, 5 * 60_000L); // wakelock corto solo durante la subida
        String path;
        try {
            path = sb == null ? null : sb.uploadMedia(copy, type, origName);
        } finally {
            drop(upWake);
        }
        if (path == null) {
            long d = AgentPolicy.uploadRetryMs(attempt);
            Log.w(TAG, "subida de " + type + " pendiente (intento " + (attempt + 1) + "), reintento en "
                    + d / 1000 + " s");
            up.postDelayed(() -> upload(copy, type, origName, attempt + 1), d);
            return;
        }
        copy.delete();
        Log.i(TAG, "subida " + origName + " -> " + path);
        emit(type, null, null, path, null);
    }

    /** Tope de espacio del spool: borra las copias mas viejas (FIFO) si pasa de 200 MB. */
    private void trimSpool() {
        synchronized (spool) {
            File[] fs = spool.listFiles();
            if (fs == null) return;
            Arrays.sort(fs, Comparator.comparingLong(File::lastModified));
            long[] sizes = new long[fs.length];
            for (int i = 0; i < fs.length; i++) sizes[i] = fs[i].length();
            int n = AgentPolicy.dropOldest(sizes, SPOOL_CAP_BYTES);
            for (int i = 0; i < n; i++) {
                Log.w(TAG, "spool lleno: se descarta " + fs[i].getName());
                fs[i].delete();
            }
        }
    }
    /** Archivos copiados que quedaron sin subir (reinicio/crash del servicio). Nombre: type_ts_orig. */
    private void recoverSpool() {
        File[] left = spool.listFiles();
        if (left == null) return;
        for (File f : left) {
            String[] p = f.getName().split("_", 3);
            if (p.length < 3 || f.length() == 0) { f.delete(); continue; }
            final String type = p[0], orig = p[2];
            Log.i(TAG, "recuperando del spool: " + f.getName());
            up.post(() -> upload(f, type, orig, 0));
        }
    }

    private void scheduleHeartbeat() {
        bg.postDelayed(new Runnable() {
            @Override public void run() {
                sb.insertEvent("heartbeat", null, null, null, battery(), orientationPayload());
                bg.postDelayed(this, HEARTBEAT_MS);
            }
        }, 10_000L);
    }

    private Integer battery() {
        Intent b = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (b == null) return null;
        int level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
        int scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
        return (level < 0 || scale <= 0) ? null : (level * 100 / scale);
    }

    private void goForeground() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        String ch = "casco";
        nm.createNotificationChannel(new NotificationChannel(ch, "Casco Agente", NotificationManager.IMPORTANCE_MIN));
        Notification n = new Notification.Builder(this, ch)
                .setContentTitle("Casco Agente activo")
                .setSmallIcon(android.R.drawable.ic_menu_camera)
                .build();
        startForeground(1, n);
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onDestroy() {
        Log.i(TAG, "MediaWatcherService onDestroy");
        StreamService.shared = null;
        instance = null;
        if (fall != null) fall.stop();
        if (orient != null) orient.stop();
        if (voiceCall != null) voiceCall.stop();
        if (bcast != null) bcast.stop();
        if (sensorThread != null) sensorThread.quitSafely();
        if (tele != null) tele.removeCallbacksAndMessages(null);
        if (teleThread != null) teleThread.quitSafely();
        if (loc != null) loc.stop();
        if (net != null) net.removeCallbacksAndMessages(null);
        if (bg != null) bg.removeCallbacksAndMessages(null);
        if (netThread != null) netThread.quitSafely();
        if (bgThread != null) bgThread.quitSafely();
        if (sosWake != null) drop(sosWake);
        if (upWake != null) drop(upWake);
        SpanishVoice v = SpanishVoice.instance;
        if (v != null) v.shutdown();
        for (FileObserver o : observers) if (o != null) o.stopWatching();
        if (h != null) h.removeCallbacksAndMessages(null);
        if (hThread != null) hThread.quitSafely();
        if (upThread != null) upThread.quitSafely();
        super.onDestroy();
    }
}
