# turn-credentials (Edge Function)

El visor y el casco la llaman con su token de Supabase y reciben credenciales TURN que vencen en 1 hora (para la voz en vivo, ver `docs/PROTOCOLO-VOZ.md`).

## Contrato
- `GET` o `POST` a `https://zgfvhjpdzkohouktakvt.supabase.co/functions/v1/turn-credentials` con `Authorization: Bearer <JWT>` (y `apikey: <anon key>`).
- Roles permitidos: `device`, `viewer`, `admin` (leidos de `app_metadata` del usuario validado con `auth.getUser`).
- 200: `{"urls":["stun:HOST:3478","turn:HOST:3478?transport=udp","turn:HOST:3478?transport=tcp"],"username":"<exp>:<id>","credential":"<base64 HMAC-SHA1>","ttl":3600}`
- 401 token ausente/invalido; 403 usuario sin rol permitido; 405 metodo; 500 falta `TURN_SECRET`/`TURN_HOST`. Los errores no llevan cuerpo.
- CORS: solo `https://exertion-solutions.github.io` (cambiable con la variable `ALLOWED_ORIGIN`). Responde `OPTIONS`.

## Secretos
| Nombre | Valor |
|---|---|
| `TURN_SECRET` | secreto largo al azar (32+ caracteres). **Tiene que ser IDENTICO a `static-auth-secret` de coturn en el `.env` del VPS** (si difieren, TURN rechaza todo). |
| `TURN_HOST` | IP publica (o dominio) del VPS, sin puerto ni `http://`. El casco no resuelve sslip.io: usar la IP. |
| `ALLOWED_ORIGIN` | opcional; por defecto `https://exertion-solutions.github.io` |

`SUPABASE_URL` y `SUPABASE_ANON_KEY` los inyecta Supabase solo. No se usa `service_role`. `TURN_SECRET` nunca sale en la respuesta y no va al repo.

## Importante: sin "Verify JWT"
Se despliega SIN verificacion de JWT de la plataforma (igual que `media-auth`): la funcion valida el token adentro y asi puede contestar con CORS y estados claros.

## Opcion A: CLI
```
supabase secrets set TURN_SECRET=<secreto-largo> TURN_HOST=<ip-del-vps> --project-ref zgfvhjpdzkohouktakvt
supabase functions deploy turn-credentials --no-verify-jwt --project-ref zgfvhjpdzkohouktakvt
```

## Opcion B: Dashboard (sin instalar nada)
1. **Edge Functions** > **Deploy a new function** > **Via Editor**. Nombre: `turn-credentials`.
2. Borra el codigo de ejemplo y pega TODO `index.ts`. **Deploy**.
3. Abri la funcion > **Details** (o Settings) y **desactiva "Verify JWT"**. Guarda.
4. **Edge Functions** > **Secrets** > **Add new secret**: `TURN_SECRET` y `TURN_HOST` (dos secretos).

## Probar
```
curl -i "https://zgfvhjpdzkohouktakvt.supabase.co/functions/v1/turn-credentials" \
  -H "authorization: Bearer <JWT del supervisor>" -H "apikey: <anon key>"
```
Con un JWT valido: 200 y JSON. Sin token: 401.

## Tests locales
Requiere Deno (https://deno.com): `deno test --allow-env supabase/functions/turn-credentials/test.ts`
No usa red: simula a Supabase Auth.

## Notas
- Cualquier usuario autenticado con rol puede pedir credenciales; valen 1 h y TURN (coturn) debe bloquear destinos privados (`denied-peer-ip`).
- Cambiar `TURN_SECRET` invalida las credenciales vigentes: cambiarlo en la funcion y en el VPS a la vez y reiniciar coturn.
- `TURN_HOST` solo acepta IPv4 o nombre DNS (letras, numeros, punto y guion).
