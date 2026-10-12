package ar.exertion.casco;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Geocercas evaluadas en el casco (docs/PROTOCOLO-GEO.md seccion 2). PURA (sin Android ni JSON): el reloj y las
 * posiciones entran por parametro; se llama desde un unico hilo. Testeable con GeoPolicyCheck.
 *
 * Tipos (kind): permitida (alerta al SALIR), restringida y peligro (alerta al ENTRAR), informativa (aviso).
 * Un punto 'peligro' es una zona circular restringida (kind 'peligro', radio alert_radius_m).
 */
final class GeoPolicy {
    private GeoPolicy() { }

    static final int CONFIRM_FIXES = 2;          // fixes consecutivos en el estado nuevo para cruzar (histeresis)
    static final long REPEAT_MS = 10_000L;       // la alarma se repite mientras siga el estado de alerta

    static final class Zone {
        final String id, name, kind, alarm, message;
        final boolean circle;
        final double lat, lng, radiusM;          // circulo
        final double[] plat, plng;               // poligono

        private Zone(String id, String name, String kind, String alarm, String message, boolean circle,
                     double lat, double lng, double radiusM, double[] plat, double[] plng) {
            this.id = id; this.name = name; this.kind = kind; this.alarm = alarm; this.message = message;
            this.circle = circle; this.lat = lat; this.lng = lng; this.radiusM = radiusM;
            this.plat = plat; this.plng = plng;
        }
    }

    static Zone circle(String id, String name, String kind, String alarm, String message,
                       double lat, double lng, double radiusM) {
        return new Zone(id, name, kind, alarm, message, true, lat, lng, radiusM, null, null);
    }

    /** null si hay menos de 3 puntos. */
    static Zone polygon(String id, String name, String kind, String alarm, String message,
                        double[] plat, double[] plng) {
        if (plat == null || plng == null || plat.length != plng.length || plat.length < 3) return null;
        return new Zone(id, name, kind, alarm, message, false, 0, 0, 0, plat, plng);
    }

    /** Distancia en metros (haversine). */
    static double haversineM(double lat1, double lng1, double lat2, double lng2) {
        final double r = 6_371_000.0;
        double p1 = Math.toRadians(lat1), p2 = Math.toRadians(lat2);
        double dp = p2 - p1, dl = Math.toRadians(lng2 - lng1);
        double a = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
        return 2 * r * Math.asin(Math.min(1.0, Math.sqrt(a)));
    }

    static boolean inside(Zone z, double lat, double lng) {
        if (z.circle) return haversineM(z.lat, z.lng, lat, lng) <= z.radiusM;
        boolean in = false; // ray casting (x = lng, y = lat); zonas chicas: plano local alcanza
        int n = z.plat.length;
        for (int i = 0, j = n - 1; i < n; j = i++) {
            double yi = z.plat[i], yj = z.plat[j], xi = z.plng[i], xj = z.plng[j];
            if ((yi > lat) != (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) in = !in;
        }
        return in;
    }

    static boolean alertOnEnter(String kind) { return "restringida".equals(kind) || "peligro".equals(kind); }

    static boolean alertOnExit(String kind) { return "permitida".equals(kind); }

    static boolean wantsSiren(Zone z) {
        return !"informativa".equals(z.kind) && ("sirena".equals(z.alarm) || "voz_y_sirena".equals(z.alarm));
    }

    static boolean wantsVoice(Zone z) {
        return "informativa".equals(z.kind) || "voz".equals(z.alarm) || "voz_y_sirena".equals(z.alarm);
    }

    /** Frase es-AR: el mensaje de la zona o la de protocolo. */
    static String phrase(Zone z, String action) {
        if (z.message != null && !z.message.trim().isEmpty()) return z.message.trim();
        if ("informativa".equals(z.kind)) return "Zona " + z.name;
        if (alertOnEnter(z.kind)) return "Atención. Está ingresando a una zona restringida: " + z.name;
        if (alertOnExit(z.kind)) return "Atención. Está saliendo de la zona de trabajo: " + z.name;
        return z.name;
    }

    /** Cruce confirmado. {@code alert}: requiere atencion (restringida/peligro enter, permitida exit). */
    static final class Event {
        final Zone zone;
        final String action; // "enter" | "exit"
        final boolean alert;
        Event(Zone zone, String action, boolean alert) { this.zone = zone; this.action = action; this.alert = alert; }
    }

    /** Estado por zona + histeresis + repeticion de la alarma. Un solo hilo. */
    static final class Tracker {
        private final Map<String, Boolean> state = new HashMap<>();   // confirmado: true = dentro
        private final Map<String, Integer> run = new HashMap<>();     // fixes consecutivos contrarios
        private final Map<String, Long> nextAlarm = new HashMap<>();  // alarmando: proxima repeticion
        private final Set<String> silenced = new HashSet<>();
        private final Map<String, Zone> byId = new HashMap<>();

        /**
         * Evalua un fix nuevo (el que llama no repite el mismo fix: cuenta como fix consecutivo). Devuelve los
         * cruces confirmados. El primer estado confirmado de una zona es la base: solo genera evento si es
         * "dentro" de una zona restringida/peligro (alarma ya), nunca para permitida/informativa.
         */
        List<Event> update(List<Zone> zones, double lat, double lng) {
            List<Event> out = new ArrayList<>();
            Set<String> live = new HashSet<>();
            for (Zone z : zones) {
                live.add(z.id);
                byId.put(z.id, z);
                boolean now = inside(z, lat, lng);
                Boolean st = state.get(z.id);
                if (st != null && st == now) { run.remove(z.id); continue; }
                int n = run.containsKey(z.id) ? run.get(z.id) + 1 : 1;
                if (n < CONFIRM_FIXES) { run.put(z.id, n); continue; }
                run.remove(z.id);
                state.put(z.id, now);
                boolean first = st == null;
                if (first && !(now && alertOnEnter(z.kind))) continue;
                String action = now ? "enter" : "exit";
                boolean alert = now ? alertOnEnter(z.kind) : alertOnExit(z.kind);
                out.add(new Event(z, action, alert));
                if (alert) { nextAlarm.put(z.id, 0L); silenced.remove(z.id); }
                else { nextAlarm.remove(z.id); silenced.remove(z.id); }
            }
            // zonas que ya no estan (baja/desactivadas): se olvidan, su alarma cesa
            for (String id : new ArrayList<>(state.keySet())) {
                if (!live.contains(id)) {
                    state.remove(id); run.remove(id); nextAlarm.remove(id); silenced.remove(id); byId.remove(id);
                }
            }
            return out;
        }

        /** Zonas cuya alarma toca ahora (inmediata al cruzar, luego cada 10 s mientras siga en alerta). */
        List<Zone> dueAlarms(long nowMs) {
            List<Zone> out = new ArrayList<>();
            for (Map.Entry<String, Long> e : nextAlarm.entrySet()) {
                if (silenced.contains(e.getKey()) || nowMs < e.getValue()) continue;
                Zone z = byId.get(e.getKey());
                if (z != null) { out.add(z); e.setValue(nowMs + REPEAT_MS); }
            }
            return out;
        }

        /** F10/F12: calla las alarmas actuales hasta que cambie el estado (no cancela el evento al supervisor). */
        void silenceAll() { silenced.addAll(nextAlarm.keySet()); }

        boolean alarming() { return !nextAlarm.isEmpty(); }
    }
}
