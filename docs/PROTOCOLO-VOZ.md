# Protocolo de voz en vivo y auto-orientacion (casco 4132)

Fuente de verdad para Android, Web, Servidor y Supabase. Complementa `PROTOCOLO-VIDEO.md`.
Si algo no cierra, se corrige AQUI primero.

## 1. Auto-orientacion de la imagen
El casco informa su orientacion; el visor gira la imagen solo.

- El agente muestrea el acelerometro (`Sensor.TYPE_ACCELEROMETER`, SENSOR_DELAY_NORMAL) y calcula, como
  `OrientationEventListener`, `orientation` en pasos de 90 (0/90/180/270), con histeresis de 15 grados y
  **sin cambio si el casco esta plano** (|z| domina).
- `rot = (SENSOR_ORIENTATION - orientation + 360) % 360` (camara trasera, formula de Camera2). Se reporta ademas
  `ori` (= orientation) y `enc` (= stream_rotation configurado).
- Se publica como evento `type='heartbeat'` con `payload = {"rot":90,"ori":0,"sens":90,"enc":180}`
  cada **5 s mientras transmite** (solo si cambio o cada 30 s) y en cada heartbeat normal (5 min).
  `events_guard` permite 30/min por tipo: no superar 6/min.
- El visor (modo Auto, por defecto) usa el ultimo `payload.rot` del casco: `giro = (rot + AUTO_ROT_OFFSET) % 360`
  con `AUTO_ROT_OFFSET` en `web/config.js` (calibrado con una pose conocida). Boton **Girar** pasa a modo Manual;
  boton **Auto** vuelve al automatico.

## 2. Voz bidireccional en vivo (WebRTC solo audio)
```
Visor (navegador)  <-- WebRTC audio Opus (P2P o via TURN) -->  Casco (app, stream-webrtc-android)
        |  señalizacion: public.rtc_signals (REST + Realtime)          |  poll REST 1 s durante la llamada
        +--------------- Supabase ------------------------------------+
TURN: coturn en el VPS (3478 udp/tcp), credenciales temporales por Edge Function turn-credentials
```

### Tabla `public.rtc_signals`
| Columna | Tipo | Notas |
|---|---|---|
| id | uuid pk | gen_random_uuid() |
| device_id | text | `^[A-Za-z0-9_-]{1,64}$` |
| call_id | uuid | lo genera el visor al iniciar la llamada |
| from_role | text | `'viewer'` o `'device'` (fijado por trigger segun el rol del JWT, no por el cliente) |
| kind | text | `'offer'`, `'answer'`, `'ice'`, `'hangup'`, `'busy'` |
| payload | jsonb | `{"sdp":"..."}` para offer/answer; `{"candidate":"...","sdpMid":"0","sdpMLineIndex":0}` para ice |
| created_at | timestamptz | `now()` (trigger) |

- INSERT: `viewer`/`admin` con from_role `viewer`; `device` con `device_id = jwt_device_id()` y from_role `device`.
- SELECT: viewer/admin todo; `device` solo filas de su device_id con `from_role='viewer'` y de los ultimos 2 minutos.
- Sin UPDATE/DELETE. payload <= 8 KB. Rate limit: 60 filas/min por (user, call_id).
- Realtime habilitado (el visor se suscribe a `device_id=eq.<id>`).

### Flujo
1. Visor: **Hablar** -> `call_id = crypto.randomUUID()`; pide mic; `getUserMedia({audio:{echoCancellation,noiseSuppression,autoGainControl}})`;
   obtiene TURN (`turn-credentials`); crea `RTCPeerConnection`; envia `offer` (espera ICE max 1.5 s o trickle).
2. Casco: su poll de `rtc_signals` (cada 1 s, solo si hay `offer` reciente sin `hangup`) detecta la oferta; responde con
   TTS "Llamada del supervisor" y **acepta automaticamente** (config `voice_auto_answer`, por defecto true); envia `answer` e `ice`.
3. Ambos intercambian `ice`. Audio Opus en ambos sentidos. El casco usa `MODE_IN_COMMUNICATION`, altavoz activo, AEC de WebRTC.
4. **Colgar**: cualquiera envia `hangup`; ambos cierran, liberan mic y restauran `AudioManager`. Tope duro **30 min**; si no
   hay audio recibido en 20 s, se cuelga. Si ya hay llamada: el casco responde `busy`.
5. Mientras hay llamada el casco **no** interrumpe el video RTMP (son independientes).

### TURN (coturn) y credenciales
- coturn en el VPS: `use-auth-secret`, `static-auth-secret=<TURN_SECRET>` (solo en `.env` del VPS y secreto de la Edge Function).
- Edge Function `turn-credentials` (Supabase, verify_jwt apagado, valida JWT con `auth.getUser`): roles `device`/`viewer`/`admin`.
  Responde `{"urls":["stun:HOST:3478","turn:HOST:3478?transport=udp","turn:HOST:3478?transport=tcp"],"username":"<exp>:<user>","credential":"<base64(HMAC-SHA1(secret, username))>","ttl":3600}`.
  `HOST` = IP publica del VPS (el casco no resuelve sslip.io) - configurable por secreto `TURN_HOST`.
- Puertos VPS: 3478/udp+tcp y rango de relay 49160-49200/udp abiertos.

### Puesta en marcha en el VPS (resumen)
Procedimiento clic a clic: `server/README.md`, seccion 10 ("Activar la voz en un VPS que ya corre el video").
Resumen: consola de Vultr (View Console, root) > `sh activar-voz.sh --descargar` > copiar la ultima linea `TURN_SECRET=...` >
Supabase > Edge Functions > Secrets: `TURN_SECRET` y `TURN_HOST` (IP del VPS) > Edge Functions > `turn-credentials` (desplegar
con "Verify JWT" desactivado; CLI: `supabase functions deploy turn-credentials --no-verify-jwt --project-ref zgfvhjpdzkohouktakvt`)
> recien entonces `VOICE_ENABLED: true` en `web/config.js` (paso manual: mientras coturn o la funcion no existan, el boton Hablar
debe seguir oculto). Revertir: `server/desactivar-voz.sh` + `VOICE_ENABLED: false`.
Orden obligatorio: coturn arriba -> secreto igual en VPS y Supabase -> funcion desplegada -> `VOICE_ENABLED`.

## 3. Voz del casco en espanol (TTS)
- El agente usa `android.speech.tts.TextToSpeech` (motor Google, idioma `es-AR`, fallback `es-ES` / `es`). Si no hay voz es,
  loguear y no hablar. Frases (config `voice_prompts`, por defecto true): "Emergencia enviada", "Foto tomada",
  "Transmision de video iniciada", "Transmision detenida", "Llamada del supervisor", "Llamada finalizada".
- La voz de las frases usa `STREAM_MUSIC`; no hablar durante una llamada activa.

## 4. Comandos (extension de `stream_commands`)
`action in ('start','stop')` se mantiene. La voz NO usa comandos: usa `rtc_signals`.

## 5. Seguridad
- JWT de Supabase como unica credencial; `rtc_signals` y `turn-credentials` con roles estrictos.
- TURN con credenciales que vencen en 1 h; sin acceso a la red interna del VPS (`denied-peer-ip` para rangos privados).
- Nada de secretos en el repo (publico): `TURN_SECRET` solo en `.env`/secretos.
- El casco solo contesta ofertas de `from_role='viewer'` de los ultimos 30 s.

## 6. Hombre caido (alerta automatica por caida + inmovilidad)
Maquina de estados en el casco (clase pura `ManDownPolicy`, probable sin dispositivo).

| Estado | Entrada | Salida |
|---|---|---|
| `NORMAL` | arranque / recuperacion | impacto detectado por `FallDetector` (caida libre + impacto) **o** giro violento (|giroscopio| > 6 rad/s) seguido de impacto > 25 m/s2 |
| `OBSERVANDO` | tras el impacto | movimiento sostenido >= 3 s -> `NORMAL` (recuperado, no hay SOS); quietud continua `mandown_still_seconds` (def. 15) -> `CONFIRMANDO` |
| `CONFIRMANDO` | quieto tras caida | boton F10/F11/F12 o movimiento sostenido -> `NORMAL` (cancelado por el operario); `mandown_confirm_seconds` (def. 10) sin cancelar -> `ALERTA` |
| `ALERTA` | sin cancelar | emite evento SOS y arranca el video 120 s; cooldown 60 s -> `NORMAL` |

- "Quieto": desvio estandar de |aceleracion| < 0.6 m/s2 **y** |giroscopio| < 0.15 rad/s en ventanas de 1 s.
- Voz (TTS es-AR): al entrar a `CONFIRMANDO`: "Caida detectada. Presione cualquier boton para cancelar la alerta";
  cada 3 s un beep; al `ALERTA`: "Emergencia enviada".
- Evento: `type='sos'`, `payload={"reason":"hombre_caido","still_s":<n>,"impact":<m/s2>,"confirm_s":<n>}`.
  El evento `type='fall'` (impacto) se sigue enviando al detectar el impacto, antes de la cuenta regresiva.
- Config (config.json): `mandown_enabled` (true), `mandown_still_seconds` (15), `mandown_confirm_seconds` (10),
  `mandown_inactivity_seconds` (0 = desactivado: sin movimiento alguno N s tras actividad reciente < 10 min -> mismo flujo).
- El visor muestra `payload.reason == 'hombre_caido'` como "HOMBRE CAÍDO" en el banner y la tarjeta.
- Falsos positivos: un casco dejado en una mesa tras un golpe suave no dispara (requiere caida libre + impacto);
  el operario puede cancelar con cualquier boton.
