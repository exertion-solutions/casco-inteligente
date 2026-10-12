# Casco Inteligente: puesta en marcha de Supabase (de cero)

Proyecto: https://supabase.com/dashboard/project/zgfvhjpdzkohouktakvt
Tiempo: unos 15 minutos. No hace falta instalar nada.

> Regla de oro: la clave `service_role` NUNCA se copia a ningun archivo ni al repo (es publico). Solo se usa la clave `anon`, que ya esta en el proyecto.

## 1. Crear tablas, permisos y bucket

1. Menu izquierdo: **SQL Editor** > **New query**.
2. Abri el archivo `supabase/schema.sql`, copia TODO su contenido y pegalo.
3. Boton **Run**. Debe decir `Success. No rows returned`.
   Se puede volver a ejecutar cuantas veces quieras sin problema.

## 2. Cerrar el registro publico

1. **Authentication** > **Sign In / Providers** (o **Providers**) > **Email**.
2. Desactiva **Allow new users to sign up** (Permitir registros nuevos). Guarda.
3. En la misma seccion, verifica que **Allow anonymous sign-ins** este desactivado.

Con esto nadie puede crearse una cuenta por su cuenta; solo vos creas usuarios.

## 3. Crear los 2 usuarios

**Authentication** > **Users** > **Add user** > **Create new user**:

| Usuario | Email de ejemplo | Para que |
|---|---|---|
| Casco | `casco-4132@tudominio.com` | lo usa el agente Android |
| Supervisor | `supervisor@tudominio.com` | lo usa el visor web |

- Para cada uno: pone una contrasena larga y **marca "Auto Confirm User"**.
- Guarda las contrasenas en tu gestor de contrasenas (no en el repo).

## 4. Asignar roles

1. **SQL Editor** > **New query**, pega esto cambiando los emails (y el numero `4132` por el `device_id` que tiene el casco en su configuracion; tienen que ser IGUALES):

```sql
update auth.users set raw_app_meta_data =
    coalesce(raw_app_meta_data,'{}'::jsonb) || '{"role":"device","device_id":"4132"}'
  where email = 'casco-4132@tudominio.com';

update auth.users set raw_app_meta_data =
    coalesce(raw_app_meta_data,'{}'::jsonb) || '{"role":"viewer"}'
  where email = 'supervisor@tudominio.com';

select email, raw_app_meta_data from auth.users;
```

2. **Run**. En la tabla final cada email debe mostrar su `role` (y el casco su `device_id`).
3. Si el casco o el visor ya estaban con sesion iniciada: cerrar sesion y volver a entrar (el rol viaja dentro del token).

Un casco mas = un usuario mas con su propio `device_id`.

## 5. Verificar Realtime en la tabla `events`

1. **Database** > **Publications** (en algunas versiones: **Database** > **Replication**).
2. Abri `supabase_realtime`; la tabla `events` debe estar con el interruptor **activado**.
   Si no esta, activala. (El `schema.sql` ya la agrega, esto es solo comprobar.)

## 6. Verificar el bucket de archivos

1. **Storage** > **Buckets**: debe existir `casco-media` marcado como **Private**.
2. Click en el bucket > engranaje/**Edit bucket**: tamano maximo 50 MB y tipos `image/jpeg, image/png, video/mp4`.

## 7. Correr las pruebas de seguridad

1. **SQL Editor** > **New query**, pega TODO `supabase/tests/rls_test.sql`, **Run**.
2. Mira la columna **ok**: tiene que ser `true` en todas las filas. Si hay alguna `false`, no uses el sistema todavia y avisa.
   (No deja datos: cada prueba se deshace sola.)

## 8. Conectar el casco y el visor

- **Casco**: en su archivo de configuracion van la URL del proyecto, la clave `anon`, el email/contrasena del usuario casco y `device_id` (igual al del paso 4).
- **Visor web**: se entra con el email y contrasena del supervisor.
- Prueba final: con el visor abierto, mandar un SOS del casco; debe aparecer en vivo y con sonido.

## 9. Video en vivo (opcional, despues de que todo lo anterior funcione)

El visor pide "ver en vivo" al casco. Hay 3 piezas en Supabase:

**9.1 Tabla de comandos.** **SQL Editor** > **New query**, pega TODO `supabase/migrations/003_stream_commands.sql`, **Run**. Debe decir `Success`. (Si ya usaste `ejecutar-todo.sql` actualizado, ya esta incluido.) Se puede repetir sin problema.

**9.2 Inventar el secreto.** Elegi una frase larga al azar (32 caracteres o mas, solo letras y numeros). Guardala en tu gestor de contrasenas. Se llama `MEDIA_AUTH_SECRET`.

**9.3 Publicar la funcion `media-auth`.**
1. **Edge Functions** > **Deploy a new function** > **Via Editor**, nombre `media-auth`.
2. Pega TODO `supabase/functions/media-auth/index.ts` > **Deploy**.
3. Entra a la funcion y **desactiva "Verify JWT"**. Guarda. (Es a proposito: el servidor de video no tiene un token de Supabase; la funcion se protege con el secreto.)
4. **Edge Functions** > **Secrets** > **Add new secret**: nombre `MEDIA_AUTH_SECRET`, valor tu secreto.

**9.4 Anotar la URL para el servidor de video.** En `server/.env` (archivo local, NUNCA al repo):

```
MEDIA_AUTH_URL=https://zgfvhjpdzkohouktakvt.supabase.co/functions/v1/media-auth?k=TU_SECRETO
```

Despues volve a correr `supabase/tests/rls_test.sql` (paso 7): todo en `true`.

## 10. Voz en vivo (opcional, despues del paso 9)

Permite hablar con el casco desde el visor. Necesita el servidor de voz (coturn) ya instalado en el VPS; esta parte solo prepara Supabase.

**10.1 Tabla de senales.** **SQL Editor** > **New query**, pega TODO `supabase/migrations/004_rtc_signals.sql`, **Run**. Debe decir `Success`. (Si ya usaste `ejecutar-todo.sql` actualizado, ya esta incluido.) Se puede repetir sin problema.

**10.2 Inventar el secreto de voz.** Frase larga al azar (32 caracteres o mas, solo letras y numeros). Guardala en tu gestor de contrasenas. Se llama `TURN_SECRET` y **tiene que ser IGUAL** al que esta en el archivo `.env` del VPS (el del servidor de voz). Si no son iguales, la voz no conecta.

**10.3 Publicar la funcion `turn-credentials`.**
1. **Edge Functions** > **Deploy a new function** > **Via Editor**, nombre `turn-credentials`.
2. Pega TODO `supabase/functions/turn-credentials/index.ts` > **Deploy**.
3. Entra a la funcion y **desactiva "Verify JWT"**. Guarda. (Es a proposito: la funcion revisa el usuario por dentro.)

**10.4 Cargar los dos secretos.** **Edge Functions** > **Secrets** > **Add new secret**, dos veces:

| Nombre | Valor |
|---|---|
| `TURN_SECRET` | el secreto del paso 10.2 |
| `TURN_HOST` | la IP publica del VPS (solo los numeros, sin `http://` ni puerto) |

**10.5 Probar.** Volve a correr `supabase/tests/rls_test.sql` (paso 7): todo en `true`. Despues, con el visor abierto, apreta **Hablar**; el casco debe decir "Llamada del supervisor".

**10.6 (Recomendado) Limpieza automatica.** La tabla `rtc_signals` solo sirve unos segundos. En **Database** > **Extensions** activa `pg_cron` y en **SQL Editor** corre:

```sql
select cron.schedule('casco-purge-rtc-signals', '30 3 * * *',
  $$delete from public.rtc_signals where created_at < now() - interval '1 day'$$);
```

## 11. Centro de mando: escalamiento y ordenes (opcional, despues del paso 10)

Dos cosas: (a) si una alerta (SOS, caida, zona restringida) pasa 60 segundos sin que nadie apriete **Atender**, se avisa sola a un canal de Teams;
(b) el visor puede mandar **Evacuacion** y **Mensajes** que los cascos dicen en voz alta.

**11.1 Crear las tablas.** **SQL Editor** > **New query**, pega TODO `supabase/migrations/005_centro.sql`, **Run**. Debe decir `Success`.
(Si usaste `ejecutar-todo.sql` actualizado, ya esta incluido.) Se puede repetir sin problema. Con esto ya funcionan las ordenes (b).

**11.2 Crear el aviso en Teams** (para el escalamiento, parte a):
1. En Teams, entra al canal donde quieren recibir las alertas. Toca los tres puntos **...** del canal > **Workflows**.
2. Elegi la plantilla **"Post to a channel when a webhook request is received"** (Publicar en un canal cuando se recibe una solicitud de webhook).
3. Poner un nombre (ej. "Alertas Casco") > **Siguiente** > confirmar equipo y canal > **Agregar flujo**.
4. Te muestra una direccion larga que empieza con `https://`. **Copiala**: es como una contrasena (quien la tiene puede escribir en el canal). Guardala en tu gestor de contrasenas.

**11.3 Inventar el secreto y cargarlos.** Frase larga al azar (32 caracteres o mas, letras y numeros) = `ESCALATE_SECRET`; guardala en tu gestor.
**Edge Functions** > **Secrets** > **Add new secret**, dos veces:

| Nombre | Valor |
|---|---|
| `ESCALATE_SECRET` | la frase del paso anterior |
| `ESCALATION_WEBHOOK_URL` | la direccion copiada en 11.2 |

**11.4 Publicar la funcion `escalate`.**
1. **Edge Functions** > **Deploy a new function** > **Via Editor**, nombre `escalate`.
2. Pega TODO `supabase/functions/escalate/index.ts` > **Deploy**.
3. Entra a la funcion y **desactiva "Verify JWT"**. Guarda. (Es a proposito: la llama el reloj de la base de datos, que no tiene usuario; se protege con el secreto.)
   Nota: la funcion usa una clave interna que Supabase le da sola (`SUPABASE_SERVICE_ROLE_KEY`). No la copies a ningun lado.

**11.5 Probar el aviso.** En PowerShell (cambiar `TU_SECRETO`):

```powershell
Invoke-RestMethod -Method Post -Uri "https://zgfvhjpdzkohouktakvt.supabase.co/functions/v1/escalate" `
  -Headers @{ "x-escalate-key" = "TU_SECRETO" } -ContentType "application/json" -Body '{"test":true}'
```

En el canal debe aparecer "PRUEBA - Casco Inteligente". Si da error 401 = secreto distinto; 503 = falta cargar el webhook.

**11.6 Programar el minuto a minuto.**
1. **Database** > **Extensions**: activar `pg_cron` y `pg_net` (si no estan).
2. **SQL Editor** > **New query**: pega y corre este bloque cambiando `PEGAR-AQUI-EL-SECRETO` por tu `ESCALATE_SECRET`. **No lo guardes en ningun archivo**:

```sql
select vault.create_secret('PEGAR-AQUI-EL-SECRETO', 'escalate_secret');
```
   (Si ya existia y queres cambiarlo, usa el bloque comentado del paso 2 de `supabase/cron_escalate.sql`.)
3. **New query** nueva: pega TODO `supabase/cron_escalate.sql` > **Run**. Se puede repetir.

**11.7 Activar la regla.** **Table Editor** > `escalation_rules`: la fila ya existe con `enabled = false`. Ponela en `true` (y si queres, cambia `after_seconds`, que son los segundos de espera).
Prueba real: con el visor abierto, mandar un SOS del casco y NO apretar Atender: a los ~60-120 s debe llegar el aviso a Teams. Si apretas Atender antes, no se manda nada.

**11.8 Ver que paso.** Tabla `escalations`: una fila por alerta avisada (`ok = true` si Teams lo recibio, `detail` dice el codigo). Se puede apagar todo poniendo `enabled = false`.

**11.9** Volve a correr `supabase/tests/rls_test.sql` (paso 7): todo en `true`.

## 12. Mapa, zonas y puntos de peligro (opcional, despues del paso 11)

Permite dibujar en el mapa del visor **zonas** (permitidas, restringidas o solo informativas) y **puntos** (punto de reunion, extintor, botiquin, acceso, peligro). Cuando un casco entra a una zona restringida o se acerca a un punto de **peligro**, suena la alarma en el propio casco. El casco tambien manda su ubicacion cada tanto para ver su recorrido.

**12.1 Crear las tablas.** **SQL Editor** > **New query**, pega TODO `supabase/migrations/006_geo.sql`, **Run**. Debe decir `Success`.
(Si usaste `ejecutar-todo.sql` actualizado, ya esta incluido.) Se puede repetir sin problema.

**12.2 Revisar que quedo bien.** Pega y corre:

```sql
select tablename from pg_tables where schemaname = 'public' and tablename in ('geofences','geo_points');
```

Deben aparecer 2 filas: `geofences` y `geo_points`. En **Database** > **Publications** > `supabase_realtime` ambas deben estar activadas.

**12.3 Probar la seguridad.** Volve a correr `supabase/tests/rls_test.sql` (paso 7): todo en `true`.

**12.4 Usarlo.** En el visor, pestana **Mapa**: dibuja una zona o marca un punto con el supervisor.
- Para **sacar** una zona o punto del mapa, el visor lo da de baja (no se borra de verdad; queda guardado pero deja de verse y de sonar). Una baja no se puede deshacer desde el visor.
- Si queres que una zona suene solo en un casco, elegi ese casco en la lista; si no eliges ninguno, vale para todos.
- Maximo 30 zonas y 30 puntos nuevos por minuto por usuario.

**12.5 (Recomendado) Borrar recorridos viejos.** La ubicacion de las personas es un dato personal: no conviene guardarla para siempre. Se propone **30 dias**. En **Database** > **Extensions** activa `pg_cron` y corre:

```sql
select cron.schedule('casco-purge-location', '20 3 * * *',
  $$delete from public.events where type='location' and created_at < now() - interval '30 days'$$);
```

Avisa a los trabajadores que el casco registra su ubicacion durante la jornada (Ley 25.326).

**12.6 Audio del casco (si el servidor de video lo usa).** La funcion `media-auth` ya acepta que el casco publique audio en la ruta `ingest/` ademas de `live/`. Hay que volver a pegar `supabase/functions/media-auth/index.ts` en **Edge Functions** > `media-auth` > **Deploy** (el secreto y "Verify JWT" quedan como estan).

## 13. Alta de equipos y personas (opcional, despues del paso 12)

Sirve para tener un **registro** de cada casco (numero, IMEI, SIM, auricular), de las **personas** y de **quien tiene que casco**. Los datos personales (DNI y telefono) solo los ve y carga el usuario **admin**.

> El repositorio es publico: **nunca** pegues IMEI, SIM, DNI, telefonos ni nombres reales en un archivo del proyecto. Se cargan a mano en Supabase.

**13.1 Crear las tablas.** **SQL Editor** > **New query**, pega TODO `supabase/migrations/007_equipos.sql`, **Run**. Debe decir `Success`.
(Si usaste `ejecutar-todo.sql` actualizado, ya esta incluido.) Se puede repetir sin problema.

**13.2 Tener un usuario admin.** Para cargar DNI y telefono hace falta un usuario con rol `admin` (el `viewer` carga todo lo demas). Si todavia no lo tenes, en el **SQL Editor** (cambia el email):

```sql
update auth.users set raw_app_meta_data =
    coalesce(raw_app_meta_data,'{}'::jsonb) || '{"role":"admin"}'
  where email = 'supervisor@tudominio.com';
```

Despues, cerrar sesion y volver a entrar en el visor.

**13.3 Cargar los datos reales.**
1. Abri `supabase/seed/equipos.example.sql` (es solo un EJEMPLO con datos inventados). Copialo a un archivo **fuera del repo** (por ejemplo en tus documentos).
2. En la copia, reemplaza los valores de ejemplo por los reales: grupo, `device_id` (el mismo numero que tiene el casco en su configuracion), IMEI (15 digitos; en el casco se ve marcando `*#06#`), ICCID de cada SIM (el numero impreso en la tarjeta), linea, MAC del auricular Bluetooth, personas.
3. Cambia `supervisor@tudominio.com` por el email de tu admin.
4. **SQL Editor** > **New query**, pega TU copia, **Run**.

**13.4 Verificar.** Corre:

```sql
select device_id, name, status from public.devices_full;
select full_name, legajo, job_title from public.people_full;
select * from public.assignments where ends_at is null;
```

**13.5 Reglas a tener en cuenta.**
- Un casco tiene **una sola persona a la vez** y una persona **un solo casco a la vez**: al asignar uno nuevo, la asignacion anterior se cierra sola y queda en el historial.
- Nada se borra: para sacar un casco, persona o grupo se da de **baja** (se guarda pero deja de aparecer). La baja no se deshace desde el visor.
- El `device_id` de un casco no se puede cambiar despues de creado.
- El casco solo puede ver su propia ficha, sin IMEI ni SIM.
- Maximo 30 altas por minuto por usuario.

**13.6** Volve a correr `supabase/tests/rls_test.sql` (paso 7): todo en `true`.

## Si algo falla

| Sintoma | Causa probable |
|---|---|
| El casco no inserta (HTTP 401/403, "row-level security") | falta `device_id` en el rol, o no coincide con el del casco; o no cerro/abrio sesion tras asignar rol |
| El visor dice "Sin permiso" | el usuario no tiene `role` viewer/admin, o falta volver a iniciar sesion |
| Las fotos no se ven | el evento tiene `media_path` vacio (fallo la subida) o el archivo supera 50 MB |
| HTTP 429 / "rate limit" en el casco | mas de 30 eventos del mismo tipo por minuto (limite anti-abuso) |
| El video no arranca: el servidor responde 401 | secreto distinto entre la funcion y `MEDIA_AUTH_URL`, "Verify JWT" sigue activado, o el usuario no tiene el rol/`device_id` correcto |
| "rate limit" al pedir video | mas de 10 comandos start/stop en un minuto |
| La voz no conecta o se corta enseguida | `TURN_SECRET` distinto entre Supabase y el `.env` del VPS, `TURN_HOST` mal cargado, o puertos 3478 / 49160-49200 cerrados en el VPS |
| El visor dice "Sin permiso" al hablar | el usuario no tiene `role` viewer/admin o falta volver a iniciar sesion; la funcion responde 403 |
| "rate limit" al hablar | mas de 60 senales por minuto en la misma llamada (limite anti-abuso) |
| No llega el aviso a Teams | la regla sigue en `enabled = false`; falta `ESCALATION_WEBHOOK_URL`; "Verify JWT" sigue activado; el cron no esta programado (`select * from cron.job`) o el secreto de Vault no es igual a `ESCALATE_SECRET` (en `net._http_response` aparece 401) |
| "rate limit" al mandar ordenes | mas de 6 evacuaciones/mensajes en un minuto por supervisor (limite anti-abuso) |
| El casco no confirma una orden ("recibido por X de Y") | la orden tiene mas de 2 minutos; el casco solo puede confirmar ordenes recientes |
| "rate limit" al crear zonas o puntos | mas de 30 por minuto por supervisor (limite anti-abuso) |
| El casco no recibe una zona | esta inactiva o dada de baja; esta dirigida a otro casco; o el casco aun no la descargo (cada 5 min) |
| Error al guardar una zona ("violates check constraint") | radio fuera de 10..50000 m, menos de 3 puntos, coordenadas fuera de rango o nombre vacio |
| Audio del casco: el servidor responde 401 | falta volver a desplegar `media-auth` (paso 12.6) o el `device_id` del usuario no coincide con el del casco |
| "permission denied for table devices" o "people" desde el visor | se pidieron todas las columnas (`*`): usar la lista de columnas, o las vistas `devices_full` / `people_full` |
| `people_full` vacia | el usuario no es `admin` (un `viewer` ve solo nombre, puesto, sector y grupo) |
| "dni y telefono solo los edita un admin" | cargar esos dos campos con un usuario `admin` |
| "asignacion ... casco inexistente o dado de baja" / "persona inactiva" | el casco o la persona no existen, estan dados de baja o inactivos |
