# Tanda 3: centro de mando, escalamiento, salud del equipo, evacuacion, texto a voz y grabacion a la PC

Fuente de verdad para Android, Web, Supabase y Servidor. Complementa `PROTOCOLO-VIDEO.md`, `PROTOCOLO-VOZ.md`, `PROTOCOLO-GEO.md`.
Fuera de alcance por decision del usuario: gases, ATEX, signos vitales.

## 1. Centro de mando (web)
Pestana por defecto **Centro** (antes "Principal"): tarjetas KPI (alertas pendientes con contador de tiempo desde la mas antigua,
cascos en linea / sin senal, ultimo evento), lista de pendientes ordenada por antiguedad con **Atender** y **Ver en vivo**,
estado de cada casco (ver 3) y accesos a Evacuacion y Mensaje. Sonido y titulo con conteo se mantienen.

## 2. Escalamiento automatico (Supabase)
- Tabla `public.escalation_rules` (global, editable solo admin): `id`, `after_seconds` (def. 60), `channel` (`'teams'`), `enabled`,
  `message_template`. Tabla `public.escalations` (log; evita duplicados): `event_id`, `rule_id`, `sent_at`, `ok`, `detail` (sin secretos).
- Edge Function `escalate` (verify JWT apagado, protegida por secreto de cabecera `x-escalate-key`/`?k=` comparado en tiempo constante;
  secretos `ESCALATE_SECRET`, `ESCALATION_WEBHOOK_URL` = URL de webhook entrante de Teams/Power Automate, nunca en el repo):
  busca `events` `type in ('sos','fall','geofence')` de los ultimos 30 min **sin** fila en `event_acks` y con antiguedad >= `after_seconds`,
  que no tengan fila en `escalations` para esa regla; envia POST JSON al webhook `{"title","text","device_id","type","reason","age_s","lat","lng","map_url"}`
  y registra en `escalations`. Reintento 1 vez; no loguea la URL.
- Disparo: `pg_cron` + `pg_net` cada 1 minuto (idempotente; extension habilitada en la migracion si no lo esta).
- Tambien aviso inmediato opcional (`after_seconds = 0`) a un segundo webhook.
- Aviso por **correo** (independiente de Teams; inmediato y recordatorio si nadie atiende): ver `docs/PROTOCOLO-AVISOS.md` (migracion 014, Edge Function `notify`).

## 3. Salud del equipo
- El agente agrega a cada heartbeat (5 min; 30 s mientras hay alerta o video) `payload`:
  `{"bat":87,"chg":true,"temp_c":31.5,"sig":-98,"lvl":3,"net":"LTE","sim":1,"app":"0.2.0","free_mb":20400,"up_s":5400,"rot":90,...}`.
  `rot/ori/sens/enc` de la orientacion siguen igual.
- Web: panel por casco con bateria (barra), senal, temperatura, almacenamiento libre, version, tiempo encendido; alertas derivadas en el cliente:
  bateria < 20 % (< 10 % critica), sin heartbeat > 12 min (sin senal), temperatura > 45 C, almacenamiento libre < 1 GB.
  Las alertas de equipo NO requieren "Atender" (son informativas) y se muestran arriba del Centro.

## 4. Evacuacion y mensajes de supervisor (texto a voz)
Tabla `public.broadcasts`: `id`, `kind` (`'evacuacion'`,`'mensaje'`), `message` (<= 200), `device_ids text[] null` (null = todos),
`repeat` (1..5, def. 3), `created_by`, `created_by_email`, `created_at` (servidor). INSERT: viewer/admin (grants por columna: `kind,message,device_ids,repeat`),
rate limit 6/min por usuario; sin UPDATE/DELETE. SELECT: viewer/admin todo; `device`: los de los ultimos 2 min con `device_ids` null o que lo incluyan.
Tabla `public.broadcast_acks`: `broadcast_id`, `device_id`, `played_at` (INSERT del casco con su device_id; viewer/admin leen) para mostrar
"recibido por 3 de 3 cascos".
- Casco: junto al poll de comandos (3 s) consulta `broadcasts` y dedupe por `id` (persistente en memoria + archivo); **evacuacion**: sirena `STREAM_ALARM` volumen
  alto + voz es-AR "Atencion. Evacuacion. <message o 'Dirijase al punto de reunion'>" repetida `repeat` veces cada ~8 s;
  **mensaje**: "Mensaje del supervisor: <message>" una vez (o `repeat`). No interrumpe una llamada activa: espera al fin (max 60 s) y avisa por beep.
- Web: botones **Evacuacion** (confirmacion en dos pasos con texto "EVACUACION GENERAL") y **Mensaje a cascos** (caja de texto, casco destino o todos),
  historial de ordenes con estado de recepcion por casco.

## 5. Grabacion de video y descarga A LA PC (decision del usuario: nada se guarda en el servidor)
La grabacion ocurre **en el navegador del supervisor** y el archivo se descarga directo a la carpeta de descargas de su PC.
El servidor NO graba (MediaMTX sin `record`, sin `playback`) ni se crean tablas de clips.
- Boton **Grabar** / **Detener** en cada panel de video en vivo (junto a Iniciar/Detener): contador de tiempo y tamano.
- Pipeline: el video recibido se dibuja en un `<canvas>` aplicando el **giro actual** (la grabacion queda derecha) con una
  marca opcional de **fecha, hora y casco** (config `REC_WATERMARK`, por defecto true); `canvas.captureStream(15)` -> `MediaRecorder`.
- Formato: `video/mp4;codecs=avc1` si el navegador lo soporta; si no, `video/webm;codecs=vp9` -> `vp8`. Nombre del archivo:
  `casco-<id>_<AAAA-MM-DD_HH-MM-SS>.<ext>`. Al detener se descarga solo y queda el boton **Descargar de nuevo** (hasta cerrar la pagina).
- **Audio incluido (decision del usuario: video Y audio)**: el archivo mezcla (Web Audio `MediaStreamDestination`) las pistas de audio disponibles:
  (a) el **audio del casco** que llega en el video en vivo (ver abajo) o por la llamada de voz, y (b) el **microfono del supervisor** durante una llamada.
  Casillas "Incluir mi microfono" (por defecto activa solo durante llamada) y "Incluir audio del casco" (por defecto activa). Si no hay audio disponible, graba solo video y lo indica.
- **Audio del casco en el video en vivo (Android + Servidor)**: hoy el RTMP del casco es solo video. Se agrega la pista de audio del microfono del casco
  al flujo; WebRTC/MediaMTX no transcodifica, asi que el codec debe ser **Opus o G.711**. El agente Android debe verificar en RootEncoder 2.5.5 si RTMP
  soporta G.711 (PCMA/PCMU) u Opus; si no, el audio del casco solo estara presente durante la llamada WebRTC (que ya es Opus) y se grabara de ahi.
  Configuracion `stream_audio` (por defecto false hasta validar; el microfono NO se activa sin esa opcion y sin aviso en pantalla).
- Aviso legal: grabar audio de conversaciones requiere informar al personal; la plataforma muestra "Esta grabacion incluye audio".
- Limites: tope 60 min y ~1 GB en memoria por grabacion (aviso a los 45 min; al llegar al tope se corta y descarga); si la conexion de video se
  cae, la grabacion se cierra y descarga lo grabado. Si el navegador no soporta MediaRecorder: mensaje claro.
- Tambien un boton **Captura** (PNG con el giro aplicado) para guardar una imagen.
- Privacidad: aviso "La grabacion se guarda solo en tu PC. Informe al personal"; la plataforma no conserva copias.

## 6. Orden de ejecucion y reparto
| Agente | Alcance | Carpeta |
|---|---|---|
| Supabase | migracion 005: escalation_rules/escalations, broadcasts/broadcast_acks, extension de `events.type` si hace falta; Edge Function `escalate` + cron; tests RLS; SETUP (SIN clips) | `supabase/` |
| Servidor | sin cambios (la grabacion es en el navegador) | `server/` |
| Android | payload de salud, poll de `broadcasts` + sirena/voz + `broadcast_acks` | `android/` (tras terminar la tanda 1) |
| Web | Centro, salud, evacuacion, mensajes, grabaciones, escalamiento (config minima) | `web/` (tras terminar la tanda 1) |
