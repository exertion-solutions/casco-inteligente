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

    Supabase(Config cfg) { this.cfg = cfg; }

    private static final class HttpError extends Exception {
        final int code;
        HttpError(int code, String msg) { super(msg); this.code = code; }
    }

    private synchronized String token() throws Exception {
        if (token != null && SystemClock.elapsedRealtime() < tokenExpiresAt - 60_000) return token;
        JSONObject body = new JSONObject().put("email", cfg.email).put("password", cfg.password);
        String res = http("POST", "/auth/v1/token?grant_type=password", "application/json",
                body.toString().getBytes("UTF-8"), null, false);
        JSONObject j = new JSONObject(res);
        token = j.getString("access_token");
        tokenExpiresAt = SystemClock.elapsedRealtime() + j.optLong("expires_in", 3600) * 1000;
        return token;
    }

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
        String bearer = auth ? token() : cfg.anonKey;
        HttpURLConnection c = (HttpURLConnection) new URL(cfg.url + path).openConnection();
        try {
            c.setRequestMethod(method);
            c.setConnectTimeout(10_000);
            c.setReadTimeout(file != null ? 120_000 : 20_000);
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

    /** Inserta un evento en public.events (un intento; el que llama decide reintentos). */
    boolean insertEvent(String type, String keyCode, Integer pressMs, String mediaPath, Integer battery) {
        try {
            JSONObject ev = new JSONObject()
                    .put("device_id", cfg.deviceId)
                    .put("type", type);
            if (keyCode != null) ev.put("key_code", keyCode);
            if (pressMs != null) ev.put("press_ms", pressMs);
            if (mediaPath != null) ev.put("media_path", mediaPath);
            if (battery != null) ev.put("battery", battery);
            call("POST", "/rest/v1/events", "application/json", ev.toString().getBytes("UTF-8"), null);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "insertEvent " + type + " fallo: " + e.getMessage());
            return false;
        }
    }
}
