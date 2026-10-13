package ar.exertion.casco;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Logica pura (sin Android) de la huella de media (docs/PROTOCOLO-ASISTENCIA.md seccion 7).
 * Testeable con MediaHashCheck. Si el hash falla, fields() devuelve vacio: la evidencia se sube igual.
 */
final class MediaHash {
    private MediaHash() { }

    /** SHA-256 en hex minuscula del archivo, en streaming (64 KB); null si no se pudo leer. */
    static String sha256(File f) {
        try (InputStream in = new FileInputStream(f)) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) md.update(buf, 0, n);
            return hex(md.digest());
        } catch (Exception e) {
            return null;
        }
    }

    static String hex(byte[] d) {
        char[] h = "0123456789abcdef".toCharArray();
        char[] o = new char[d.length * 2];
        for (int i = 0; i < d.length; i++) {
            o[2 * i] = h[(d[i] >> 4) & 0xF];
            o[2 * i + 1] = h[d[i] & 0xF];
        }
        return new String(o);
    }

    /** {sha256, hash_alg, size, captured_at}; vacio si el hash falla (nunca bloquea la subida). */
    static Map<String, Object> fields(File f, long capturedAtMs) {
        Map<String, Object> m = new LinkedHashMap<>();
        String h = sha256(f);
        if (h == null) return m;
        m.put("sha256", h);
        m.put("hash_alg", "sha256");
        m.put("size", f.length());
        m.put("captured_at", Instant.ofEpochMilli(capturedAtMs).toString());
        return m;
    }
}
