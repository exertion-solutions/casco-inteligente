package ar.exertion.casco;

import java.util.HashMap;
import java.util.Map;

/** Sin framework: ver android/README-VOZ.md (seccion tanda 4). */
public class RemoteConfigCheck {
    static void eq(Object exp, Object got, String what) {
        if (exp == null ? got != null : !exp.equals(got)) {
            throw new AssertionError(what + ": esperado " + exp + " obtenido " + got);
        }
    }

    public static void main(String[] a) {
        // sin config: todo cae al valor local
        RemoteConfig.set(RemoteConfig.NONE);
        eq(25f, RemoteConfig.impactMs2(25f), "impacto local");
        eq(300_000L, RemoteConfig.heartbeatMs(300_000L), "heartbeat local");
        eq(120, RemoteConfig.notWornS(), "not_worn por defecto");
        eq(0, RemoteConfig.inactivityS(), "inactividad apagada por defecto");
        eq(true, RemoteConfig.streamAudio(true), "stream_audio local");

        // valida
        Map<String, Object> m = new HashMap<>();
        m.put("fall_g_threshold", 3.0);
        m.put("inactivity_s", 300);
        m.put("not_worn_s", 90.0);          // Double integral (asi llega de JSON)
        m.put("heartbeat_s", 120);
        m.put("location_s", 30);
        m.put("location_s_alert", 10);
        m.put("stream_audio", true);
        m.put("voice_commands", false);
        m.put("broadcast_volume", 80);
        m.put("torch_allowed", false);
        m.put("clave_desconocida", "x");
        RemoteConfig.Values v = RemoteConfig.parse(m);
        eq(0, v.rejected.size(), "nada rechazado");
        RemoteConfig.set(v);
        eq((float) (3.0 * 9.80665), RemoteConfig.impactMs2(25f), "impacto remoto");
        eq(300, RemoteConfig.inactivityS(), "inactividad");
        eq(90, RemoteConfig.notWornS(), "not_worn");
        eq(120_000L, RemoteConfig.heartbeatMs(1L), "heartbeat");
        eq(30_000L, RemoteConfig.locationMs(1L), "location");
        eq(10_000L, RemoteConfig.locationAlertMs(1L), "location alerta");
        eq(true, RemoteConfig.streamAudio(false), "stream_audio remoto");
        eq(false, RemoteConfig.voiceCommands(true), "voice_commands remoto");
        eq(80, RemoteConfig.broadcastVolume(100), "volumen");
        eq(false, RemoteConfig.current().torchAllowed, "torch_allowed");

        // rangos: lo invalido se descarta y queda el local
        m.clear();
        m.put("fall_g_threshold", 0.5);
        m.put("inactivity_s", 30);          // ni 0 ni 120..3600
        m.put("not_worn_s", 5);
        m.put("heartbeat_s", 99999);
        m.put("location_s", "60");          // tipo equivocado
        m.put("location_s_alert", 2.5);     // no entero
        m.put("broadcast_volume", 101);
        m.put("stream_audio", "true");
        v = RemoteConfig.parse(m);
        eq(8, v.rejected.size(), "todo rechazado");
        RemoteConfig.set(v);
        eq(25f, RemoteConfig.impactMs2(25f), "impacto vuelve a local");
        eq(120, RemoteConfig.notWornS(), "not_worn vuelve al defecto");
        eq(0, RemoteConfig.inactivityS(), "inactividad vuelve a apagada");
        eq(60_000L, RemoteConfig.locationMs(60_000L), "location local");
        eq(false, RemoteConfig.streamAudio(false), "stream_audio local");

        // bordes validos
        m.clear();
        m.put("inactivity_s", 0);
        m.put("not_worn_s", 30);
        m.put("heartbeat_s", 1800);
        m.put("broadcast_volume", 0);
        m.put("fall_g_threshold", 8);
        v = RemoteConfig.parse(m);
        eq(0, v.rejected.size(), "bordes validos");
        eq(0, v.inactivityS, "inactivity 0");
        eq(0, v.broadcastVolume, "volumen 0");

        // config nula = sin cambios locales
        eq(RemoteConfig.NONE, RemoteConfig.parse(null), "null");
        RemoteConfig.set(RemoteConfig.NONE);
        System.out.println("RemoteConfigCheck OK");
    }
}
