# Protocolo de video propio (piloto casco 4132)

Fuente de verdad para los 4 componentes. Si algo aqui no cierra, se corrige AQUI primero.

```
Casco (app agente + RootEncoder)  --RTMP-->  MediaMTX (VPS)  --WebRTC/WHEP-->  Visor (GitHub Pages)
        ^   poll comandos                          |  auth HTTP                          |  inserta comandos
        |                                          v                                     v
        +------------ Supabase (REST, RLS) <--- Edge Function media-auth ---------- Supabase Auth (JWT)
```

## Constantes
| Item | Valor |
|---|---|
| Ruta de stream | `live/<device_id>` (ej. `live/4132`) |
| Ingest | `rtmp://<LIVE_HOST>:1935/live/<device_id>?user=device&pass=<SUPABASE_ACCESS_TOKEN>` |
| Reproduccion | WHEP `https://<LIVE_HOST>/live/<device_id>/whep` con `Authorization: Bearer <SUPABASE_ACCESS_TOKEN>` |
| Auth de MediaMTX | `authMethod: http` -> POST a la Edge Function `media-auth` (ver abajo) |
| Perfil por defecto | 640x480, 15 fps, 800 kbps, keyframe cada 2 s, H.264 baseline, audio desactivado |
| Config del casco (config.json) | `stream_host`, `stream_width`, `stream_height`, `stream_fps`, `stream_bitrate_kbps` (opcionales salvo `stream_host`) |
| Config del visor (web/config.js) | `LIVE_HOST` (dominio del VPS, sin esquema) |

## Tabla de comandos (Supabase)
```
public.stream_commands(
  id uuid pk default gen_random_uuid(),
  device_id text not null,            -- formato ^[A-Za-z0-9_-]{1,64}$
  action text not null check (action in ('start','stop')),
  requested_by uuid not null default auth.uid(),
  requested_by_email text not null default coalesce(auth.jwt()->>'email',''),
  created_at timestamptz not null default now()   -- fijado por servidor
)
```
- INSERT: role `viewer`/`admin`. SELECT: viewer/admin todo; role `device` SOLO filas con `device_id = jwt_device_id()` y `created_at > now() - interval '2 minutes'`.
- Sin UPDATE ni DELETE. Rate limit: 10 comandos/min por (usuario).
- El casco consulta cada 3 s (REST, `order=created_at.desc&limit=1`); si el ultimo comando vigente es `start` y no esta transmitiendo, arranca; si es `stop` o vencio (>120 s sin `start` nuevo), detiene. **Tope duro de transmision: 10 min** por comando.
- SOS/caida en el casco: arranca transmision local automaticamente por 120 s (sin esperar comando).

## Edge Function `media-auth` (Supabase, Deno)
MediaMTX envia `POST` JSON: `{ user, password, token, ip, action, path, protocol, id, query }`.
- Extraer el JWT: `token` (WHEP Bearer) o `password` (RTMP `pass=`).
- Validar con `supabase.auth.getUser(jwt)` usando la anon key (sin service_role). Rol en `user.app_metadata.role`.
- `action == "publish"`: exigir role `device` y `app_metadata.device_id == nombre de path tras "live/"`. 
- `action == "read"` (y `playback`): exigir role `viewer`/`admin`.
- Cualquier otra accion (api, metrics, pprof): 401. Responder 200 permitido / 401 denegado, sin cuerpo con datos.

## Seguridad
- RTMP en claro lleva el JWT en la URL: aceptado para el piloto (vence en 1 h); mejora: RTMPS.
- El VPS solo abre 22 (solo tu IP), 80/443 (Caddy), 1935 (RTMP) y 8189 UDP+TCP (ICE de WebRTC). API/metrics/pprof/rtsp/hls/srt de MediaMTX apagados (con authMethod http tambien irian a la funcion).
- Version fijada: MediaMTX v1.21.2 + Caddy 2.8. La Edge Function se despliega con `--no-verify-jwt` (MediaMTX no manda el header de Supabase) y se protege con `?k=<MEDIA_AUTH_SECRET>`.
- El payload de auth de MediaMTX incluye ademas `userAgent`; el Bearer de WHEP llega en `token` y el `pass=` de RTMP en `password` (la funcion acepta ambos).
- Nada de secretos en el repo (publico).


## 6. Actualizacion: audio del casco (ruta de ingreso `ingest/`)
- El casco con `stream_audio=true` publica H.264 + AAC en `rtmp://<host>:1935/ingest/<id>?user=device&pass=<jwt>`. MediaMTX (imagen `-ffmpeg`)
  ejecuta `relay-audio.sh`: copia el video, convierte el audio a Opus y republica en `live/<id>`. El visor sigue leyendo `live/<id>/whep`.
- El casco sin audio puede seguir publicando directo en `live/<id>` (compatibilidad).
- Reglas de `media-auth` (accion x ruta): `device` publica en `live/<su id>` e `ingest/<su id>`; `device` lee SOLO `ingest/<su id>`
  (lo usa el relay con el JWT del casco por RTSP loopback); `viewer/admin` leen/playback SOLO `live/<id>`; todo lo demas 401 sin cuerpo.
- RTSP: ya no esta apagado; escucha solo en 127.0.0.1:8554 (TCP) dentro del contenedor, sin publicarse.
