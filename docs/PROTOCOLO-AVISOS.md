# Avisos por correo de alertas

Fuente de verdad para Supabase (migracion 014 y Edge Function `notify`) y Web (visor). Complementa PROTOCOLO-CENTRO (seccion 2: escalamiento a Teams,
que sigue igual) y PROTOCOLO-COMANDOS (que alertas requieren atencion).
Objetivo: que una alerta llegue por **correo** a los responsables aunque nadie este mirando el panel, y que si nadie la atiende se repita una vez como recordatorio.
Todo viene **apagado** (`notify_config.enabled = false`) hasta que el dueño lo active.

## 1. Que dispara un aviso

Severidad (misma tabla que `sevOf` de `web/app.js` y que `public.notify_severity()` de la migracion y `severity()` de la funcion):

| Evento | Severidad | Nivel de destinatario que lo recibe |
|---|---|---|
| `sos`, `fall` | 3 critica | critica, alta, media |
| `inactive`, `geofence` peligro + enter | 2 alta | alta, media |
| `not_worn`, `geofence` restringida + enter, permitida + exit | 1 media | media |
| el resto (`photo`, `video`, `heartbeat`, `location`, `equip`, `fall_cancel`, salir de peligro) | 0 | nunca |

- **Inmediato**: un trigger `AFTER INSERT` en `events` llama a la funcion (via `pg_net`) apenas entra el evento. Nunca bloquea el insert: todo va
  dentro de `exception when others` (solo emite un warning).
- **Recordatorio**: `pg_cron` cada minuto (`public.notify_reminders()`). Para alertas **criticas o altas** sin fila en `event_acks`, de hace mas de
  `remind_after_s` (180 s por defecto) y de menos de 60 min, pide **un** recordatorio por evento. Tambien reintenta envios en `error`
  (o colgados en `enviando`) de los ultimos 30 min, hasta 5 intentos. Las alertas de severidad media solo tienen aviso inmediato.
- **Atendida** significa exactamente "existe una fila en `event_acks` para el evento". Un fallo de lectura NO se toma como atendida: la funcion
  responde 500 y el cron reintenta.
- **Cooldown** (`cooldown_s`, 300 s): no se manda otro aviso del mismo tipo (inmediato/recordatorio) para el mismo casco si ya salio uno `ok` en ese
  lapso. El evento omitido no se pierde: el recordatorio lo cubre si sigue sin atender.
- **Idempotencia**: `notify_log` con `unique (event_id, kind)`, `kind in ('inmediato','recordatorio')`. El claim es atomico (`notify_claim`): un envio
  `ok` no se repite; uno en `error`/`enviando` se retoma pasados 60 s, maximo 5 intentos.

## 2. Contrato de datos (migracion `supabase/migrations/014_avisos_correo.sql`)

| Objeto | Detalle |
|---|---|
| `notify_config` | fila unica (`id = 1`): `enabled` (def. false), `webhook_secret` (clave que usa el trigger; la genera `notify_bootstrap()`), `webhook_url` (canal de envio, https <= 500), `resend_from` (remitente de Resend), `remind_after_s` (30..86400, def. 180), `cooldown_s` (0..86400, def. 300). Solo admin (RLS + `aa_admin_only_trg`). Por la API el admin **no lee** `webhook_secret`, `webhook_url` ni `resend_from` (solo escribe las dos ultimas; la URL, por la rpc); `webhook_secret` no se escribe por la API. |
| `notify_recipients` | `email` (pk, minusculas, formato validado, sin comas), `active`, `min_severity` in `critica|alta|media` (def. `alta`), `created_at`. Solo admin: viewer, auditor y device no la leen. |
| `notify_log` | `event_id`, `kind`, `status` (`enviando|ok|error`), `attempts`, `channel`, `recipients` (cantidad, nunca los correos), `detail`, `sent_at`. La escribe la funcion (service_role); la lee el admin. Se borra en cascada con el evento (`casco_purge`). |
| `notify_status()` | RPC para viewer/admin/auditor: `{ready}` (activado y con clave cargada). Si es admin agrega `enabled, secret_ok, channel_ok, from_ok, recipients, remind_after_s, cooldown_s` (solo booleanos y numeros: nunca la URL ni la clave). device/anon: rechazado. |
| `notify_bootstrap()` | RPC solo admin. Si `webhook_secret` esta vacio lo genera (64 hex de dos `gen_random_uuid()`); idempotente; devuelve `true` si la clave existe al terminar, nunca su valor. El visor la llama sola al abrir el bloque. |
| `notify_set_channel(p_url)` | RPC solo admin. Valida `https://` (sin espacios, <= 500) y guarda `webhook_url`; vacio = quitar. Devuelve `true` si quedo configurado. Error `22023` si la URL es invalida. |
| funciones internas | `notify_on_event`, `notify_post`, `notify_reminders`, `notify_claim`, `notify_severity`: `SECURITY DEFINER`, `search_path` vacio, sin EXECUTE para anon/authenticated (salvo `notify_status`). |
| job | `casco-notify-reminders`, `* * * * *`, `select public.notify_reminders()` (si `pg_cron` no esta disponible la migracion lo avisa con un NOTICE y sigue). |

El trigger manda `POST https://<ref>.supabase.co/functions/v1/notify` con cabecera `x-notify-secret: <webhook_secret>` y cuerpo
`{"event_id":"<uuid>","kind":"inmediato"}`. La funcion **vuelve a leer** el evento de la base: no confia en nada del cuerpo.

## 3. Edge Function `notify` (`supabase/functions/notify/index.ts`)

Se despliega **sin "Verify JWT"** (pg_net y pg_cron no mandan token). **No necesita ninguna variable de entorno**: con `service_role` lee de `notify_config`
la clave (`webhook_secret`) y el canal (`webhook_url`, `resend_from`). La proteccion es el secreto de cabecera, comparado en tiempo constante contra el
secreto de la **tabla** (y tambien contra `NOTIFY_SECRET` si existe en el entorno). Sin ninguno de los dos la funcion falla cerrada (401).

Variables de entorno, **todas opcionales** (respaldo o extras):

| Variable | Que es |
|---|---|
| `NOTIFY_SECRET` | clave alternativa para `x-notify-secret` (ademas de la de la tabla). |
| `NOTIFY_WEBHOOK_URL` | canal (a) de respaldo si la tabla no tiene `webhook_url`. |
| `RESEND_API_KEY` | canal (b): la API key de Resend **solo** existe como variable de entorno (no se guarda en la tabla). El remitente sale de `resend_from` o de `NOTIFY_FROM`. |
| `NOTIFY_VIEWER_URL` | enlace al visor; por defecto `https://exertion-solutions.github.io/casco-inteligente/`. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | los inyecta Supabase. No copiarlos en ningun lado. |

Canal (a) = la URL de la tabla (o `NOTIFY_WEBHOOK_URL`); si hay (a) y (b) se intenta primero (a) y, si falla, (b).

**Autenticacion**: `x-notify-secret` (pg_net/pg_cron) o `Authorization: Bearer <JWT de un admin>` **solo** para `{"test":true}`.

**Cuerpo y respuestas**

| Cuerpo | Efecto |
|---|---|
| `{"event_id":"<uuid>","kind":"inmediato"\|"recordatorio"}` | aviso real (solo con secreto) |
| `{"test":true}` | correo de prueba a todos los destinatarios activos; no toca `notify_log` y funciona aunque `enabled = false` |

| Codigo | Significado |
|---|---|
| 200 `{ok, sent, ...}` | enviado, o `skipped` con motivo: `desactivado`, `no_requiere_atencion`, `severidad_baja`, `atendida`, `cooldown`, `ya_enviado_o_en_curso`, `sin_destinatarios` |
| 400 | cuerpo/evento invalido |
| 401 | secreto o JWT ausente/incorrecto/no admin |
| 403 | un JWT de admin intento un aviso real (solo se permite la prueba) |
| 404 | el evento no existe |
| 409 | prueba sin destinatarios activos |
| 502 | el canal rechazo el envio (queda `error` en `notify_log`; el cron reintenta) |
| 503 `{error:"canal_no_configurado"}` | no hay webhook ni Resend; se registra `sin_canal` en `notify_log` |
| 500 | error interno (sin detalles) |

**Webhook generico** (canal a): `POST` JSON
```json
{"to":["nombre@ejemplo.com"],"subject":"ALERTA CRÍTICA: SOS (botón de emergencia) - casco 4132",
 "text":"...","html":"...","severity":"critica","event_id":"<uuid>"}
```
`severity` es `critica|alta|media` (o `prueba`); `event_id` es `null` en la prueba. Cualquier 2xx cuenta como entregado. No se siguen redirecciones.

**Correo**: asunto y cuerpo en español rioplatense: que paso, casco (id y nombre), hora de Argentina (UTC-3, dd/mm/aaaa HH:MM), antiguedad,
ubicacion con enlace a Google Maps, enlace al visor, y si es recordatorio. Los textos que vienen del casco se limpian (solo letras, numeros y
signos simples) y el HTML se escapa. La funcion no escribe ni devuelve correos, URLs ni secretos en logs ni respuestas.

## 4. Visor (web)

- Encabezado "Aviso a responsables": estado real. viewer/auditor ven "por correo activado/desactivado"; admin ve ademas destinatarios y minutos de
  recordatorio, o el motivo si esta activado pero no sale nada (sin clave, sin destinatarios). Si la migracion 014 no esta aplicada se mantiene el
  texto de Teams de siempre.
- **Constancias > Empleador > Avisos por correo** (solo admin): estado ("Canal: configurado / sin configurar" y que falta para que salgan avisos),
  campo **URL del canal de envio** (Power Automate / Make / Zapier; se guarda y no se vuelve a mostrar), activar/desactivar, alta/baja de
  destinatarios con **nivel minimo** (Critica: SOS y caida; Alta: + peligro e inmovilidad; Media: + sin usar y zonas restringidas) y
  **Enviar correo de prueba** (llama a la funcion con el JWT del admin; si falta canal o destinatarios lo dice en claro).
  La clave interna nunca pasa por el visor.

## 5. Como poner en marcha (paso a paso en `supabase/SETUP.md` seccion 17)

Solo la base y el visor; **sin cargar secretos en el panel de Supabase**:

1. SQL Editor: pegar `supabase/migrations/014_avisos_correo.sql` > Run (en un proyecto nuevo ya viene en `ejecutar-todo.sql`).
2. Publicar la funcion `notify` **sin Verify JWT** (`supabase functions deploy notify --no-verify-jwt --project-ref zgfvhjpdzkohouktakvt`, o Dashboard > Edge Functions > Deploy a new function > pegar `index.ts`).
3. Crear el canal: Power Automate (flujo "Cuando se recibe una solicitud HTTP" + accion "Enviar un correo (V2)" con *Para* = `join(triggerBody()?['to'], ';')`, *Asunto* = `subject`, *Cuerpo* = `html`, es HTML = si; el desencadenador HTTP es premium), o Make/Zapier con un webhook.
4. Visor (admin) > Constancias > Empleador > Avisos por correo: pegar la URL del flujo > **Guardar canal**; agregar destinatarios; **Enviar correo de prueba** (debe llegar); recien ahi **Activar avisos**.
5. Verificar un aviso real con una alerta de prueba: `select * from notify_log order by sent_at desc` (`status = 'ok'`, `channel`); los codigos HTTP del trigger estan en `select * from net._http_response order by created desc limit 5`.

Opcional: Resend en lugar de webhook = variable `RESEND_API_KEY` en la funcion + `update notify_config set resend_from = 'Avisos <avisos@su-dominio>'`.

Apagar: `update public.notify_config set enabled = false;` (el trigger y el job siguen pero no llaman a nada). Quitar el job:
`select cron.unschedule('casco-notify-reminders');`. Rotar la clave: `update public.notify_config set webhook_secret = null;` y abrir el bloque en el visor (la regenera).

## 6. Seguridad y limites

- La anon key es publica: toda la proteccion es RLS. `notify_*` son admin-only; los correos de los destinatarios son datos personales (Ley 25.326).
- `webhook_secret`, `webhook_url` y `resend_from` los leen solo el trigger y la funcion (service_role). Nadie los lee por la API, ni siquiera el admin; la URL del canal contiene una firma que permite mandar correos, por eso es solo-escritura.
- Maximo 50 destinatarios por mensaje (tope de la API de Resend); los correos se mandan en un solo mensaje, asi que los destinatarios se ven entre si.
- El recordatorio es **uno** por evento. Si se quiere insistir mas, es un cambio de diseño (no esta implementado).
- No reemplaza al escalamiento a Teams (`escalate`): son independientes y pueden convivir.
- Verificado con PGlite (Postgres en WASM; `net.http_post` y `cron` simulados) y con tests de la funcion en Node con `fetch` simulado. No se probo contra
  pg_net/pg_cron reales, ni con un proveedor de correo real: ver `out/tanda-avisos.md`.
