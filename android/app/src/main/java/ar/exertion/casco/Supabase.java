package ar.exertion.casco;

import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Cliente minimo de Supabase (Auth + REST + Storage) con HttpURLConnection. */
final class Supabase {
    private static final String TAG = "CascoAgente";
    private final Config cfg;
    private String token;
    private long tokenExpiresAt;

    Supabase(Config cfg) { this.cfg = cfg; }

    private synchronized String token() throws Exception {
        if (token != null && System.currentTimeMillis() < tokenExpiresAt - 60_000) return token;
        JSONObject body = new JSONObject().put("email", cfg.email).put("password", cfg.password);
        String res = request("POST", "/auth/v1/token?grant_type=password", body.toString().getBytes("UTF-8"),
                "application/json", false);
        JSONObject j = new JSONObject(res);
        token = j.getString("access_token");
        tokenExpiresAt = System.currentTimeMillis() + j.optLong("expires_in", 3600) * 1000;
        return token;
    }

    private String request(String method, String path, byte[] body, String contentType, boolean auth) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(cfg.url + path).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(15_000);
        c.setReadTimeout(60_000);
        c.setRequestProperty("apikey", cfg.anonKey);
        c.setRequestProperty("Authorization", "Bearer " + (auth ? token() : cfg.anonKey));
        if (body != null) {
            c.setRequestProperty("Content-Type", contentType);
            c.setDoOutput(true);
            try (OutputStream o = c.getOutputStream()) { o.write(body); }
        }
        int code = c.getResponseCode();
        InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        if (in != null) {
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
        String text = out.toString("UTF-8");
        if (code >= 400) throw new Exception("HTTP " + code + " " + path + " " + text);
        return text;
    }

    /** Sube un archivo al bucket y devuelve la ruta (o null si falla). */
    String uploadMedia(File f, String prefix) {
        try {
            String path = cfg.deviceId + "/" + prefix + "/" + System.currentTimeMillis() + "_" + f.getName();
            HttpURLConnection c = (HttpURLConnection) new URL(cfg.url + "/storage/v1/object/casco-media/" + path).openConnection();
            c.setRequestMethod("POST");
            c.setConnectTimeout(15_000);
            c.setReadTimeout(120_000);
            c.setFixedLengthStreamingMode(f.length());
            c.setRequestProperty("apikey", cfg.anonKey);
            c.setRequestProperty("Authorization", "Bearer " + token());
            c.setRequestProperty("Content-Type", f.getName().endsWith(".mp4") ? "video/mp4" : "image/jpeg");
            c.setDoOutput(true);
            try (InputStream in = new FileInputStream(f); OutputStream o = c.getOutputStream()) {
                byte[] buf = new byte[16 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
            }
            int code = c.getResponseCode();
            if (code >= 400) { Log.w(TAG, "upload HTTP " + code); return null; }
            return path;
        } catch (Exception e) {
            Log.w(TAG, "upload fallo: " + e);
            return null;
        }
    }

    /** Inserta un evento en public.events. Reintenta una vez. */
    boolean insertEvent(String type, String keyCode, Integer pressMs, String mediaPath, Integer battery) {
        for (int attempt = 0; attempt < 2; attempt++) {
            try {
                JSONObject ev = new JSONObject()
                        .put("device_id", cfg.deviceId)
                        .put("type", type);
                if (keyCode != null) ev.put("key_code", keyCode);
                if (pressMs != null) ev.put("press_ms", pressMs);
                if (mediaPath != null) ev.put("media_path", mediaPath);
                if (battery != null) ev.put("battery", battery);
                request("POST", "/rest/v1/events", ev.toString().getBytes("UTF-8"), "application/json", true);
                return true;
            } catch (Exception e) {
                Log.w(TAG, "insertEvent intento " + attempt + ": " + e);
                synchronized (this) { token = null; }
            }
        }
        return false;
    }
}
