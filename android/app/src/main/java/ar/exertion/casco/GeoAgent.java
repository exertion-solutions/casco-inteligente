package ar.exertion.casco;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Zonas del casco: geofences + geo_points 'peligro' (docs/PROTOCOLO-GEO.md). Descarga (REST), cache en
 * filesDir/geo_cache.json (sirve sin red, tambien tras reiniciar) y parseo a GeoPolicy.Zone.
 * refresh() bloquea (red): llamarlo desde un hilo de fondo. zones() es seguro desde cualquier hilo.
 */
final class GeoAgent {
    private static final String TAG = "CascoAgente";

    private final Supabase sb;
    private final String deviceId;
    private final File cache;
    private volatile List<GeoPolicy.Zone> zones = Collections.emptyList();

    GeoAgent(Supabase sb, String deviceId, File filesDir) {
        this.sb = sb;
        this.deviceId = deviceId;
        this.cache = new File(filesDir, "geo_cache.json");
    }

    List<GeoPolicy.Zone> zones() { return zones; }

    /** Carga el cache local (si existe). */
    void loadCache() {
        try {
            if (!cache.isFile()) return;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            try (FileInputStream in = new FileInputStream(cache)) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
            }
            JSONObject j = new JSONObject(out.toString("UTF-8"));
            zones = parse(j.optJSONArray("fences"), j.optJSONArray("points"));
            Log.i(TAG, "geocercas: " + zones.size() + " zonas del cache");
        } catch (Exception e) {
            Log.w(TAG, "geocercas: cache ilegible: " + e);
        }
    }

    /** true si descargo y actualizo; false (y conserva lo anterior) ante error de red/HTTP. */
    boolean refresh() {
        try {
            JSONArray f = new JSONArray(sb.geofencesJson());
            JSONArray p = new JSONArray(sb.dangerPointsJson());
            List<GeoPolicy.Zone> z = parse(f, p);
            zones = z;
            File tmp = new File(cache.getPath() + ".tmp");
            try (FileOutputStream o = new FileOutputStream(tmp)) {
                o.write(new JSONObject().put("fences", f).put("points", p).toString().getBytes("UTF-8"));
            }
            Files.move(tmp.toPath(), cache.toPath(), StandardCopyOption.REPLACE_EXISTING);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "geocercas: descarga fallo (se usa lo que hay): " + AgentPolicy.redact(e.getMessage()));
            return false;
        }
    }

    /** Fila a fila: una zona mal formada se omite, no tira las demas. */
    List<GeoPolicy.Zone> parse(JSONArray fences, JSONArray points) {
        List<GeoPolicy.Zone> out = new ArrayList<>();
        if (fences != null) for (int i = 0; i < fences.length(); i++) {
            try { addFence(out, fences.getJSONObject(i)); } catch (Exception ignored) { /* fila invalida */ }
        }
        if (points != null) for (int i = 0; i < points.length(); i++) {
            try {
                JSONObject o = points.getJSONObject(i);
                out.add(GeoPolicy.circle(o.getString("id"), o.getString("name"), "peligro",
                        o.optString("alarm", "voz_y_sirena"), nullIfEmpty(o.optString("message", "")),
                        o.getDouble("lat"), o.getDouble("lng"), o.optDouble("alert_radius_m", 30)));
            } catch (Exception ignored) { /* fila invalida */ }
        }
        return out;
    }

    private void addFence(List<GeoPolicy.Zone> out, JSONObject o) throws Exception {
        JSONArray ids = o.optJSONArray("device_ids");
        if (ids != null) {
            List<String> l = new ArrayList<>();
            for (int k = 0; k < ids.length(); k++) l.add(ids.optString(k));
            if (!BroadcastPolicy.targets(l, deviceId)) return;
        }
        buildFence(out, o);
    }

    private static void buildFence(List<GeoPolicy.Zone> out, JSONObject o) throws Exception {
        String id = o.getString("id"), name = o.getString("name"), kind = o.getString("kind");
        String alarm = o.optString("alarm", "voz_y_sirena"), msg = nullIfEmpty(o.optString("message", ""));
        JSONObject g = o.getJSONObject("geometry");
        GeoPolicy.Zone z;
        if ("circle".equals(o.getString("shape"))) {
            JSONArray c = g.getJSONArray("center");
            z = GeoPolicy.circle(id, name, kind, alarm, msg, c.getDouble(0), c.getDouble(1), g.getDouble("radius_m"));
        } else {
            JSONArray pts = g.getJSONArray("points");
            double[] la = new double[pts.length()], ln = new double[pts.length()];
            for (int k = 0; k < la.length; k++) {
                la[k] = pts.getJSONArray(k).getDouble(0);
                ln[k] = pts.getJSONArray(k).getDouble(1);
            }
            z = GeoPolicy.polygon(id, name, kind, alarm, msg, la, ln);
        }
        if (z != null) out.add(z);
    }

    private static String nullIfEmpty(String s) { return s == null || s.trim().isEmpty() ? null : s; }
}
