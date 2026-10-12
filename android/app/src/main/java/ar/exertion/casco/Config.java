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
 */
final class Config {
    static final String RUNDE_FILES = "/sdcard/Android/data/com.tencent.liteav.demo/files";
    static final long MAX_UPLOAD_BYTES = 25L * 1024 * 1024; // videos mas grandes: solo evento

    final String url, anonKey, email, password, deviceId;

    private Config(JSONObject j) {
        String u = j.optString("supabase_url").trim();
        while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        url = u;
        anonKey = j.optString("anon_key").trim();
        email = j.optString("device_email").trim();
        password = j.optString("device_password"); // sin trim: puede tener espacios
        String id = j.optString("device_id").trim();
        deviceId = id.isEmpty() ? "unknown" : id;
    }

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
