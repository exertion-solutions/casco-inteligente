# escalate (Edge Function)

Cada minuto (pg_cron) revisa si hay alertas **sin atender** (SOS, caida, y geocerca restringida/peligro al entrar o permitida al salir)
y las manda a un canal de Teams por webhook. Reglas en `docs/PROTOCOLO-CENTRO.md` seccion 2.

- Solo mira alertas de los ultimos 30 minutos que no tengan "Atender" (`event_acks`) y tengan al menos `after_seconds` de antiguedad.
- No repite: cada (alerta, regla) queda en `public.escalations`. Si el webhook falla, reintenta al minuto siguiente mientras la alerta tenga menos de 30 min.
- Maximo 20 envios por corrida; si el webhook falla 3 veces seguidas corta la corrida y sigue al minuto siguiente. Espera maxima 8 s por envio.
- No guarda ni devuelve la URL del webhook.

## Secretos (Edge Functions > Secrets)
| Nombre | Que es | Quien lo carga |
|---|---|---|
| `ESCALATE_SECRET` | frase larga al azar (32+ caracteres, letras y numeros). Protege la funcion | vos; el mismo valor va a Vault (paso del cron) |
| `ESCALATION_WEBHOOK_URL` | URL del webhook de Teams / Power Automate (ver abajo) | vos |
| `ESCALATION_WEBHOOK_URL_INMEDIATO` | opcional: segundo webhook para reglas con `after_seconds = 0` | vos |
| `ESCALATION_CARD` | opcional: `0` para no mandar la tarjeta (solo texto) | vos |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | los inyecta Supabase solo. **No los copies ni los pegues en ningun lado** | Supabase |

Por que usa `service_role`: la dispara un cron sin ningun usuario y escribe `escalations`, tabla que ningun usuario debe poder escribir
(un `ok=true` falso silenciaria una alerta real). La clave existe solo en el entorno de la funcion; la funcion falla cerrada sin `ESCALATE_SECRET`.
Toca unicamente `escalation_rules`, `events`, `event_acks` y `escalations`.

## Importante: sin "Verify JWT"
pg_net no manda un token de usuario. Se despliega SIN verificacion de JWT; la proteccion es `x-escalate-key` (comparada en tiempo constante).
`?k=` tambien funciona pero queda en logs: usar la cabecera.

## Opcion A: CLI
```
supabase secrets set ESCALATE_SECRET=<secreto> ESCALATION_WEBHOOK_URL=<url-del-webhook> --project-ref zgfvhjpdzkohouktakvt
supabase functions deploy escalate --no-verify-jwt --project-ref zgfvhjpdzkohouktakvt
```

## Opcion B: Dashboard (sin instalar nada)
1. **Edge Functions** > **Deploy a new function** > **Via Editor**, nombre `escalate`.
2. Borra el codigo de ejemplo, pega TODO `index.ts`, **Deploy**.
3. Abri la funcion > **Details** y **desactiva "Verify JWT"**. Guarda.
4. **Edge Functions** > **Secrets** > **Add new secret**: `ESCALATE_SECRET` y `ESCALATION_WEBHOOK_URL`.
5. Programar el minuto a minuto: `supabase/cron_escalate.sql`.

## Crear el webhook (para quien no es tecnico)
**Camino recomendado (no requiere licencia premium): app Workflows de Teams**
1. En Teams, entra al canal donde quieren ver las alertas. Boton **...** del canal > **Workflows**.
2. Busca la plantilla **"Post to a channel when a webhook request is received"** (Publicar en un canal cuando se recibe una solicitud de webhook).
3. Ponele nombre (ej. "Alertas Casco") > **Siguiente** > elegi el equipo y el canal > **Agregar flujo**.
4. Te muestra una **URL**. Copiala (empieza con `https://...logic.azure.com...`): es el valor de `ESCALATION_WEBHOOK_URL`. Tratala como una contrasena: quien la tiene puede publicar en el canal.
5. Esta plantilla muestra la **tarjeta** que manda la funcion (`attachments`). Dejar `ESCALATION_CARD` sin tocar.

**Alternativa en Power Automate** (make.powerautomate.com): **Crear > Flujo de nube instantaneo** > desencadenador *"Cuando se recibe una solicitud HTTP"*
(es premium) o *"Cuando se recibe una solicitud de webhook de Teams"*; accion *"Publicar mensaje en un chat o canal"* con el campo `text` del cuerpo.
Copia la URL del desencadenador.

Cuerpo que recibe el webhook:
```json
{"title":"SOS sin atender - casco 4132","text":"ALERTA SOS sin atender: ...","device_id":"4132","type":"sos",
 "reason":"SOS","age_s":95,"lat":-34.6,"lng":-58.4,"map_url":"https://www.openstreetmap.org/...",
 "attachments":[{"contentType":"application/vnd.microsoft.card.adaptive","content":{...}}]}
```
Nota: `type` es el tipo de evento (`sos`, `fall`, `geofence`), no el `"message"` de los webhooks clasicos.

## Probar
Mensaje de prueba (no toca la base; PowerShell):
```
Invoke-RestMethod -Method Post -Uri "https://zgfvhjpdzkohouktakvt.supabase.co/functions/v1/escalate" `
  -Headers @{ "x-escalate-key" = "<ESCALATE_SECRET>" } -ContentType "application/json" -Body '{"test":true}'
```
Debe aparecer "PRUEBA - Casco Inteligente" en el canal. Cuerpo `{"dry_run":true}` cuenta alertas pendientes sin enviar nada.
Respuesta normal: `{"ok":true,"rules":1,"candidates":0,"sent":0,"failed":0,"skipped":0,"ms":120}`.
Codigos: 401 secreto mal o ausente; 503 falta `ESCALATION_WEBHOOK_URL` (o no es https); 502 el webhook rechazo la prueba.

## Reglas
La regla por defecto (60 s, Teams) viene **desactivada**. Activarla: Table Editor > `escalation_rules` > `enabled = true`
(o desde el visor si tiene la pantalla). `message_template` admite `{tipo} {device_id} {motivo} {edad} {mapa}`.

## Tests locales
Requiere Deno (https://deno.com): `deno test --allow-env --allow-net supabase/functions/escalate/test.ts`
No usa red ni Supabase real (base y fetch simulados).
