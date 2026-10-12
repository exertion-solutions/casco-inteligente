package ar.exertion.casco;

import android.os.SystemClock;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;

/**
 * Cliente minimo de Supabase (Auth + REST + Storage) con HttpURLConnection.
 * Metodos bloqueantes: llamar desde hilos de fondo. Nunca loguea password ni token.
 */
final class Supabase {
    private static final String TAG = "CascoAgente";
    private static final String BUCKET = "casco-media";
    private final Config cfg;
    private String token;
    private long tokenExpiresAt; // elapsedRealtime
    private volatile long serverOffsetMs;  // servidor - casco (ms), de la cabecera Date

    Supabase(Config cfg) { this.cfg = cfg; }

    private static final class HttpError extends Exception {
        final int code;
        HttpError(int code, String msg) { super(msg); this.code = code; }
    }

    private synchronized String token() throws Exception { return token(60_000); }

    private synchronized String token(long minRemainingMs) throws Exception {
        if (token != null && SystemClock.elapsedRealtime() < tokenExpiresAt - minRemainingMs) return token;
        JSONObject body = new JSONObject().put("email", cfg.email).put("password", cfg.password);
        String res = http("POST", "/auth/v1/token?grant_type=password", "application/json",
                body.toString().getBytes("UTF-8"), null, false);
        JSONObject j = new JSONObject(res);
        token = j.getString("access_token");
        tokenExpiresAt = SystemClock.elapsedRealtime() + j.optLong("expires_in", 3600) * 1000;
        return token;
    }

    /** Access token vigente (para RTMP pass=); se renueva si le quedan menos de 5 min. Bloqueante. */
    String accessToken() throws Exception { return token(5 * 60_000L); }

    private synchronized void invalidateToken() { token = null; }

    /** Una llamada autenticada; ante 401 renueva el token y reintenta una vez. */
    private String call(String method, String path, String contentType, byte[] body, File file) throws Exception {
        try {
            return http(method, path, contentType, body, file, true);
        } catch (HttpError e) {
            if (e.code != 401) throw e;
            invalidateToken();
            return http(method, path, contentType, body, file, true);
        }
    }

    private String http(String method, String path, String contentType, byte[] body, File file, boolean auth)
            throws Exception {
        return http(method, path, contentType, body, file, auth, 10_000, file != null ? 120_000 : 20_000);
    }

    private String http(String method, String path, String contentType, byte[] body, File file, boolean auth,
                        int connectMs, int readMs) throws Exception {
        String bearer = auth ? token() : cfg.anonKey;
        HttpURLConnection c = (HttpURLConnection) new URL(cfg.url + path).openConnection();
        try {
            c.setRequestMethod(method);
            c.setConnectTimeout(connectMs);
            c.setReadTimeout(readMs);
            c.setRequestProperty("apikey", cfg.anonKey);
            c.setRequestProperty("Authorization", "Bearer " + bearer);
            c.setRequestProperty("Prefer", "return=minimal");
            if (body != null || file != null) {
                c.setRequestProperty("Content-Type", contentType);
                c.setDoOutput(true);
                c.setFixedLengthStreamingMode(file != null ? file.length() : body.length);
                try (OutputStream o = c.getOutputStream()) {
                    if (file != null) {
                        try (InputStream in = new FileInputStream(file)) {
                            byte[] buf = new byte[16 * 1024];
                            int n;
                            while ((n = in.read(buf)) != -1) o.write(buf, 0, n);
                        }
                    } else {
                        o.write(body);
                    }
                }
            }
            int code = c.getResponseCode();
            long date = c.getDate(); // reloj del servidor: el del casco puede estar corrido
            if (date > 0) serverOffsetMs = date - System.currentTimeMillis();
            InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            if (in != null) {
                try (InputStream is = in) {
                    byte[] buf = new byte[4096];
                    int n;
                    while ((n = is.read(buf)) != -1) out.write(buf, 0, n);
                }
            }
            String text = out.toString("UTF-8");
            if (code >= 400) {
                if (text.length() > 200) text = text.substring(0, 200);
                throw new HttpError(code, "HTTP " + code + " " + method + " " + path.split("\\?")[0] + " " + text);
            }
            return text;
        } finally {
            c.disconnect();
        }
    }

    private static String clean(String s) { return s.replaceAll("[^A-Za-z0-9._-]", "_"); }

    private static String contentTypeOf(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        if (n.endsWith(".mp4")) return "video/mp4";
        if (n.endsWith(".3gp")) return "video/3gpp";
        if (n.endsWith(".mkv")) return "video/x-matroska";
        if (n.endsWith(".png")) return "image/png";
        return "image/jpeg";
    }

    /**
     * Sube un archivo al bucket y devuelve la ruta (o null si falla). La ruta se sanea a
     * [A-Za-z0-9._-] para que sea valida en URL y en Storage (nombres con espacios, tildes, etc.).
     */
    String uploadMedia(File f, String type, String origName) {
        try {
            String name = clean(origName);
            String path = clean(cfg.deviceId) + "/" + type + "/" + System.currentTimeMillis() + "_" + name;
            call("POST", "/storage/v1/object/" + BUCKET + "/" + path, contentTypeOf(name), null, f);
            return path;
        } catch (Exception e) {
            Log.w(TAG, "upload fallo: " + e.getMessage());
            return null;
        }
    }

    /**
     * Ultimo comando de stream de este dispositivo (RLS ya filtra a los ultimos 2 min).
     * Devuelve {id, action}, o null si no hay ninguno vigente. Lanza excepcion ante error de red/HTTP.
     * Timeouts cortos: corre en el hilo de eventos cada 3 s y no debe demorar un SOS.
     */
    String[] latestStreamCommand() throws Exception {
        String path = "/rest/v1/stream_commands?select=id,action&device_id=eq."
                + java.net.URLEncoder.encode(cfg.deviceId, "UTF-8") + "&order=created_at.desc&limit=1";
        String res;
        try {
            res = http("GET", path, null, null, null, true, 4_000, 6_000);
        } catch (HttpError e) {
            if (e.code != 401) throw e;
            invalidateToken();
            res = http("GET", path, null, null, null, true, 4_000, 6_000);
        }
        org.json.JSONArray a = new org.json.JSONArray(res);
        if (a.length() == 0) return null;
        JSONObject o = a.getJSONObject(0);
        return new String[]{o.optString("id"), o.optString("action")};
    }

    /** Inserta un evento en public.events (un intento; el que llama decide reintentos). */
    boolean insertEvent(String type, String keyCode, Integer pressMs, String mediaPath, Integer battery) {
        return insertEvent(type, keyCode, pressMs, mediaPath, battery, null);
    }

    /** Igual que arriba con payload jsonb (objeto, <= 2 KB: lo exige events_payload_ck). */
    boolean insertEvent(String type, String keyCode, Integer pressMs, String mediaPath, Integer battery,
                        JSONObject payload) {
        try {
            JSONObject ev = new JSONObject()
                    .put("device_id", cfg.deviceId)
                    .put("type", type);
            if (keyCode != null) ev.put("key_code", keyCode);
            if (pressMs != null) ev.put("press_ms", pressMs);
            if (mediaPath != null) ev.put("media_path", mediaPath);
            if (battery != null) ev.put("battery", battery);
            if (payload != null) {
                if (payload.toString().getBytes("UTF-8").length > 2048) {
                    Log.w(TAG, "insertEvent " + type + ": payload > 2 KB, se omite");
                } else {
                    ev.put("payload", payload);
                }
            }
            call("POST", "/rest/v1/events", "application/json", ev.toString().getBytes("UTF-8"), null);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "insertEvent " + type + " fallo: " + e.getMessage());
            return false;
        }
    }

    // ---- voz (rtc_signals + turn-credentials) ----

    /** GET autenticado con timeouts cortos (4 s/6 s); ante 401 renueva el token y reintenta una vez. */
    private String getShort(String path) throws Exception {
        try {
            return http("GET", path, null, null, null, true, 4_000, 6_000);
        } catch (HttpError e) {
            if (e.code != 401) throw e;
            invalidateToken();
            return http("GET", path, null, null, null, true, 4_000, 6_000);
        }
    }

    /** Una senal de rtc_signals enviada por el visor. */
    static final class Signal {
        final String id, callId, kind;
        final JSONObject payload;
        Signal(String id, String callId, String kind, JSONObject payload) {
            this.id = id; this.callId = callId; this.kind = kind; this.payload = payload;
        }
    }

    private static final java.text.SimpleDateFormat ISO = isoFormat();
    private static java.text.SimpleDateFormat isoFormat() {
        java.text.SimpleDateFormat f = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US);
        f.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return f;
    }

    /**
     * Senales del visor para este casco de los ultimos {@code windowMs} (hora del servidor), en orden.
     * Timeouts cortos. Lanza excepcion ante error de red/HTTP.
     */
    java.util.List<Signal> viewerSignals(long windowMs) throws Exception {
        String since;
        synchronized (ISO) {
            since = ISO.format(new java.util.Date(System.currentTimeMillis() + serverOffsetMs - windowMs));
        }
        String path = "/rest/v1/rtc_signals?select=id,call_id,kind,payload&device_id=eq."
                + java.net.URLEncoder.encode(cfg.deviceId, "UTF-8")
                + "&from_role=eq.viewer&order=created_at.asc&created_at=gte." + since;
        org.json.JSONArray a = new org.json.JSONArray(getShort(path));
        java.util.ArrayList<Signal> out = new java.util.ArrayList<>();
        for (int i = 0; i < a.length(); i++) {
            JSONObject o = a.getJSONObject(i);
            JSONObject p = o.optJSONObject("payload");
            out.add(new Signal(o.optString("id"), o.optString("call_id"), o.optString("kind"),
                    p != null ? p : new JSONObject()));
        }
        return out;
    }

    /** Publica una senal del casco (answer/ice/hangup/busy). El device no puede leerla: sin .select(). */
    boolean postSignal(String callId, String kind, JSONObject payload) {
        try {
            JSONObject r = new JSONObject()
                    .put("device_id", cfg.deviceId)
                    .put("call_id", callId)
                    .put("kind", kind)
                    .put("payload", payload != null ? payload : new JSONObject());
            call("POST", "/rest/v1/rtc_signals", "application/json", r.toString().getBytes("UTF-8"), null);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "rtc_signals " + kind + " fallo: " + e.getMessage());
            return false;
        }
    }

    /** Credenciales TURN temporales ({urls, username, credential, ttl}) o null si falla. Nunca loguear el valor. */
    JSONObject turnCredentials() {
        try {
            return new JSONObject(getShort("/functions/v1/turn-credentials"));
        } catch (Exception e) {
            Log.w(TAG, "turn-credentials fallo: " + e.getMessage());
            return null;
        }
    }

    // ---- ordenes del supervisor (broadcasts + broadcast_acks, docs/PROTOCOLO-CENTRO.md seccion 4) ----

    /** Una orden de public.broadcasts dirigida a este casco (ya filtrada por device_ids). */
    static final class Broadcast {
        final String id, kind, message;
        final int repeat;
        Broadcast(String id, String kind, String message, int repeat) {
            this.id = id; this.kind = kind; this.message = message; this.repeat = repeat;
        }
    }

    /**
     * Ordenes de los ultimos 2 min (hora del servidor) en orden de creacion. Filtra device_ids (null o contiene
     * este casco). Timeouts cortos. Lanza excepcion ante error de red/HTTP.
     */
    java.util.List<Broadcast> recentBroadcasts() throws Exception {
        String since = BroadcastPolicy.isoUtc(System.currentTimeMillis() + serverOffsetMs - BroadcastPolicy.WINDOW_MS);
        String path = "/rest/v1/broadcasts?select=id,kind,message,device_ids,repeat&created_at=gte." + since
                + "&order=created_at.asc";
        org.json.JSONArray a = new org.json.JSONArray(getShort(path));
        java.util.ArrayList<Broadcast> out = new java.util.ArrayList<>();
        for (int i = 0; i < a.length(); i++) {
            JSONObject o = a.getJSONObject(i);
            java.util.List<String> ids = null;
            org.json.JSONArray d = o.optJSONArray("device_ids");
            if (d != null) {
                ids = new java.util.ArrayList<>();
                for (int k = 0; k < d.length(); k++) ids.add(d.optString(k));
            }
            if (!BroadcastPolicy.targets(ids, cfg.deviceId)) continue;
            out.add(new Broadcast(o.optString("id"), o.optString("kind"), o.optString("message", ""),
                    BroadcastPolicy.clampRepeat(o.optInt("repeat", 3))));
        }
        return out;
    }

    /**
     * Ack de recepcion AL INICIAR la reproduccion (la policy solo acepta acks de ordenes de < 2 min).
     * Solo {broadcast_id, device_id}; Prefer: return=minimal ya va en toda llamada (el device no puede leer
     * lo que inserta). 409 = ya registrado = exito.
     */
    boolean ackBroadcast(String broadcastId) {
        try {
            JSONObject r = new JSONObject().put("broadcast_id", broadcastId).put("device_id", cfg.deviceId);
            call("POST", "/rest/v1/broadcast_acks", "application/json", r.toString().getBytes("UTF-8"), null);
            return true;
        } catch (HttpError e) {
            if (e.code == 409) return true;
            Log.w(TAG, "broadcast_acks fallo: " + e.getMessage());
            return false;
        } catch (Exception e) {
            Log.w(TAG, "broadcast_acks fallo: " + e.getMessage());
            return false;
        }
    }
}
