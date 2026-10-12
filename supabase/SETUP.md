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

## Si algo falla

| Sintoma | Causa probable |
|---|---|
| El casco no inserta (HTTP 401/403, "row-level security") | falta `device_id` en el rol, o no coincide con el del casco; o no cerro/abrio sesion tras asignar rol |
| El visor dice "Sin permiso" | el usuario no tiene `role` viewer/admin, o falta volver a iniciar sesion |
| Las fotos no se ven | el evento tiene `media_path` vacio (fallo la subida) o el archivo supera 50 MB |
| HTTP 429 / "rate limit" en el casco | mas de 30 eventos del mismo tipo por minuto (limite anti-abuso) |
| El video no arranca: el servidor responde 401 | secreto distinto entre la funcion y `MEDIA_AUTH_URL`, "Verify JWT" sigue activado, o el usuario no tiene el rol/`device_id` correcto |
| "rate limit" al pedir video | mas de 10 comandos start/stop en un minuto |
