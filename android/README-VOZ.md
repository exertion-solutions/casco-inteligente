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

SOS: `type='sos'`, `payload {"reason","still_s","impact","confirm_s","trigger"}`. Desde 0.6.0 el evento `fall` NO se
envia al impacto: sale (justo antes del SOS) solo si la cuenta regresiva termina sin cancelar o con F11 durante ella.
Si el operario cancela no hay evento: el heartbeat lleva `payload.countdown` = `confirmando` (mientras cuenta) o
`cancelado` (6 min tras cancelar). Heartbeat tambien trae `sos_ok` (accesibilidad conectada) y `gps` (fix <= 120 s).
La frase de cuenta regresiva nombra los botones de camara/microfono (F10/F12); F11 es el SOS. F10/F12 no se consumen (RundeCap sigue sacando foto / grabando).

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

## Tanda 4: comandos a pedido, config remota, no_worn/inactive/equip (marca: Vigia)
Protocolo: `docs/PROTOCOLO-COMANDOS.md`. Logica nueva en `CommandAgent` (Android), `CommandPolicy`, `RemoteConfig`, `WearMonitor`, `EquipAlerts` (puras, con *Check).
Tests: agregar `CommandPolicy,RemoteConfig,WearMonitor,EquipAlerts,AgentPolicy,Outbox,GeoPolicy` a la lista de javac (AgentPolicy ahora depende de RemoteConfig).
Detalle y pruebas pendientes con el casco: `out/android-tanda4-report.md`. El nombre visible pasa a "Vigia" (label, notificacion); package y claves no cambian.

## Tanda 5: comandos de voz en espanol (0.7.0, versionCode 8)
Protocolo y frases: `docs/PROTOCOLO-GEO.md` seccion 5; lista para operadores: `web/comandos.html` (mantener en sincronia).
Codigo: `VoiceCommandAgent` (audio + hilos + acciones) y `VoiceCommandPolicy` (pura: gramatica, normalizacion de tildes,
ventana de activacion, duplicados, apagado por inactividad, frases habladas). Ganchos en `MediaWatcherService`
(Host: SOS, cancelar caida, linterna/foto via `CommandAgent`), `StreamService` (`SRC_VOICE`, `audioOverride`, `reaudio`),
`SpanishVoice` (`busy()`, `quietSince()`, `repeatLast()`), `BroadcastAgent.playing()`.

### Instalar el modelo (NO va en el APK ni en el repo)
```
.\tools\instalar-modelo-voz.ps1        # descarga vosk-model-small-es-0.42 (~38 MB), verifica tamano/MD5/zip y copia por ADB
```
Destino en el casco: `/sdcard/Android/data/ar.exertion.casco/files/vosk-model-es/` (debe existir `am/final.mdl`).
Sin modelo: un solo log `voz: falta el modelo en ...` y reintento cada 30 s (no rompe nada). Luego `voice_commands: true`
en config.json (o clave remota `voice_commands` en device_config: `RemoteConfig.voiceCommands` pisa a la local).

### config.json (opcionales)
| Clave | Defecto | Rango |
|---|---|---|
| `voice_commands` | false | true = escucha (modelo cargado en ~2 s); tambien se enciende/apaga por config remota |
| `voice_wake_word` | "casco" | una palabra de 3-20 letras que exista en el vocabulario del modelo |
| `voice_idle_off_minutes` | 10 | 0 (nunca apaga) a 240; sin movimiento ese tiempo se suelta el microfono y vuelve al moverse |

### Como decide
- Vosk con **gramatica cerrada** (44 frases: `casco <frase>`, la frase suelta y `[unk]`). Resultado final -> `Session.feed`:
  `casco <comando>` ejecuta; `casco` solo abre una ventana de 8 s (tono corto) para la frase suelta; la frase suelta
  fuera de ventana se ignora; `cancelar` suelto vale solo con una cuenta regresiva (SOS por voz u hombre caido).
  Confianza media por palabra < 0,5 se descarta; el mismo comando repetido en 2,5 s se ignora.
- **SOS por voz**: dice "Emergencia en cinco segundos. Diga cancelar para anular." y los 5 s cuentan desde que el casco
  termina de hablar (tope de seguridad 15 s). Sale `sos` con `key="VOZ"`, `payload {reason:"voz", trigger:"voz"}` y video local 120 s.
- **Video por voz** (`SRC_VOICE`): "activar camara" arranca; el poll de comandos no la corta (a diferencia de `SRC_REMOTE`);
  tope 10 min; "detener video" la corta; una transmision de emergencia (`SRC_LOCAL`) no se corta ni cambia de audio por voz.
- **Audio por voz**: `StreamService.audioOverride` pisa `stream_audio`/config remota hasta reiniciar el agente; con video en
  curso reconecta la transmision (corte de ~2-3 s) y dice "Transmision con/sin audio".
- **Linterna/foto**: `CommandAgent.torchForVoice/photoForVoice` (Camera2). Con la camara tomada por el stream o por otra app el
  casco dice que no se puede y por que. La foto tarda 5-15 s (calentamiento + subida) y dice "Foto enviada." al terminar.
- **Estado**: "Bateria al N por ciento, senal buena|regular|mala|sin senal, sin video|con video[ y audio]."

### Convivencia de audio (verificado en el casco, Android 10, 4132)
| Situacion | Comportamiento |
|---|---|
| El casco habla (TTS), sirena u orden del supervisor | Se suelta el microfono (`AudioRecord.release`) y vuelve 0,7 s despues; tope 30 s por si el motor no avisa el fin |
| Llamada WebRTC (`VoiceCallManager.inCall`) | Se suelta el microfono mientras dure |
| `stream_audio` / "activar audio" con video en curso | **Captura concurrente OK**: `dumpsys audio` muestra el `MIC` de RootEncoder y el `VOICE_RECOGNITION` del reconocedor activos a la vez, ambos `silenced:false`, mismo UID; el reconocedor recibe audio (picos 14-629). Si alguna vez entregara 3 s de ceros exactos con el stream con audio activo, se pausa hasta que termine esa transmision (log `voz: el microfono entrega ceros ...`) |
| RundeCap u otra app con el microfono | Un log y reintento cada 5 s (`AudioRecord` no abre) o ceros: se registra y sigue |
| Sin movimiento `voice_idle_off_minutes` | Microfono suelto; vuelve con el primer movimiento |

### Pruebas
- Logica pura: `VoiceCommandPolicyCheck` (68 verificaciones) + todos los `*Check`; compilar con las clases puras del README mas
  `VoiceCommandPolicy.java` y `CommandPolicy,RemoteConfig,WearMonitor,EquipAlerts,AgentPolicy,Outbox,GeoPolicy`.
- Gramatica contra el modelo real en PC (Vosk Java + voces SAPI es-ES, JNA con `-Djna.encoding=UTF-8`): 14/14 comandos
  reconocidos, habla libre sin la palabra de activacion queda ignorada, sin avisos de palabras fuera de vocabulario.
- En el casco: `adb shell am startservice -n ar.exertion.casco/.MediaWatcherService -a ar.exertion.casco.VOICE_TEXT --es text "'casco estado'"`
  pasa la frase por la misma gramatica/ventana que Vosk (servicio no exportado: solo shell/root). Sirve para probar acciones y
  frases habladas sin hablar. **No usar "casco emergencia" sin cancelar enseguida** (sale un SOS real a los 5 s).
- Logs utiles: `adb logcat -s CascoAgente` -> `voz: reconocimiento listo`, `voz: parcial`, `voz: resultado "..." conf=.. -> COMMAND X`, `voz: dice "..."`, `voz: en pausa (...)`.

### Riesgos
- **La prueba hablada en campo no esta hecha**: no se probo el microfono real del casco con voz humana, ruido de obra, casco
  puesto ni guantes. Umbral `MIN_CONF=0.5` y ventana 8 s sin calibrar; mirar `conf=` en los logs y ajustar.
- **Falsos positivos**: la gramatica cerrada fuerza a Vosk a elegir una frase; el filtro es la palabra de activacion + confianza.
  Una conversacion que diga "casco emergencia" empieza la cuenta de SOS (5 s para cancelar).
- **Ceguera mientras habla**: el casco no escucha mientras dice una frase (la de ayuda dura ~13 s) ni durante la sirena.
- **Memoria/bateria**: modelo cargado ~2 s al encender; el microfono abierto continuo consume bateria (por eso el apagado por inactividad).
- **Privacidad**: el casco escucha el microfono; avisar al personal (Ley 25.326). No se guarda ni envia audio; solo la frase reconocida va al log local.
- **Foto**: Camera2 tarda y falla si RundeCap tiene la camara abierta.
