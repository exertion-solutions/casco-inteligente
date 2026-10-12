package ar.exertion.casco;

import android.content.Context;

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
        url = j.optString("supabase_url");
        anonKey = j.optString("anon_key");
        email = j.optString("device_email");
        password = j.optString("device_password");
        deviceId = j.optString("device_id", "unknown");
    }

    boolean valid() {
        return !url.isEmpty() && !anonKey.isEmpty() && !email.isEmpty() && !password.isEmpty();
    }

    static Config load(Context c) {
        try {
            File f = new File(c.getExternalFilesDir(null), "config.json");
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            try (FileInputStream in = new FileInputStream(f)) {
                byte[] buf = new byte[4096];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
            return new Config(new JSONObject(out.toString("UTF-8")));
        } catch (Exception e) {
            return null;
        }
    }
}
