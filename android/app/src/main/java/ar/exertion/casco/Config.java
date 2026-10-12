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
 * Voz y hombre caido (docs/PROTOCOLO-VOZ.md, ver android/README-VOZ.md): voice_prompts (true),
 * voice_auto_answer (true), mandown_enabled (true), mandown_still_seconds (15),
 * mandown_confirm_seconds (10), mandown_inactivity_seconds (0 = desactivado).
 * Centro (docs/PROTOCOLO-CENTRO.md): broadcast_enabled (true), broadcast_volume (0-100, 100),
 * stream_audio (false), stream_ingest_path ("live").
 */
final class Config {
    static final String RUNDE_FILES = "/sdcard/Android/data/com.tencent.liteav.demo/files";
    static final long MAX_UPLOAD_BYTES = 25L * 1024 * 1024; // videos mas grandes: solo evento

    final String url, anonKey, email, password, deviceId;
    /** "host" o "host:puerto" validado; "" si falta o es invalido (no se transmite). */
    final String streamHost;
    final int streamWidth, streamHeight, streamFps, streamBitrateKbps, streamRotation;
    final boolean voicePrompts, voiceAutoAnswer, mandownEnabled;
    final int mandownStillSeconds, mandownConfirmSeconds, mandownInactivitySeconds;
    final boolean broadcastEnabled, streamAudio;
    final int broadcastVolume;
    /** Prefijo de ruta RTMP validado ("live" por defecto). Con audio se publica en "ingest" (ver StreamPolicy). */
    final String streamIngestPath;

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
        voicePrompts = j.optBoolean("voice_prompts", true);
        voiceAutoAnswer = j.optBoolean("voice_auto_answer", true);
        mandownEnabled = j.optBoolean("mandown_enabled", true);
        mandownStillSeconds = clamp(j.optInt("mandown_still_seconds", 15), 5, 120);
        mandownConfirmSeconds = clamp(j.optInt("mandown_confirm_seconds", 10), 5, 60);
        int ina = j.optInt("mandown_inactivity_seconds", 0);
        mandownInactivitySeconds = ina <= 0 ? 0 : clamp(ina, 30, 600);
        broadcastEnabled = j.optBoolean("broadcast_enabled", true);
        broadcastVolume = clamp(j.optInt("broadcast_volume", 100), 0, 100);
        streamAudio = j.optBoolean("stream_audio", false);
        String ip = j.optString("stream_ingest_path", "live").trim();
        streamIngestPath = ip.matches("[A-Za-z0-9_-]{1,32}") ? ip : "live";
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
