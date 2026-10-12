package ar.exertion.casco;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.Looper;
import android.util.Log;

/**
 * Posicion del casco con LocationManager.GPS_PROVIDER (docs/PROTOCOLO-GEO.md seccion 1), sin librerias.
 * Guarda el ultimo fix; si todavia no hay, usa getLastKnownLocation (GPS o pasivo). Si falta el permiso
 * (pm grant ACCESS_FINE_LOCATION) o no hay GNSS, last() devuelve null y el SOS sale igual, sin posicion.
 */
final class LocationTracker implements LocationListener {
    private static final String TAG = "CascoAgente";
    private static final long UPDATE_MS = 10_000L;

    /** Foto inmutable de una posicion. */
    static final class Fix {
        final double lat, lng, acc, spd, brg, alt;
        final boolean hasAcc;
        final int sats;
        final long time; // epoch ms del fix

        Fix(Location l) {
            lat = l.getLatitude();
            lng = l.getLongitude();
            hasAcc = l.hasAccuracy();
            acc = hasAcc ? l.getAccuracy() : -1;
            spd = l.hasSpeed() ? l.getSpeed() : -1;
            brg = l.hasBearing() ? l.getBearing() : -1;
            alt = l.hasAltitude() ? l.getAltitude() : Double.NaN;
            Bundle x = l.getExtras();
            sats = x != null ? x.getInt("satellites", -1) : -1;
            time = l.getTime();
        }

        long ageS() { return Math.max(0, (System.currentTimeMillis() - time) / 1000); }
    }

    private final Context app;
    private final LocationManager lm;
    private volatile Fix last;
    private boolean registered, warned;

    LocationTracker(Context c) {
        app = c.getApplicationContext();
        lm = (LocationManager) app.getSystemService(Context.LOCATION_SERVICE);
    }

    /** Idempotente: (re)intenta registrar si ya se concedio el permiso. Llamar desde un hilo con Looper. */
    void ensureStarted(Looper looper) {
        if (registered || lm == null) return;
        if (app.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            if (!warned) {
                warned = true;
                Log.w(TAG, "gps: falta ACCESS_FINE_LOCATION (adb shell pm grant ar.exertion.casco "
                        + "android.permission.ACCESS_FINE_LOCATION): SOS sin posicion");
            }
            return;
        }
        try {
            if (!lm.getAllProviders().contains(LocationManager.GPS_PROVIDER)) {
                if (!warned) { warned = true; Log.w(TAG, "gps: el casco no tiene proveedor GPS"); }
                return;
            }
            lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, UPDATE_MS, 0f, this, looper);
            registered = true;
            Log.i(TAG, "gps: seguimiento activo");
        } catch (RuntimeException e) {
            Log.w(TAG, "gps: no se pudo iniciar: " + e);
        }
    }

    /** Ultimo fix conocido (el de GPS en vivo o el que tenia el sistema), o null. */
    Fix last() {
        Fix f = last;
        if (f != null) return f;
        if (lm == null || app.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) return null;
        try {
            Location l = lm.getLastKnownLocation(LocationManager.GPS_PROVIDER);
            if (l == null) l = lm.getLastKnownLocation(LocationManager.PASSIVE_PROVIDER);
            return valid(l) ? new Fix(l) : null;
        } catch (RuntimeException e) {
            return null;
        }
    }

    void stop() {
        try {
            if (lm != null && registered) lm.removeUpdates(this);
        } catch (RuntimeException ignored) { }
        registered = false;
    }

    /** El HAL MediaTek entrega (0,0) con precision cuando no hay fix: no es una posicion. */
    static boolean valid(Location l) {
        return l != null && !(l.getLatitude() == 0.0 && l.getLongitude() == 0.0)
                && Math.abs(l.getLatitude()) <= 90 && Math.abs(l.getLongitude()) <= 180;
    }

    @Override public void onLocationChanged(Location l) { if (valid(l)) last = new Fix(l); }
    @Override public void onStatusChanged(String p, int s, Bundle e) { }
    @Override public void onProviderEnabled(String p) { }
    @Override public void onProviderDisabled(String p) { }
}
