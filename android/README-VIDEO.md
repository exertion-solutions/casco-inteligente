# Video en vivo del agente (casco rd_aqm6816)

Protocolo y constantes: `docs/PROTOCOLO-VIDEO.md` (fuente de verdad). Este archivo cubre solo el lado Android.

## Que hace
- `StreamService` (primer plano, notificacion minima) transmite la camara **trasera** por RTMP a
  `rtmp://<stream_host>:1935/live/<device_id>?user=device&pass=<access_token>`. Sin audio, sin preview.
- `MediaWatcherService` consulta cada 3 s `GET /rest/v1/stream_commands?device_id=eq.<id>&order=created_at.desc&limit=1`
  (solo REST, en el hilo de eventos existente) y arranca/detiene segun `StreamPolicy`.
- SOS (F11) y caida arrancan una transmision local de 120 s ademas de enviar el evento.
- Libreria: RootEncoder 2.5.5 (Apache-2.0, JitPack). Pura Java/Kotlin, sin `.so`: sirve para armeabi-v7a.

## config.json (en `/sdcard/Android/data/ar.exertion.casco/files/`, NO versionado)
| Clave | Defecto | Rango aceptado |
|---|---|---|
| `stream_host` | (obligatoria; sin ella no hay video) | `host` o `host:puerto`, solo `[A-Za-z0-9.-]` |
| `stream_width` / `stream_height` | 640 / 480 | 160-1920 / 120-1080 |
| `stream_fps` | 15 | 5-30 |
| `stream_bitrate_kbps` | 800 | 100-4000 |
| `stream_rotation` (extra, opcional) | 0 | 0, 90, 180, 270 (orientacion de la imagen segun montaje de la camara) |

Valores fuera de rango se acotan; keyframe cada 2 s, H.264 Baseline (si el encoder lo rechaza, usa su perfil por defecto).

## Permiso de camara (obligatorio, una vez)
Con targetSdk 28 `CAMERA` es de runtime y la app no tiene UI para pedirlo:

```
adb shell pm grant ar.exertion.casco android.permission.CAMERA
```
`tools/instalar-agente.ps1` ya lo hace. Sin el permiso el log dice `stream: falta permiso CAMERA`.

## Tabla de decision (`StreamPolicy.decide`)
Entrada: ultimo comando vigente (RLS: <2 min) `id/action`, ultimo `id` ya procesado, y quien transmite
(NONE / REMOTE comando / LOCAL SOS-caida).

| Comando vigente | `id` ya visto | Transmitiendo | Resultado |
|---|---|---|---|
| ninguno (vencio o nunca hubo) | - | REMOTE | **STOP** (vencio) |
| ninguno | - | LOCAL / NONE | nada (el SOS local sigue sus 120 s) |
| cualquiera | si | cualquiera | nada (no reiniciar tras tope/fallo; un `stop` viejo no mata un SOS posterior) |
| `start` nuevo | no | NONE | **START** remoto |
| `start` nuevo | no | LOCAL | **START**: se promueve a remoto (no corta a los 120 s) |
| `start` nuevo | no | REMOTE | nada |
| `stop` nuevo | no | REMOTE o LOCAL | **STOP** |
| `stop` nuevo | no | NONE | nada |

Limites: tope duro 10 min por transmision (no se reinicia con otro `start` mientras transmite; el visor
debe mandar un `start` nuevo tras el corte); SOS/caida 120 s; reconexion RTMP/camara hasta 5 intentos con
backoff 2-4-8-16-32 s; poll de comandos 3 s, con errores de red 6-12-24-30 s.

Test sin framework (corre en cualquier JDK):
```
cd android/app/src
javac -d %TEMP%\sp main\java\ar\exertion\casco\StreamPolicy.java test\java\ar\exertion\casco\StreamPolicyCheck.java
java -ea -cp %TEMP%\sp ar.exertion.casco.StreamPolicyCheck
```

## Riesgos conocidos
- **Camara exclusiva**: si RundeCap u otra app tiene la camara, `openCamera` falla (CAMERA_IN_USE). El agente
  loguea el motivo con tag `CascoAgente` y reintenta con backoff; no hay evento de error (el schema no lo permite).
  Si RundeCap toma la camara durante la transmision, esta se corta y se reintenta.
- **DuraSpeed/Doze**: abrir `LauncherActivity` tras un force-stop; el servicio usa wake lock parcial solo mientras transmite.
- **Token en URL**: RTMP en claro (aceptado para el piloto, ver protocolo). Nunca se loguea la URL.
- **4G debil (-108 dBm)**: 800 kbps puede no sostenerse; bajar `stream_bitrate_kbps` (300-400) y/o `stream_fps`.
