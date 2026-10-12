package ar.exertion.casco;

import java.util.ArrayList;
import java.util.List;

/**
 * Alertas de equipo (docs/PROTOCOLO-COMANDOS.md seccion 2): bat_low (<20 %), bat_crit (<10 %), no_signal,
 * temp (>45 C), storage (<1 GB libre). PURA (sin Android): una vez por episodio, con histeresis para
 * que un valor que oscila en el umbral no repita el evento. Se alimenta con las lecturas de DeviceHealth
 * (null = dato desconocido: no cambia el estado). Un solo hilo.
 */
final class EquipAlerts {
    static final int BAT_LOW = 20, BAT_LOW_CLEAR = 25, BAT_CRIT = 10, BAT_CRIT_CLEAR = 15;
    static final double TEMP_MAX = 45.0, TEMP_CLEAR = 42.0;
    static final long STORAGE_MIN_MB = 1024, STORAGE_CLEAR_MB = 1280;
    /** Lecturas consecutivas sin senal antes de avisar (con el muestreo de 30 s = 60 s). */
    static final int NO_SIGNAL_SAMPLES = 2;

    static final class Alert {
        final String kind, level;
        final Number value;
        Alert(String kind, String level, Number value) { this.kind = kind; this.level = level; this.value = value; }
    }

    private boolean low, crit, noSignal, temp, storage;
    private int noSignalRun;

    /** Una lectura. Devuelve las alertas NUEVAS (episodios que empiezan ahora). */
    List<Alert> update(Integer bat, Boolean charging, Double tempC, Integer signalLevel, String net, Long freeMb) {
        List<Alert> out = new ArrayList<>();
        boolean chg = charging != null && charging;

        if (bat != null) {
            if (chg || bat >= BAT_LOW_CLEAR) low = crit = false;       // cargando o recuperada: episodio terminado
            else if (bat >= BAT_CRIT_CLEAR) crit = false;
            if (!chg) {
                if (bat < BAT_CRIT && !crit) {
                    crit = true;
                    low = true; // el aviso critico incluye al de "baja": no emitir los dos
                    out.add(new Alert("bat_crit", "crit", bat));
                } else if (bat < BAT_LOW && !low) {
                    low = true;
                    out.add(new Alert("bat_low", "warn", bat));
                }
            }
        }

        boolean none = "NONE".equals(net) || (signalLevel != null && signalLevel == 0);
        boolean known = net != null || signalLevel != null;
        if (known) {
            if (none) {
                if (++noSignalRun >= NO_SIGNAL_SAMPLES && !noSignal) {
                    noSignal = true;
                    out.add(new Alert("no_signal", "warn", signalLevel != null ? (Number) signalLevel : (Number) 0));
                }
            } else {
                noSignalRun = 0;
                noSignal = false;
            }
        }

        if (tempC != null) {
            if (tempC <= TEMP_CLEAR) temp = false;
            else if (tempC > TEMP_MAX && !temp) {
                temp = true;
                out.add(new Alert("temp", "warn", tempC));
            }
        }

        if (freeMb != null) {
            if (freeMb >= STORAGE_CLEAR_MB) storage = false;
            else if (freeMb < STORAGE_MIN_MB && !storage) {
                storage = true;
                out.add(new Alert("storage", "warn", freeMb));
            }
        }
        return out;
    }
}
