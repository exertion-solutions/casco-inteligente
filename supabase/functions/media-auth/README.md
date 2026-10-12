# media-auth (Edge Function)

MediaMTX la llama por HTTP en cada conexion (publicar o ver) y ella decide 200 (permitido) o 401 (denegado). Reglas en `docs/PROTOCOLO-VIDEO.md`.

Requiere el secreto `MEDIA_AUTH_SECRET` (lo inventas vos: 32+ caracteres al azar). Sin el, rechaza todo.
`SUPABASE_URL` y `SUPABASE_ANON_KEY` los inyecta Supabase solo. No se usa `service_role`.

## Reglas de acceso
| Accion | Ruta | Quien |
|---|---|---|
| publish | `ingest/<device_id>` (audio del casco) | rol `device`, solo con su propio `device_id` |
| publish | `live/<device_id>` (compatibilidad) | rol `device`, solo con su propio `device_id` |
| read | `ingest/<device_id>` | rol `device`, solo su propio `device_id` (el relay ffmpeg del VPS usa el JWT del casco) |
| read / playback | `live/<device_id>` | `viewer` o `admin` |
| read / playback | `ingest/<device_id>` | **nadie mas** (viewer/admin no leen el ingest) |
| device en `live/` (read), device en `playback`, otra accion (api, metrics, pprof) u otra ruta | | denegado |

Siempre 200 o 401, sin cuerpo.

## Importante: sin "Verify JWT"
MediaMTX no manda el encabezado de Supabase, asi que la funcion se despliega SIN verificacion de JWT de Supabase. La proteccion es el secreto `?k=` (comparado en tiempo constante) mas la validacion del token del casco/visor adentro.

## Opcion A: CLI
```
supabase secrets set MEDIA_AUTH_SECRET=<secreto-largo> --project-ref zgfvhjpdzkohouktakvt
supabase functions deploy media-auth --no-verify-jwt --project-ref zgfvhjpdzkohouktakvt
```

## Opcion B: Dashboard (sin instalar nada)
1. **Edge Functions** > **Deploy a new function** > **Via Editor**. Nombre: `media-auth`.
2. Borra el codigo de ejemplo y pega TODO `index.ts`. **Deploy**.
3. Abri la funcion > **Details** (o Settings) y **desactiva "Verify JWT"**. Guarda.
4. **Edge Functions** > **Secrets** > **Add new secret**: nombre `MEDIA_AUTH_SECRET`, valor el secreto.

## URL final
`https://zgfvhjpdzkohouktakvt.supabase.co/functions/v1/media-auth?k=<MEDIA_AUTH_SECRET>`

Esa URL completa va en `server/.env` como `MEDIA_AUTH_URL=...` (el `.env` NO se sube al repo). MediaMTX la usa como `authHTTPAddress`.

## Probar
Con la URL real (reemplaza K y un token valido):
```
curl -i -X POST "https://zgfvhjpdzkohouktakvt.supabase.co/functions/v1/media-auth?k=K" \
  -H "content-type: application/json" \
  -d '{"action":"read","path":"live/4132","token":"<JWT del supervisor>","protocol":"webrtc"}'
```
200 = permitido, 401 = denegado. Sin `?k=` correcto siempre 401.

## Tests locales
Requiere Deno (https://deno.com): `deno test --allow-env --allow-net supabase/functions/media-auth/test.ts`
No usa red: simula a Supabase Auth.

## Notas
- Cache en memoria de 30 s por token: revocar un usuario puede tardar hasta 30 s en cortar conexiones nuevas (las ya abiertas siguen hasta que se cierren).
- No loguea tokens; solo "deny: motivo action=...".
