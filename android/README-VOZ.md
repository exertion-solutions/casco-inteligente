# Voz, orientacion y hombre caido del agente (casco rd_aqm6816)

Protocolo y constantes: `docs/PROTOCOLO-VOZ.md` (fuente de verdad). Este archivo cubre solo el lado Android.

## Que hace
- **Orientacion** (`OrientationTracker` + `OrientationMath`): acelerometro a SENSOR_DELAY_NORMAL, pasos de 90 con
  histeresis de 15 grados, sin cambio si el casco esta plano. `rot = (SENSOR_ORIENTATION - orientation + 360) % 360`.
  `SENSOR_ORIENTATION` se lee de Camera2 (camara trasera, sin abrirla); si falla usa 90 y lo loguea.
  Publica `heartbeat` con `payload {"rot","ori","sens","enc"}` cada 5 s **solo mientras transmite**, si cambio o
  cada 30 s, maximo 6/min, y en cada heartbeat normal (5 min). Va en un hilo propio (`casco-tele`).
- **Hombre caido** (`ManDownPolicy`, pura): ver tabla. `FallDetector` aporta impacto (caida libre o giro violento
  > 6 rad/s, seguido de > 25 m/s2) y ventanas de quietud de 1 s (acelerometro + giroscopio).
- **Voz** (`SpanishVoice`): TextToSpeech de Google, es-AR -> es-ES -> es. Sin voz en espanol: un solo log y silencio.
  No habla durante una llamada. Beeps de la cuenta regresiva (ToneGenerator, STREAM_ALARM) son independientes.
- **Llamada bidireccional** (`VoiceCallManager`): WebRTC solo audio (`io.getstream:stream-webrtc-android:1.3.10`).
  Sondea `rtc_signals` (viewer, ultimos 30 s) cada 3 s en reposo y cada 1 s durante la llamada; atiende sola,
  responde `answer`/`ice`, `busy` si ya hay llamada. No toca la camara ni el RTMP.

## config.json (claves nuevas, todas opcionales)
| Clave | Defecto | Rango |
|---|---|---|
| `voice_prompts` | true | false = el casco no habla (frases, aviso de llamada, cuenta regresiva); los beeps siguen |
| `voice_auto_answer` | true | false = avisa "Llamada del supervisor" y espera **F12** (20 s) para atender |
| `mandown_enabled` | true | false = no hay hombre caido (el evento `fall` y el SOS manual siguen igual) |
| `mandown_still_seconds` | 15 | 5-120 |
| `mandown_confirm_seconds` | 10 | 5-60 |
| `mandown_inactivity_seconds` | 0 (apagado) | 0 o 30-600 (tras uso reciente < 10 min) |

Valores fuera de rango se acotan.

## Permisos
- `RECORD_AUDIO` (runtime con targetSdk 28): `adb shell pm grant ar.exertion.casco android.permission.RECORD_AUDIO`
  (`tools/instalar-agente.ps1` ya lo hace). Sin el permiso el log dice `voz: falta RECORD_AUDIO` y se responde `hangup`.
- `MODIFY_AUDIO_SETTINGS` (normal, solo manifest).
- La app no declara `foregroundServiceType="microphone"`: con targetSdk 28 en Android 10 no se exige.

## Tabla de decision del hombre caido (`ManDownPolicy`)
Ventana = 1 s. "Quieto" = desvio estandar de |a| < 0.6 m/s2 y |w| medio < 0.15 rad/s.

| Estado | Evento | Resultado |
|---|---|---|
| NORMAL | impacto (habilitado, fuera de cooldown) | OBSERVANDO |
| NORMAL | (opcional) quieto `inactivity` s tras >= 10 s de movimiento en los ultimos 10 min | CONFIRMANDO (`trigger: inactividad`) |
| OBSERVANDO | movimiento sostenido >= 3 s | NORMAL (recuperado, sin SOS) |
| OBSERVANDO | quieto `still_seconds` continuos | CONFIRMANDO: dice "Caida detectada...", beep |
| OBSERVANDO | F10 / F12 | NORMAL (cancelado) |
| OBSERVANDO | F11 (SOS manual) | NORMAL; sale el SOS manual normal |
| CONFIRMANDO | beep cada 3 s | - |
| CONFIRMANDO | F10 / F12, o movimiento sostenido >= 3 s | NORMAL (cancelado) |
| CONFIRMANDO | F11 (al soltar) | ALERTA ya, **un solo** SOS con `reason: manual_en_caida` |
| CONFIRMANDO | `confirm_seconds` sin cancelar | ALERTA: SOS `reason: hombre_caido` + video local 120 s + "Emergencia enviada" |
| ALERTA | 60 s | NORMAL (cooldown; impactos y botones ignorados) |

SOS: `type='sos'`, `payload {"reason","still_s","impact","confirm_s","trigger"}`. El evento `fall` se envia al
impacto como antes. F10/F12 no se consumen (RundeCap sigue sacando foto / grabando).

## Tests sin framework (JDK solamente)
```
cd android\app\src
javac -d %TEMP%\md main\java\ar\exertion\casco\ManDownPolicy.java main\java\ar\exertion\casco\OrientationMath.java test\java\ar\exertion\casco\ManDownPolicyCheck.java
java -ea -cp %TEMP%\md ar.exertion.casco.ManDownPolicyCheck
```
Cubre la maquina de estados (caida/recuperacion, cancelacion, SOS, cooldown, deshabilitado, inmovilidad) y la
matematica de orientacion.

## Riesgos conocidos
- **Calibracion**: umbrales de impacto/giro/quietud (FallDetector) son los del protocolo; ajustar con pruebas reales.
  Falsos positivos probables: golpes con casco puesto girando rapido; falsos negativos: caida lenta o sobre superficie blanda.
- **Giroscopio a 50 Hz** (SENSOR_DELAY_GAME) y acelerometro: mas consumo de bateria que antes (solo acelerometro).
- **AEC/ruido de obra**: se usa AEC3/NS de software de WebRTC (los de hardware del MediaTek se desactivan); con
  volumen de llamada al maximo y casco abierto puede haber eco o realimentacion. No verificado en el equipo.
- **Atender sola** (`voice_auto_answer`): el supervisor abre el microfono del casco sin accion del operario; el aviso
  hablado es la unica señal. Mantener `voice_prompts` true.
- **Microfono compartido**: si RundeCap u otra app tiene el microfono, WebRTC puede no capturar audio y la llamada
  se corta a los 20 s sin audio recibido.
- **TTS**: requiere Google TTS con voz en espanol instalada (datos descargados); sin ella el casco calla.
- **Reloj**: el filtro de 30 s usa la hora del servidor (cabecera `Date`), no la del casco.
- **Peso**: el APK suma ~6,5 MB por `libjingle_peerconnection_so.so` (solo armeabi-v7a).
- **DuraSpeed**: el sondeo de voz vive en `MediaWatcherService`; si el sistema lo suprime, tampoco hay llamadas (igual que los comandos de video).

## Tanda 3: centro de mando (salud, ordenes del supervisor, audio del video)
Protocolo: `docs/PROTOCOLO-CENTRO.md` (secciones 3, 4 y 5). Version 0.3.0 (versionCode 3). Ejemplo de config: `android/config.example.json`.

### Salud del equipo (`DeviceHealth` + `HealthPayload`)
Cada heartbeat (5 min; y el de orientacion/video cada <= 30 s mientras transmite) agrega al `payload` junto a `rot/ori/sens/enc`:
`bat` (%), `chg` (cargando/enchufado), `temp_c` (bateria), `sig` (dBm), `lvl` (0-4), `net` ("LTE","3G","2G","5G","WIFI","NONE"),
`sim` (cantidad de SIM en estado READY), `app` (versionName), `free_mb` (libre en getExternalFilesDir), `up_s` (segundos desde el encendido).
Cada fuente va en su try/catch: si falta permiso o API el campo se **omite**. `sig`/`lvl` requieren Android 9/10 (API 28/29); en el casco (Android 10) deberian estar.
**Permisos nuevos: ninguno** (red por `ACCESS_NETWORK_STATE`, ya declarado; no se usa `READ_PHONE_STATE`). Sin red en callbacks de sensores: se arma en el hilo `casco-tele`/`casco-events`.

### Ordenes del supervisor (`BroadcastAgent`)
- Cada 3 s el poll de comandos dispara `GET /rest/v1/broadcasts?created_at=gte.<ahora-2min>&order=created_at.asc` en un hilo propio
  (`casco-bpoll`, backoff hasta 30 s); no demora los SOS. Filtra `device_ids` (null o con su id). Dedupe por `id` en `filesDir/broadcast_seen.txt` (ultimos 50).
- `evacuacion`: cada ciclo de ~8 s suena una **sirena** (AudioTrack `USAGE_ALARM`, 3 s) y luego la voz es-AR
  "Atencion. Evacuacion. <message | Dirijase al punto de reunion>", `repeat` veces. `mensaje`: "Mensaje del supervisor: <message>" `repeat` veces.
- **F10 / F12** silencian la sirena (la voz sigue; el evento no se consume). Un nuevo SOS/llamada no la corta.
- Llamada activa: no se interrumpe; beep de aviso y espera hasta 60 s (despues arranca igual; con llamada viva la voz TTS no suena, queda la sirena).
- `broadcast_acks {broadcast_id, device_id}` se inserta **al iniciar** la reproduccion (la policy acepta acks de ordenes < 2 min), `return=minimal`, 409 = ya registrado.
- Los volumenes `STREAM_ALARM` y `STREAM_MUSIC` se suben a `broadcast_volume`% durante la orden y se **restauran** al terminar.
- La voz se crea aunque `voice_prompts` sea false (las frases de estado siguen calladas; las ordenes se hablan).

### Audio del casco en el video (`StreamService`)
- `stream_audio` (false): pista AAC-LC mono 16 kHz ~24 kbps (RootEncoder `prepareAudio(MIC, 24000, 16000, false, false, true)`), ruta **`ingest/<device_id>`**
  (`stream_ingest_path` solo cambia el prefijo cuando no es "live"); si no hay audio activo se publica en `live/<id>` como antes.
- El microfono se abre **solo** con `stream_audio=true`, `RECORD_AUDIO` concedido y transmision activa. Sin permiso o si `prepareAudio` falla: log y video sin audio, en `live/`.
- Durante una llamada WebRTC el audio del stream se **silencia** (`disableAudio`, tick de 500 ms) y se reanuda al colgar. TTS "Transmision con audio" al iniciar
  (reemplaza a "Transmision de video iniciada").
- Si el audio no se estabiliza (2 reintentos fallidos), se sigue **solo con video** en `live/` para no perder la imagen.
- **Codec**: RootEncoder 2.5.5 `RtmpClient` empaqueta AAC y G.711 (`G711Packet`); `AudioCodec.OPUS` existe en el enum pero RTMP no tiene packetizer Opus.
  Se implementa AAC porque el relay del servidor (`server/relay-audio.sh`) espera AAC y transcodifica a Opus. G.711 (PCMA, 8 kHz) quedaria como alternativa sin transcodificar.

### Config nueva (todas opcionales)
| Clave | Defecto | Rango |
|---|---|---|
| `broadcast_enabled` | true | false = ignora ordenes (no consulta `broadcasts`) |
| `broadcast_volume` | 100 | 0-100 |
| `stream_audio` | false | true = audio en el video (ver riesgos) |
| `stream_ingest_path` | "live" | `[A-Za-z0-9_-]{1,32}`; con audio y valor "live" se usa "ingest" |

### Tests (JDK solamente)
```
cd android\app\src
javac -encoding UTF-8 -d %TEMP%\chk main\java\ar\exertion\casco\{ManDownPolicy,OrientationMath,StreamPolicy,HealthPayload,BroadcastPolicy}.java test\java\ar\exertion\casco\*.java
java -ea -cp %TEMP%\chk ar.exertion.casco.HealthPayloadCheck   (tambien BroadcastPolicyCheck, StreamPolicyCheck, ManDownPolicyCheck)
```

### Riesgos (tanda 3)
- **Sin verificar en el casco**: sirena, volumenes, TTS, ack, silenciado del audio y cobertura de `getSignalStrength()` no se probaron en el equipo.
- **Microfono compartido**: con `stream_audio`, RootEncoder mantiene su `AudioRecord` (solo envia ceros durante la llamada) mientras WebRTC abre el suyo en el mismo proceso;
  Android 10 lo permite para el mismo UID, pero el MediaTek no esta probado. Plan B: parar/reiniciar la transmision al llamar. RundeCap tambien puede tener el microfono.
- **Privacidad / legal**: el microfono transmite al supervisor y, si graba, al archivo; hay que informar al personal. Por eso es opt-in y con aviso hablado.
- **Servidor**: `stream_audio=true` depende del relay `ingest -> live` (ffmpeg en el VPS). Si el relay cae, el visor no ve nada. Validar antes de activarlo.
- **Volumen**: subir STREAM_MUSIC/ALARM al maximo sorprende a quien usa auricular; se restaura al terminar, pero si el servicio muere en medio queda alto.
- **Mas red**: un GET extra cada 3 s (backoff 30 s). Con 4G debil el poll puede tardar hasta ~10 s; corre en su hilo.
- **`repeat` por defecto 3**: un `mensaje` sin `repeat` explicito se repite 3 veces (default de la BD).
- **DuraSpeed**: si suprime el paquete tras force-stop no hay poll de ordenes (igual que comandos de video).
