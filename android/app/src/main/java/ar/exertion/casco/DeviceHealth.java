package ar.exertion.casco;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.os.BatteryManager;
import android.os.Build;
import android.os.SystemClock;
import android.os.StatFs;
import android.telephony.CellSignalStrength;
import android.telephony.SignalStrength;
import android.telephony.TelephonyManager;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.util.Map;

/**
 * Salud del equipo para el payload de heartbeat (docs/PROTOCOLO-CENTRO.md seccion 3).
 * Sin permisos nuevos: bateria, ACCESS_NETWORK_STATE (ya declarado), StatFs, PackageInfo y TelephonyManager
 * sin READ_PHONE_STATE. Cada fuente va en su try/catch: si falta permiso o API, el campo se omite.
 * Llamar desde un hilo de fondo (nunca desde un callback de sensor); no hace red.
 */
final class DeviceHealth {
    private static final String TAG = "CascoAgente";

    private DeviceHealth() { }

    /** Agrega los campos de salud a {@code into} sin pisar los existentes (rot/ori/sens/enc). */
    static void addTo(Context c, JSONObject into) {
        try {
            Map<String, Object> m = HealthPayload.merge(null, collect(c));
            for (Map.Entry<String, Object> e : m.entrySet()) {
                if (!into.has(e.getKey())) into.put(e.getKey(), e.getValue());
            }
        } catch (Exception e) {
            Log.w(TAG, "salud: " + e);
        }
    }

    static Map<String, Object> collect(Context c) {
        Integer bat = null, lvl = null, sig = null, sim = null;
        Boolean chg = null;
        Double temp = null;
        String net = null, app = null;
        Long free = null, up = null;

        try {
            Intent b = c.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (b != null) {
                bat = HealthPayload.batteryPct(b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1),
                        b.getIntExtra(BatteryManager.EXTRA_SCALE, -1));
                int st = b.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
                int plugged = b.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0);
                chg = st == BatteryManager.BATTERY_STATUS_CHARGING || st == BatteryManager.BATTERY_STATUS_FULL
                        || plugged != 0;
                temp = HealthPayload.tempC(b.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Integer.MIN_VALUE));
            }
        } catch (RuntimeException e) { Log.w(TAG, "salud bateria: " + e); }

        try {
            TelephonyManager tm = (TelephonyManager) c.getSystemService(Context.TELEPHONY_SERVICE);
            if (tm != null) {
                if (Build.VERSION.SDK_INT >= 28) {
                    SignalStrength ss = tm.getSignalStrength();
                    if (ss != null) {
                        lvl = HealthPayload.level(ss.getLevel());
                        if (Build.VERSION.SDK_INT >= 29) {
                            for (CellSignalStrength cs : ss.getCellSignalStrengths()) {
                                Integer d = HealthPayload.dbm(cs.getDbm());
                                if (d != null) { sig = d; break; }
                            }
                        }
                    }
                }
                int n = 0, slots = Math.max(1, tm.getPhoneCount());
                for (int i = 0; i < slots; i++) {
                    if (tm.getSimState(i) == TelephonyManager.SIM_STATE_READY) n++;
                }
                sim = n;
            }
        } catch (RuntimeException e) { Log.w(TAG, "salud senal/sim: " + e); } // SecurityException incluida

        try {
            ConnectivityManager cm = (ConnectivityManager) c.getSystemService(Context.CONNECTIVITY_SERVICE);
            NetworkInfo ni = cm == null ? null : cm.getActiveNetworkInfo(); // deprecado, pero sin permisos extra
            if (ni == null || !ni.isConnected()) {
                net = "NONE";
            } else if (ni.getType() == ConnectivityManager.TYPE_WIFI) {
                net = "WIFI";
            } else {
                net = HealthPayload.netName(ni.getSubtype());
                if (net == null) net = "MOBILE";
            }
        } catch (RuntimeException e) { Log.w(TAG, "salud red: " + e); }

        try {
            app = c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionName;
        } catch (PackageManager.NameNotFoundException | RuntimeException e) { Log.w(TAG, "salud app: " + e); }

        try {
            File dir = c.getExternalFilesDir(null);
            if (dir == null) dir = c.getFilesDir();
            free = HealthPayload.freeMb(new StatFs(dir.getAbsolutePath()).getAvailableBytes());
        } catch (RuntimeException e) { Log.w(TAG, "salud espacio: " + e); }

        up = HealthPayload.upSeconds(SystemClock.elapsedRealtime());
        return HealthPayload.build(bat, chg, temp, sig, lvl, net, sim, app, free, up);
    }
}
