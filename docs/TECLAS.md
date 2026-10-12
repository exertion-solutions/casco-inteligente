# Teclas del casco (rd_aqm6816, Android 10)

Dispositivo de entrada: `/dev/input/event2` (`mtk-kpd`). Capturado con `tools/capturar-teclas.ps1`
el 2026-10-11 pulsando cada boton fisico, una vez corta y una vez larga.

| Boton fisico | Tecla Linux | KeyEvent Android | Pulsacion corta | Pulsacion larga |
|---|---|---|---|---|
| **SOS** | `KEY_F11` (87) | `KEYCODE_F11` (142) | 0,39 s / 0,24 s | 1,06 s |
| **Camara** | `KEY_F10` (68) | `KEYCODE_F10` (140) | 0,33 s (foto) | 3,36 s (probable video) |
| **Microfono** | `KEY_F12` (88) | `KEYCODE_F12` (141) | 0,47 s | 2,40 s |

Estado: SOS, camara y microfono observados en captura real. La accion exacta de la pulsacion larga
de camara (video) y de microfono (mensaje de voz / PTT) la decide la app RundeCap; confirmar con
el resultado en `CapCamera` / `CapRecord`.

Otras teclas declaradas por `mtk-kpd`: `0x41` (65), `0x72`/`0x73` (volumen), `0x74` (power), `0x198` (408).

La pulsacion corta/larga se distingue por el tiempo entre DOWN y UP (`press_ms`).
