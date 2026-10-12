# Protocolo de ubicacion, mapa, geocercas, georreferencias y voz por comandos

Segunda ola de desarrollo. Fuente de verdad para Android, Web y Supabase. Complementa `PROTOCOLO-VIDEO.md` y `PROTOCOLO-VOZ.md`.

## 1. Ubicacion (GPS propio, sin AMap)
- El casco tiene GNSS (se vio `GnssStatusListenerHelper`/NMEA). Se usa `LocationManager.GPS_PROVIDER` directo; el proveedor de red no existe.
- Permiso `ACCESS_FINE_LOCATION` (runtime con targetSdk 28: `pm grant`, actualizar `tools/instalar-agente.ps1`).
- Evento `type='location'` con las columnas `lat`, `lng`, `battery` y `payload={"acc":<m>,"spd":<m/s>,"brg":<grados>,"alt":<m>,"src":"gps","n":<satelites>}`.
- Filtros: descartar fixes con `acc > 50 m`; no enviar si no se movio > max(10 m, acc) y paso < intervalo maximo.
- Cadencia adaptativa: **moviendose (> 1 m/s) cada 30 s**, **quieto cada 5 min**, **durante SOS, hombre caido o transmision cada 10 s**.
  Maximo 6/min (el limite del servidor es 30/min por tipo).
- Cola offline: hasta 200 puntos en memoria/archivo; se envian en orden al volver la red (con `payload.t` = epoch ms original,
  porque `created_at` lo fija el servidor).
- **Todo SOS, caida y hombre caido adjunta la ultima posicion conocida** (`lat`,`lng`, `payload.loc_age_s`).
- `events.type` debe aceptar `'location'` y `'geofence'` (migracion nueva).

## 2. Geocercas
Tabla `public.geofences`:
| Columna | Tipo | Notas |
|---|---|---|
| id | uuid pk | |
| name | text | 1-80 caracteres |
| kind | text | `'permitida'` (alerta al SALIR), `'restringida'` (alerta al ENTRAR), `'informativa'` (aviso sin alarma) |
| shape | text | `'circle'` o `'polygon'` |
| geometry | jsonb | circle: `{"center":[lat,lng],"radius_m":150}` (10..50000); polygon: `{"points":[[lat,lng],...]}` (3..100 puntos) |
| device_ids | text[] null | `null` = todos los cascos |
| active | boolean | default true |
| created_by / created_at / updated_at | | fijados por el servidor |
| deleted_at | timestamptz null | baja logica (sin DELETE por API) |

- RLS: `viewer`/`admin` leen e insertan; modifican solo `name`, `kind`, `geometry`, `device_ids`, `active`, `deleted_at`
  (grants por columna; trigger fija `updated_at`); `device` lee solo las activas, no borradas, de su `device_id` o `null`.
- **Evaluacion en el casco** (funciona sin red y avisa al instante): descarga las zonas cada 5 min (REST) y las cachea;
  evalua en cada fix. Histeresis: **3 fixes consecutivos** dentro/fuera o 10 s de permanencia; margen = max(acc, 10 m).
- Evento al cruzar: `type='geofence'`, `lat/lng`, `payload={"zone_id","zone_name","kind","action":"enter"|"exit","dist_m"}`.
  Solo se envia en cambio de estado (no repite).
- Voz (TTS es-AR): restringida/enter: "Atencion. Esta ingresando a una zona restringida: <nombre>";
  permitida/exit: "Atencion. Esta saliendo de la zona de trabajo: <nombre>"; informativa: "Zona <nombre>".
- El visor trata como **alerta que requiere Atender**: `restringida/enter` y `permitida/exit`. El resto es informativo.

## 3. Georreferencias (puntos de interes)
Tabla `public.geo_points`: `id`, `name`, `category` (`'punto_reunion'`,`'extintor'`,`'botiquin'`,`'acceso'`,`'peligro'`,`'otro'`),
`lat`, `lng`, `notes` (<= 500), `active`, `created_by`, `created_at`, `deleted_at`. Mismas reglas RLS que geocercas
(el casco no necesita leerlos en esta etapa).
- En el visor: capa de puntos con icono por categoria; al abrir un SOS se muestra el **punto de reunion mas cercano**
  y la distancia (haversine) respecto de la ultima posicion del casco.

## 4. Mapa en el visor (pestana "Mapa")
- Leaflet 1.9.4 (version fijada, desde cdnjs) + teselas OpenStreetMap con atribucion obligatoria
  ("© OpenStreetMap contributors"); uso liviano. Plan B si crece el trafico: proveedor con clave propia.
- Marcadores por casco: color por estado (en linea / sin senal / alerta), bateria, hora de la ultima posicion;
  recorrido (polilinea) de las ultimas 2 h consultando `events` `type='location'`; marcadores de SOS/caida con su tarjeta.
- Herramientas para supervisores: dibujar circulo (centro + radio) o poligono (clics + cerrar), nombrar, elegir tipo,
  guardar, activar/desactivar, editar nombre/tipo, eliminar (baja logica); agregar punto de interes con clic derecho/mantener.
- Capas conmutables (cascos, recorrido, geocercas, puntos). Centrar en un casco. Si las teselas no cargan, mostrar aviso
  y mantener coordenadas en texto. Sin dependencias fuera de Leaflet.
- Accesibilidad: lista alternativa en texto (cascos y zonas con coordenadas), foco visible, no solo color.

## 5. Voz por comandos en espanol (activacion por voz, sin nube)
- Reconocimiento **offline** con Vosk (`com.alphacephei:vosk-android`, Apache-2.0) y modelo `vosk-model-small-es` (~40 MB),
  que NO va en el APK: se copia por ADB a `/sdcard/Android/data/ar.exertion.casco/files/vosk-model-es/` (`tools/`).
- Palabra de activacion **"casco"** + comando (evita falsos positivos). Comandos (gramatica cerrada):
  | Frase | Accion |
  |---|---|
  | "casco, emergencia" / "casco, auxilio" / "casco, socorro" | SOS con 5 s para cancelar ("diga cancelar") |
  | "casco, cancelar" | cancela cuenta regresiva (hombre caido o SOS por voz) |
  | "casco, foto" | saca una foto |
  | "casco, iniciar video" / "casco, detener video" | transmision de video |
  | "casco, estado" | dice bateria, senal y si hay video |
  | "casco, ayuda" | dice la lista de comandos disponibles (en espanol) |
- Config `voice_commands` (por defecto **false** hasta validar en campo), `voice_wake_word` ("casco").
- El microfono se libera durante llamadas WebRTC y mientras el casco habla (evita auto-disparo). Bateria: reconocimiento
  solo con pantalla/servicio activos, nunca con el casco sin movimiento > 10 min (config `voice_idle_off_minutes`).
- Todas las instrucciones y respuestas habladas del casco son en **espanol rioplatense (es-AR)**.

## 6. Privacidad y cumplimiento
- Ubicacion de personas = dato personal (Ley 25.326): informar al trabajador, limitar a la jornada, retencion acotada
  (recorridos 30 dias; configurable) y acceso solo a supervisores.
- El visor no exporta ni comparte recorridos fuera de la sesion autenticada.
