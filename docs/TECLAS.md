# Teclas del casco (rd_aqm6816, Android 10)

Dispositivo de entrada: `/dev/input/event2` (`mtk-kpd`). Capturado con `tools/capturar-teclas.ps1`.

| Boton fisico | Tecla Linux | KeyEvent Android | Estado |
|---|---|---|---|
| SOS | `KEY_F11` (87 / 0x57) | `KEYCODE_F11` (142) | Confirmado (pulsacion corta y larga) |
| Camara | `KEY_F10` (68 / 0x44) | `KEYCODE_F10` (140) | Observado; confirmar con una segunda pulsacion |
| Video / grabar | por confirmar | por confirmar | Pendiente |
| Volumen +/- | `KEY_VOLUMEUP` / `KEY_VOLUMEDOWN` (0x73 / 0x72) | estandar | Segun mapa del teclado |

Otras teclas declaradas por `mtk-kpd`: `0x41` (65), `0x58` (88 F12), `0x74` (116, power), `0x198` (408).

Nota: la pulsacion se distingue larga/corta por el tiempo entre DOWN y UP (`press_ms`).
