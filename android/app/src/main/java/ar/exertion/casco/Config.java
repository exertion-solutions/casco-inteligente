package ar.exertion.casco;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;

/**
 * Lee config.json desde el almacenamiento propio de la app (no va al repo):
 * /sdcard/Android/data/ar.exertion.casco/files/config.json
 * {"supabase_url":"https://xxx.supabase.co","anon_key":"...","device_email":"...",
 *  "device_password":"...","device_id":"4132"}
 * Video (opcionales salvo stream_host): stream_host, stream_width, stream_height, stream_fps,
 * stream_bitrate_kbps (+ stream_rotation 0/90/180/270, por defecto 0).
 */
final class Config {
    static final String RUNDE_FILES = "/sdcard/Android/data/com.tencent.liteav.demo/files";
    static final long MAX_UPLOAD_BYTES = 25L * 1024 * 1024; // videos mas grandes: solo evento

    final String url, anonKey, email, password, deviceId;
    /** "host" o "host:puerto" validado; "" si falta o es invalido (no se transmite). */
    final String streamHost;
    final int streamWidth, streamHeight, streamFps, streamBitrateKbps, streamRotation;

    private Config(JSONObject j) {
        String u = j.optString("supabase_url").trim();
        while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        url = u;
        anonKey = j.optString("anon_key").trim();
        email = j.optString("device_email").trim();
        password = j.optString("device_password"); // sin trim: puede tener espacios
        String id = j.optString("device_id").trim();
        deviceId = id.isEmpty() ? "unknown" : id;
        String host = j.optString("stream_host").trim();
        streamHost = host.matches("[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?") ? host : "";
        streamWidth = clamp(j.optInt("stream_width", 640), 160, 1920);
        streamHeight = clamp(j.optInt("stream_height", 480), 120, 1080);
        streamFps = clamp(j.optInt("stream_fps", 15), 5, 30);
        streamBitrateKbps = clamp(j.optInt("stream_bitrate_kbps", 800), 100, 4000);
        int r = j.optInt("stream_rotation", 0);
        streamRotation = (r == 90 || r == 180 || r == 270) ? r : 0;
    }

    private static int clamp(int v, int lo, int hi) { return Math.max(lo, Math.min(hi, v)); }

    boolean valid() {
        return url.startsWith("https://") && !anonKey.isEmpty() && !email.isEmpty() && !password.isEmpty();
    }

    /** null si falta el archivo, no se puede leer o no es JSON. Nunca loguea el contenido. */
    static Config load(Context c) {
        try {
            File dir = c.getExternalFilesDir(null);
            if (dir == null) {
                Log.e("CascoAgente", "almacenamiento externo no disponible");
                return null;
            }
            File f = new File(dir, "config.json");
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            try (FileInputStream in = new FileInputStream(f)) {
                byte[] buf = new byte[4096];
                int n;
                while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
            }
            String s = out.toString("UTF-8");
            if (s.startsWith("﻿")) s = s.substring(1); // BOM de editores Windows
            return new Config(new JSONObject(s));
        } catch (Exception e) {
            Log.e("CascoAgente", "config.json no se pudo leer: " + e.getClass().getSimpleName());
            return null;
        }
    }
}
