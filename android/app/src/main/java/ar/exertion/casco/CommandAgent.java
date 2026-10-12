package ar.exertion.casco;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.ImageFormat;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.Log;
import android.util.Size;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Tanda 4 (docs/PROTOCOLO-COMANDOS.md). Toda la logica nueva vive aqui y en las clases puras
 * CommandPolicy / RemoteConfig / WearMonitor / EquipAlerts; MediaWatcherService solo tiene ganchos.
 *
 *  - Comandos a pedido: poll de device_commands (lo dispara pollOnce, cada 3 s), dedupe persistente por id
 *    (filesDir/command_seen.txt, ANTES de ejecutar), foto / linterna / reinicio / ping y device_command_acks.
 *  - Configuracion remota: device_config al iniciar y cada 5 min (por updated_at), copia en filesDir.
 *  - Casco no puesto / inmovilidad (WearMonitor) y alertas de equipo (EquipAlerts) -> eventos por Sink.
 *
 * Hilos: "casco-cmd" (red y acciones rapidas), "casco-photo" (foto: bloquea hasta 10 s), "casco-mon"
 * (config, equipo, sensores de postura). Nada corre en los hilos de sensores ni en h.
 */
final class CommandAgent {
    private static final String TAG = "CascoAgente";
    private static final long CONFIG_EVERY_MS = 5 * 60_000L;
    private static final long EQUIP_EVERY_MS = 30_000L;
    private static final int WARMUP_FRAMES = 6;      // cuadros descartados para que converjan AE/AF
    static final String PROMPT_PHRASE = "¿Está bien? Muévase o presione un botón";

    /** Salida de eventos (MediaWatcherService.emit: cola persistente). Cualquier hilo. */
    interface Sink {
        void emit(String type, String mediaPath, JSONObject payload);
    }

    private final Context app;
    private final Supabase sb;
    private final Config cfg;
    private final Sink sink;
    private final Runnable restart;
    private final File seenFile, cfgFile, spool;
    private final BroadcastPolicy.Seen seen = new BroadcastPolicy.Seen();

    private HandlerThread cmdT, photoT, monT;
    private Handler cmdH, photoH, monH;
    private volatile boolean stopped;

    // poll de comandos (hilo cmd)
    private volatile boolean pending;
    private int fails;
    private long nextPollAt;

    // temporizadores de config/equipo (se evaluan en tick(): elapsedRealtime, inmune a Doze)
    private volatile long lastConfigAt = -CONFIG_EVERY_MS, lastEquipAt;
    private String lastUpdatedAt = "";

    // linterna / camara
    private CameraManager cm;
    private volatile String torchCam;
    private volatile boolean torchOn;
    private final Set<String> unavailable = new HashSet<>();
    private CameraManager.TorchCallback torchCb;

    // postura (hilo mon)
    private final WearMonitor wear = new WearMonitor();
    private final EquipAlerts equip = new EquipAlerts();
    private SensorManager sm;
    private SensorEventListener postureL;
    private volatile boolean flat, deadStill;
    private volatile Boolean near; // null = sin sensor de proximidad
    private float gx, gy, gz;
    private boolean gSeeded;
    private long winStart;
    private int winN;
    private double winSum, winSumSq;
    /** Desvio de |a| por segundo bajo el cual el casco esta apoyado (ruido del sensor ~0,02-0,05 m/s2). */
    private static final double DEAD_STILL_STD = 0.08;

    CommandAgent(Context c, Supabase sb, Config cfg, Sink sink, Runnable restart) {
        this.app = c.getApplicationContext();
        this.sb = sb;
        this.cfg = cfg;
        this.sink = sink;
        this.restart = restart;
        this.seenFile = new File(app.getFilesDir(), "command_seen.txt");
        this.cfgFile = new File(app.getFilesDir(), "device_config.json");
        this.spool = new File(app.getFilesDir(), "spool");
    }

    // ---- ciclo de vida ----

    void start() {
        try {
            seen.load(new String(readAll(seenFile), "UTF-8"));
        } catch (Exception ignored) { /* primer arranque */ }
        loadSavedConfig(); // sin red: la ultima config conocida
        cmdT = new HandlerThread("casco-cmd");
        cmdT.start();
        cmdH = new Handler(cmdT.getLooper());
        photoT = new HandlerThread("casco-photo");
        photoT.start();
        photoH = new Handler(photoT.getLooper());
        monT = new HandlerThread("casco-mon");
        monT.start();
        monH = new Handler(monT.getLooper());
        monH.post(this::startSensors);
        try {
            cm = (CameraManager) app.getSystemService(Context.CAMERA_SERVICE);
            torchCb = new CameraManager.TorchCallback() {
                @Override public void onTorchModeUnavailable(String id) { synchronized (unavailable) { unavailable.add(id); } }
                @Override public void onTorchModeChanged(String id, boolean enabled) {
                    synchronized (unavailable) { unavailable.remove(id); }
                    if (id.equals(torchCam)) torchOn = enabled;
                }
            };
            cm.registerTorchCallback(torchCb, cmdH);
        } catch (RuntimeException e) {
            Log.w(TAG, "linterna: sin CameraManager: " + e);
        }
        Log.i(TAG, "comandos a pedido, config remota y alertas de equipo: activos");
    }

    void stop() {
        stopped = true;
        try {
            if (cm != null && torchCb != null) cm.unregisterTorchCallback(torchCb);
        } catch (RuntimeException ignored) { }
        if (sm != null && postureL != null) sm.unregisterListener(postureL);
        for (Handler h : new Handler[]{cmdH, photoH, monH}) if (h != null) h.removeCallbacksAndMessages(null);
        for (HandlerThread t : new HandlerThread[]{cmdT, photoT, monT}) if (t != null) t.quitSafely();
    }

    /** Desde pollOnce (bg, cada 3 s; o 5 min con el equipo dormido). No bloquea. */
    void tick() {
        if (stopped || cmdH == null) return;
        long now = SystemClock.elapsedRealtime();
        if (now - lastConfigAt >= CONFIG_EVERY_MS) {
            lastConfigAt = now;
            monH.post(this::syncConfig);
        }
        if (now - lastEquipAt >= EQUIP_EVERY_MS) {
            lastEquipAt = now;
            monH.post(this::equipTick);
        }
        if (pending) return;
        pending = true;
        cmdH.post(this::pollOnce);
    }

    // ---- ganchos del servicio ----

    /** Ventana de 1 s de FallDetector (hilo h). suspended = hombre caido en curso. */
    void onWindow(boolean still, boolean suspended) {
        Handler h = monH;
        if (h == null || stopped) return;
        final long now = SystemClock.elapsedRealtime();
        h.post(() -> {
            WearMonitor.Act a = wear.onWindow(now, still, WearMonitor.resting(flat, deadStill, near),
                    RemoteConfig.notWornS(), RemoteConfig.inactivityS(), suspended);
            if (a == WearMonitor.Act.NONE) return;
            try {
                if (a == WearMonitor.Act.PROMPT) {
                    SpanishVoice.say(PROMPT_PHRASE);
                } else if (a == WearMonitor.Act.NOT_WORN) {
                    sink.emit("not_worn", null, new JSONObject().put("still_s", wear.stillSeconds())
                            .put("limit_s", RemoteConfig.notWornS()));
                } else if (a == WearMonitor.Act.INACTIVE) {
                    sink.emit("inactive", null, new JSONObject().put("still_s", wear.stillSeconds())
                            .put("limit_s", RemoteConfig.inactivityS()));
                }
            } catch (Exception e) {
                Log.w(TAG, "wear: " + e);
            }
        });
    }

    /** F10/F12: el operario esta presente. */
    void onButton() {
        Handler h = monH;
        if (h != null && !stopped) h.post(wear::onButton);
    }

    /** El operario cancelo la cuenta regresiva de hombre caido (el contrato agrega `fall_cancel`). */
    void onFallCancel(String trigger) {
        if (stopped) return;
        try {
            JSONObject p = new JSONObject();
            if (trigger != null) p.put("trigger", trigger);
            sink.emit("fall_cancel", null, p);
        } catch (Exception e) {
            Log.w(TAG, "fall_cancel: " + e);
        }
    }

    // ---- comandos (hilo cmd) ----

    private void pollOnce() {
        try {
            long now = SystemClock.elapsedRealtime();
            if (now < nextPollAt) return;
            try {
                List<Supabase.DeviceCommand> list = sb.recentCommands();
                if (fails > 0) Log.i(TAG, "poll de comandos a pedido recuperado");
                fails = 0;
                for (Supabase.DeviceCommand c : list) {
                    if (CommandPolicy.decide(seen, c.id, c.action) != CommandPolicy.Verdict.RUN) continue;
                    persistSeen(); // antes de ejecutar: un reinicio del agente no lo repite
                    Log.i(TAG, "comando a pedido: " + c.action);
                    execute(c);
                }
            } catch (Exception e) {
                if (fails++ == 0) Log.w(TAG, "poll de comandos a pedido fallo (backoff hasta 30 s): " + e.getMessage());
                nextPollAt = SystemClock.elapsedRealtime() + StreamPolicy.pollDelayMs(fails);
            }
        } finally {
            pending = false;
        }
    }

    private void persistSeen() {
        try (FileOutputStream o = new FileOutputStream(seenFile)) {
            o.write(seen.serialize().getBytes("UTF-8"));
        } catch (Exception e) {
            Log.w(TAG, "no se pudo guardar command_seen: " + e);
        }
    }

    /** Ack con hasta 3 intentos (1 s entre ellos). Hilos cmd/photo (pueden bloquear). */
    private void ack(String id, boolean ok, String detail) {
        for (int i = 0; i < 3; i++) {
            if (sb.ackCommand(id, ok, detail)) return;
            try { Thread.sleep(1000); } catch (InterruptedException e) { return; }
        }
    }

    private void execute(Supabase.DeviceCommand c) {
        final long received = SystemClock.elapsedRealtime();
        CommandPolicy.Action a = CommandPolicy.parse(c.action);
        if (a == null) return;
        switch (a) {
            case PING:
                ack(c.id, true, "pong");
                break;
            case TORCH_ON:
            case TORCH_OFF: {
                if (!CommandPolicy.torchAllowed(RemoteConfig.current().torchAllowed)) {
                    ack(c.id, false, "linterna no permitida");
                    break;
                }
                String err = setTorch(a == CommandPolicy.Action.TORCH_ON);
                ack(c.id, err == null, err == null ? (a == CommandPolicy.Action.TORCH_ON ? "linterna encendida"
                        : "linterna apagada") : err);
                break;
            }
            case PHOTO:
                photoH.post(() -> photo(c.id, received));
                break;
            case RESTART_AGENT:
                ack(c.id, true, "reiniciando");
                doRestart();
                break;
            default:
                break;
        }
    }

    /** Alarma que relanza el servicio (WatchdogReceiver) y parada del actual. Sin force-stop. */
    private void doRestart() {
        try {
            AlarmManager am = (AlarmManager) app.getSystemService(Context.ALARM_SERVICE);
            PendingIntent pi = PendingIntent.getBroadcast(app, 7,
                    new Intent(app, WatchdogReceiver.class).setAction(MediaWatcherService.ACTION_WATCHDOG),
                    PendingIntent.FLAG_UPDATE_CURRENT);
            am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP,
                    SystemClock.elapsedRealtime() + 4_000L, pi);
        } catch (RuntimeException e) {
            Log.w(TAG, "restart_agent: no se pudo armar la alarma: " + e);
        }
        Log.w(TAG, "restart_agent: reiniciando el servicio");
        restart.run();
    }

    // ---- linterna ----

    /** Camara trasera (con flash si la hay): id de Camera2; null si no hay. */
    private String backCamera(boolean needFlash) {
        try {
            String any = null;
            for (String id : cm.getCameraIdList()) {
                CameraCharacteristics ch = cm.getCameraCharacteristics(id);
                Integer facing = ch.get(CameraCharacteristics.LENS_FACING);
                if (facing == null || facing != CameraCharacteristics.LENS_FACING_BACK) continue;
                Boolean flash = ch.get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
                if (!needFlash || (flash != null && flash)) return id;
                if (any == null) any = id;
            }
            return needFlash ? null : any;
        } catch (CameraAccessException | RuntimeException e) {
            return null;
        }
    }

    /** null = ok; si no, el detail del ack. */
    private String setTorch(boolean on) {
        if (cm == null) return "sin camara";
        if (StreamService.source != StreamPolicy.SRC_NONE) return "camara ocupada";
        String id = torchCam;
        if (id == null) id = torchCam = backCamera(true);
        if (id == null) return "sin linterna";
        synchronized (unavailable) {
            if (on && unavailable.contains(id)) return "camara ocupada";
        }
        try {
            cm.setTorchMode(id, on);
            torchOn = on;
            return null;
        } catch (CameraAccessException e) {
            return e.getReason() == CameraAccessException.CAMERA_IN_USE ? "camara ocupada" : "linterna no disponible";
        } catch (IllegalArgumentException | SecurityException e) {
            return "linterna no disponible";
        }
    }

    // ---- foto (hilo photo) ----

    private static final class Shot {
        volatile byte[] jpeg;
        volatile String err;
    }

    private void photo(String id, long receivedAt) {
        if (stopped) return;
        if (cm == null || StreamService.source != StreamPolicy.SRC_NONE) {
            ack(id, false, "camara ocupada"); // transmitiendo: la camara es del stream
            return;
        }
        String camId = backCamera(false);
        if (camId == null) { ack(id, false, "sin camara"); return; }
        Shot s = capture(camId);
        if (s.jpeg == null) { ack(id, false, s.err != null ? s.err : "no se pudo sacar la foto"); return; }
        long ts = System.currentTimeMillis();
        spool.mkdirs();
        File f = new File(spool, "photo_" + ts + "_cmd.jpg"); // recoverSpool lo sube si el servicio muere ahora
        try (FileOutputStream o = new FileOutputStream(f)) {
            o.write(s.jpeg);
        } catch (Exception e) {
            f.delete();
            ack(id, false, "no se pudo guardar la foto");
            return;
        }
        SpanishVoice.say(SpanishVoice.FOTO);
        String path = null;
        try {
            for (int i = 0; i < 3 && !stopped; i++) {
                path = sb.uploadMedia(f, "photo", ts + ".jpg");
                if (path != null || !CommandPolicy.photoRetryOk(SystemClock.elapsedRealtime() - receivedAt)) break;
                try { Thread.sleep(4_000L); } catch (InterruptedException e) { break; }
            }
        } finally {
            f.delete(); // el comando vence en 2 min: una foto tardia ya no es la respuesta
        }
        if (path == null) { ack(id, false, "sin red para subir la foto"); return; }
        if (Supabase.UPLOAD_REJECTED.equals(path)) { ack(id, false, "foto rechazada por el servidor"); return; }
        try {
            sink.emit("photo", path, new JSONObject().put("cmd", id));
        } catch (Exception e) {
            Log.w(TAG, "photo: payload: " + e);
        }
        ack(id, true, "foto subida");
    }

    /** Voz (VoiceCommandAgent): linterna. null = ok; si no, el motivo ("camara ocupada", "sin linterna"...). */
    String torchForVoice(boolean on) {
        return setTorch(on);
    }

    /**
     * Voz (VoiceCommandAgent): foto local, la sube y emite el evento photo (payload src=voz). Bloquea hasta ~25 s:
     * llamar desde un hilo propio. null = ok; si no, el motivo. No es un device_command: no hay ack.
     */
    String photoForVoice() {
        if (stopped) return "agente detenido";
        if (cm == null || StreamService.source != StreamPolicy.SRC_NONE) return "camara ocupada";
        String camId = backCamera(false);
        if (camId == null) return "sin camara";
        Shot s = capture(camId);
        if (s.jpeg == null) return s.err != null ? s.err : "no se pudo sacar la foto";
        long ts = System.currentTimeMillis();
        spool.mkdirs();
        File f = new File(spool, "photo_" + ts + "_voz.jpg"); // recoverSpool lo sube si el servicio muere ahora
        try (FileOutputStream o = new FileOutputStream(f)) {
            o.write(s.jpeg);
        } catch (Exception e) {
            f.delete();
            return "no se pudo guardar la foto";
        }
        String path = null;
        try {
            for (int i = 0; i < 3 && !stopped; i++) {
                path = sb.uploadMedia(f, "photo", ts + ".jpg");
                if (path != null) break;
                try { Thread.sleep(4_000L); } catch (InterruptedException e) { break; }
            }
        } finally {
            f.delete();
        }
        if (path == null) return "sin red para subir la foto";
        if (Supabase.UPLOAD_REJECTED.equals(path)) return "foto rechazada por el servidor";
        try {
            sink.emit("photo", path, new JSONObject().put("src", "voz"));
        } catch (Exception e) {
            Log.w(TAG, "photo voz: payload: " + e);
        }
        return null;
    }

    /** Camera2 sin vista previa: JPEG de un ImageReader; descarta WARMUP_FRAMES cuadros para exposicion/enfoque. */
    private Shot capture(String camId) {
        final Shot s = new Shot();
        final CountDownLatch done = new CountDownLatch(1);
        final boolean[] finished = {false};
        final CameraDevice[] dev = new CameraDevice[1];
        final CameraCaptureSession[] ses = new CameraCaptureSession[1];
        HandlerThread ht = new HandlerThread("casco-shot");
        ht.start();
        final Handler hh = new Handler(ht.getLooper());
        ImageReader reader = null;
        try {
            CameraCharacteristics ch = cm.getCameraCharacteristics(camId);
            Size size = pickSize(ch);
            final ImageReader rd = ImageReader.newInstance(size.getWidth(), size.getHeight(), ImageFormat.JPEG, 2);
            reader = rd;
            final int[] frames = {0};
            rd.setOnImageAvailableListener(r -> {
                Image img = null;
                try {
                    img = r.acquireLatestImage();
                    if (img == null) return;
                    if (++frames[0] >= WARMUP_FRAMES && s.jpeg == null) {
                        ByteBuffer b = img.getPlanes()[0].getBuffer();
                        byte[] d = new byte[b.remaining()];
                        b.get(d);
                        s.jpeg = d;
                        done.countDown();
                    }
                } catch (RuntimeException e) {
                    s.err = "error al leer la imagen";
                    done.countDown();
                } finally {
                    if (img != null) img.close();
                }
            }, hh);
            final int jpegRot = OrientationTracker.readSensorOrientation(app);
            final boolean af = hasMode(ch.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES),
                    CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
            cm.openCamera(camId, new CameraDevice.StateCallback() {
                @Override public void onOpened(CameraDevice d) {
                    synchronized (finished) {
                        if (finished[0]) { d.close(); return; }
                        dev[0] = d;
                    }
                    try {
                        d.createCaptureSession(Arrays.asList(rd.getSurface()), new CameraCaptureSession.StateCallback() {
                            @Override public void onConfigured(CameraCaptureSession session) {
                                synchronized (finished) {
                                    if (finished[0]) { session.close(); return; }
                                    ses[0] = session;
                                }
                                try {
                                    CaptureRequest.Builder b = d.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
                                    b.addTarget(rd.getSurface());
                                    if (af) b.set(CaptureRequest.CONTROL_AF_MODE,
                                            CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
                                    b.set(CaptureRequest.JPEG_ORIENTATION, jpegRot);
                                    session.setRepeatingRequest(b.build(), null, hh);
                                } catch (Exception e) {
                                    s.err = "error de camara";
                                    done.countDown();
                                }
                            }
                            @Override public void onConfigureFailed(CameraCaptureSession session) {
                                s.err = "camara ocupada";
                                done.countDown();
                            }
                        }, hh);
                    } catch (Exception e) {
                        s.err = "error de camara";
                        done.countDown();
                    }
                }
                @Override public void onDisconnected(CameraDevice d) {
                    s.err = "camara ocupada";
                    done.countDown();
                }
                @Override public void onError(CameraDevice d, int code) {
                    s.err = code == ERROR_CAMERA_IN_USE || code == ERROR_MAX_CAMERAS_IN_USE
                            ? "camara ocupada" : "error de camara " + code;
                    done.countDown();
                }
            }, hh);
            if (!done.await(10, TimeUnit.SECONDS) && s.jpeg == null && s.err == null) s.err = "tiempo agotado";
        } catch (CameraAccessException e) {
            s.err = e.getReason() == CameraAccessException.CAMERA_IN_USE ? "camara ocupada" : "camara no disponible";
        } catch (SecurityException e) {
            s.err = "sin permiso de camara";
        } catch (InterruptedException e) {
            s.err = "interrumpido";
        } catch (RuntimeException e) {
            s.err = "error de camara";
            Log.w(TAG, "foto: " + e);
        } finally {
            synchronized (finished) { finished[0] = true; }
            try { if (ses[0] != null) ses[0].close(); } catch (RuntimeException ignored) { }
            try { if (dev[0] != null) dev[0].close(); } catch (RuntimeException ignored) { }
            if (reader != null) reader.close();
            ht.quitSafely();
        }
        return s;
    }

    private static boolean hasMode(int[] modes, int m) {
        if (modes == null) return false;
        for (int x : modes) if (x == m) return true;
        return false;
    }

    /** Mayor JPEG de hasta ~2 MP y 1920 de ancho (suficiente para ver la escena y barato de subir). */
    private static Size pickSize(CameraCharacteristics ch) {
        StreamConfigurationMap map = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
        Size[] sizes = map == null ? null : map.getOutputSizes(ImageFormat.JPEG);
        if (sizes == null || sizes.length == 0) return new Size(640, 480);
        Size best = null, smallest = sizes[0];
        for (Size z : sizes) {
            long area = (long) z.getWidth() * z.getHeight();
            if (area < (long) smallest.getWidth() * smallest.getHeight()) smallest = z;
            if (z.getWidth() <= 1920 && area <= 2_100_000L
                    && (best == null || area > (long) best.getWidth() * best.getHeight())) best = z;
        }
        return best != null ? best : smallest;
    }

    // ---- configuracion remota (hilo mon) ----

    private void loadSavedConfig() {
        try {
            JSONObject j = new JSONObject(new String(readAll(cfgFile), "UTF-8"));
            lastUpdatedAt = j.optString("updated_at", "");
            applyConfig(j.optJSONObject("config"), "copia local");
        } catch (Exception ignored) { /* sin copia: config local del config.json */ }
    }

    private void syncConfig() {
        if (stopped) return;
        try {
            JSONArray a = new JSONArray(sb.deviceConfigJson());
            JSONObject row = a.length() > 0 ? a.getJSONObject(0) : null;
            String updated = row == null ? "" : row.optString("updated_at", "");
            if (updated.equals(lastUpdatedAt) && (row != null || cfgFile.exists())) return; // sin cambios
            JSONObject conf = row == null ? new JSONObject() : row.optJSONObject("config");
            applyConfig(conf, "servidor");
            lastUpdatedAt = updated;
            try (FileOutputStream o = new FileOutputStream(cfgFile)) {
                o.write(new JSONObject().put("updated_at", updated).put("config", conf != null ? conf : new JSONObject())
                        .toString().getBytes("UTF-8"));
            }
        } catch (Exception e) {
            Log.w(TAG, "config remota: " + AgentPolicy.redact(e.getMessage())); // sin red: sigue la ultima
        }
    }

    private void applyConfig(JSONObject conf, String origin) {
        Map<String, Object> raw = new HashMap<>();
        if (conf != null) {
            java.util.Iterator<String> it = conf.keys();
            while (it.hasNext()) {
                String k = it.next();
                raw.put(k, conf.opt(k));
            }
        }
        RemoteConfig.Values old = RemoteConfig.current();
        RemoteConfig.Values v = RemoteConfig.parse(raw);
        RemoteConfig.set(v);
        Log.i(TAG, "config remota (" + origin + ") aplicada: " + raw.size() + " claves"
                + (v.rejected.isEmpty() ? "" : ", fuera de rango: " + v.rejected));
        boolean hbChanged = old.heartbeatS == null ? v.heartbeatS != null : !old.heartbeatS.equals(v.heartbeatS);
        if (hbChanged) WatchdogReceiver.scheduleHeartbeat(app); // re-arma la alarma con el periodo nuevo
    }

    // ---- alertas de equipo (hilo mon) ----

    private void equipTick() {
        if (stopped) return;
        try {
            Map<String, Object> m = DeviceHealth.collect(app);
            Integer bat = m.get("bat") instanceof Integer ? (Integer) m.get("bat") : null;
            Boolean chg = m.get("chg") instanceof Boolean ? (Boolean) m.get("chg") : null;
            Double temp = m.get("temp_c") instanceof Double ? (Double) m.get("temp_c") : null;
            Integer lvl = m.get("lvl") instanceof Integer ? (Integer) m.get("lvl") : null;
            String net = m.get("net") instanceof String ? (String) m.get("net") : null;
            Long free = m.get("free_mb") instanceof Long ? (Long) m.get("free_mb") : null;
            for (EquipAlerts.Alert al : equip.update(bat, chg, temp, lvl, net, free)) {
                Log.i(TAG, "equipo: " + al.kind + " (" + al.value + ")");
                sink.emit("equip", null, new JSONObject().put("kind", al.kind).put("level", al.level)
                        .put("value", al.value));
            }
        } catch (Exception e) {
            Log.w(TAG, "equipo: " + e);
        }
    }

    // ---- postura: plano / proximidad (hilo mon) ----

    private void startSensors() {
        try {
            sm = (SensorManager) app.getSystemService(Context.SENSOR_SERVICE);
            Sensor acc = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
            Sensor prox = sm.getDefaultSensor(Sensor.TYPE_PROXIMITY);
            postureL = new SensorEventListener() {
                @Override public void onSensorChanged(SensorEvent e) {
                    if (e.sensor.getType() == Sensor.TYPE_PROXIMITY) {
                        near = e.values[0] < Math.min(e.sensor.getMaximumRange(), 5f);
                        return;
                    }
                    final float k = 0.2f;
                    if (!gSeeded) { gx = e.values[0]; gy = e.values[1]; gz = e.values[2]; gSeeded = true; }
                    else { gx += k * (e.values[0] - gx); gy += k * (e.values[1] - gy); gz += k * (e.values[2] - gz); }
                    float n = (float) Math.sqrt(gx * gx + gy * gy + gz * gz);
                    flat = n > 1f && Math.abs(gz) / n > 0.85f; // eje de la camara casi vertical: apoyado
                    double mag = Math.sqrt((double) e.values[0] * e.values[0] + e.values[1] * e.values[1]
                            + e.values[2] * e.values[2]);
                    long t = SystemClock.elapsedRealtime();
                    if (winStart == 0) winStart = t;
                    winSum += mag; winSumSq += mag * mag; winN++;
                    if (t - winStart >= 1000) {
                        if (winN >= 4) {
                            double mean = winSum / winN;
                            deadStill = Math.sqrt(Math.max(0, winSumSq / winN - mean * mean)) < DEAD_STILL_STD;
                        }
                        winStart = t; winN = 0; winSum = winSumSq = 0;
                    }
                }
                @Override public void onAccuracyChanged(Sensor sensor, int accuracy) { }
            };
            if (acc != null) sm.registerListener(postureL, acc, SensorManager.SENSOR_DELAY_UI, monH);
            else Log.w(TAG, "wear: sin acelerometro, no_worn/inactive deshabilitados");
            if (prox != null) sm.registerListener(postureL, prox, SensorManager.SENSOR_DELAY_NORMAL, monH);
        } catch (RuntimeException e) {
            Log.w(TAG, "wear: sensores: " + e);
        }
    }

    private static byte[] readAll(File f) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        }
        return out.toByteArray();
    }
}
