package ar.exertion.casco;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;

/**
 * Cola persistente de eventos (un archivo, una linea por evento). Sin Android: testeable con OutboxCheck.
 * SOS/caida (AgentPolicy.critical) nunca se descartan; el resto tiene tope (500 en total, 200 'location').
 * Cada mutacion reescribe el archivo (atomico: tmp + move). Hilo-seguro.
 */
final class Outbox {
    static final int MAX_TOTAL = 500, MAX_LOCATION = 200;

    static final class Entry {
        String id, type, key, path, payload; // payload: JSON ya serializado (<= 2 KB) o null
        int pressMs = -1, battery = -1;
        double lat = Double.NaN, lng = Double.NaN;
        long t;            // epoch ms del hecho (el servidor fija created_at)
        boolean stripped;         // ya se reintento sin posicion/payload (solo en memoria)
        boolean announcedOffline; // ya se aviso "sin conexion" (solo en memoria)
        boolean hasPos() { return !Double.isNaN(lat) && !Double.isNaN(lng); }
    }

    private final File file;
    private final List<Entry> list = new ArrayList<>();
    private int seq;

    Outbox(File file) { this.file = file; }

    synchronized void load() {
        list.clear();
        if (!file.isFile()) return;
        try (BufferedReader r = new BufferedReader(
                new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) {
                Entry e = decode(line);
                if (e != null) list.add(e);
            }
        } catch (Exception ignored) { /* archivo ilegible: se sigue con lo leido */ }
    }

    synchronized Entry newEntry(String type, long t) {
        Entry e = new Entry();
        e.id = t + "-" + (seq++);
        e.type = type;
        e.t = t;
        return e;
    }

    synchronized void add(Entry e) {
        list.add(e);
        trim();
        persist();
    }

    /** Primera entrada de la clase pedida (critica o no) en orden de llegada; null si no hay. */
    synchronized Entry next(boolean critical) {
        for (Entry e : list) if (AgentPolicy.critical(e.type) == critical) return e;
        return null;
    }

    synchronized void done(Entry e) {
        if (list.remove(e)) persist();
    }

    /** El servidor rechaza el contenido: reintentar tal cual no sirve; se envia sin posicion ni payload. */
    synchronized void strip(Entry e) {
        e.lat = Double.NaN;
        e.lng = Double.NaN;
        e.payload = null;
        e.stripped = true;
        persist();
    }

    synchronized boolean hasCritical() {
        for (Entry e : list) if (AgentPolicy.critical(e.type)) return true;
        return false;
    }

    synchronized int size() { return list.size(); }

    private void trim() {
        int loc = 0;
        for (Entry e : list) if ("location".equals(e.type)) loc++;
        for (int i = 0; loc > MAX_LOCATION && i < list.size(); ) {
            if ("location".equals(list.get(i).type)) { list.remove(i); loc--; } else i++;
        }
        for (int i = 0; list.size() > MAX_TOTAL && i < list.size(); ) {
            if (!AgentPolicy.critical(list.get(i).type)) list.remove(i); else i++;
        }
    }

    private void persist() {
        File tmp = new File(file.getPath() + ".tmp");
        try {
            try (Writer w = new OutputStreamWriter(new FileOutputStream(tmp), StandardCharsets.UTF_8)) {
                for (Entry e : list) w.write(encode(e) + "\n");
            }
            Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING);
        } catch (Exception ex) {
            // ponytail: sin disco el evento sigue en memoria y se reintenta; solo no sobrevive a un reinicio
        }
    }

    // ---- formato: campos separados por TAB, con barra, TAB, LF y CR escapados ----

    static String encode(Entry e) {
        return esc(e.id) + "\t" + esc(e.type) + "\t" + esc(e.key) + "\t" + e.pressMs + "\t" + esc(e.path) + "\t"
                + e.battery + "\t" + e.lat + "\t" + e.lng + "\t" + e.t + "\t" + esc(e.payload);
    }

    static Entry decode(String line) {
        try {
            String[] f = line.split("\t", -1);
            if (f.length != 10) return null;
            Entry e = new Entry();
            e.id = unesc(f[0]);
            e.type = unesc(f[1]);
            e.key = nul(unesc(f[2]));
            e.pressMs = Integer.parseInt(f[3]);
            e.path = nul(unesc(f[4]));
            e.battery = Integer.parseInt(f[5]);
            e.lat = Double.parseDouble(f[6]);
            e.lng = Double.parseDouble(f[7]);
            e.t = Long.parseLong(f[8]);
            e.payload = nul(unesc(f[9]));
            return e.type.isEmpty() ? null : e;
        } catch (RuntimeException ex) {
            return null;
        }
    }

    private static String nul(String s) { return s.isEmpty() ? null : s; }

    private static String esc(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n").replace("\r", "\\r");
    }

    private static String unesc(String s) {
        if (s.indexOf('\\') < 0) return s;
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\\' && i + 1 < s.length()) {
                char n = s.charAt(++i);
                b.append(n == 't' ? '\t' : n == 'n' ? '\n' : n == 'r' ? '\r' : n);
            } else {
                b.append(c);
            }
        }
        return b.toString();
    }
}
