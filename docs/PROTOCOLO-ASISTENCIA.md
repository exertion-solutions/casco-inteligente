# Tanda C: asistencia remota registrada, constancias, auditoría y evidencia íntegra

Fuente de verdad para Supabase, Web y Android. Complementa PROTOCOLO-VIDEO/VOZ/GEO/CENTRO/COMANDOS.
Objetivo: (1) registrar las sesiones de asistencia remota (supervisor guía al operario), (2) constancias digitales de entrega de EPP y de
capacitación (Disp. GP 2/2022 y 3/2022, DI-2021-2), (3) auditoría de accesos y perfil auditor de solo lectura, (4) huella SHA-256 de fotos y videos.
Todo inmutable salvo lo indicado: nada de DELETE; correcciones = registro nuevo que referencia al anterior (`supersedes`).

## 1. Roles
`app_metadata.role` in `device | viewer | admin | auditor`. `auditor` = solo lectura de lo que figura abajo; no escribe nada, no ve comandos ni media firmada
de otros recursos que no sean evidencia (SELECT en `events`, `event_acks`, `incident_report`, `assist_sessions`, `epp_deliveries`, `training_records`,
`training_attendees`, `access_log`, `devices`; `people` sin columnas personales sensibles: sin `dni`, `phone`). `viewer` y `admin` conservan lo existente.

## 2. `public.assist_sessions` (sesiones de asistencia remota)
`id uuid pk default gen_random_uuid()`, `device_id text not null` (^[A-Za-z0-9_-]{1,64}$), `started_at timestamptz not null default now()` (servidor),
`ended_at timestamptz null`, `topic text` (<= 200), `outcome text null check in ('resuelto','derivado','sin_resolver')`, `note text` (<= 1000),
`photos int not null default 0`, `opened_by uuid default auth.uid()`, `opened_by_email text default jwt email`, `closed_by_email text null`.
- INSERT: `viewer`/`admin` (columnas permitidas: device_id, topic). Rate limit 20/min por usuario.
- UPDATE (cerrar): solo quien la abrió o `admin`, y solo mientras `ended_at is null`; columnas: `ended_at` (trigger lo fija a now()), `outcome`, `note`,
  `photos`. Una vez cerrada no se modifica. Sin DELETE.
- SELECT: viewer/admin/auditor. Publicada en Realtime.
- Vista `public.assist_report` (security_invoker): sesión, casco, nombre del casco, duración en segundos (`dur_s`), outcome, abierta por, nota.

## 3. Constancia de entrega de EPP — `public.epp_deliveries`
`id uuid pk`, `person_id uuid not null references people`, `device_id text null`, `item text not null` (<= 120), `quantity int not null default 1 check (1..999)`,
`model text` (<= 120), `brand text` (<= 120), `certified boolean not null` (posee certificación sí/no), `cert_ref text null` (<= 200),
`delivered_at date not null default current_date`, `worker_ack text not null check in ('conforme','con_observaciones','no_firma')`, `observation text` (<= 500),
`supersedes uuid null references epp_deliveries`, `created_by uuid default auth.uid()`, `created_by_email text`, `created_at timestamptz default now()`.
INSERT: `admin` y `viewer`. Sin UPDATE/DELETE. SELECT: viewer/admin/auditor (con persona vía `people`; el auditor sin dni/phone).
Campos exigidos por Disp. GP 3/2022: empleador (config de la organización: ver 6), trabajador (nombre, apellido, DNI, puesto, conformidad), EPP (producto,
cantidad, tipo/modelo, marca, certificación sí/no, fecha de entrega), campo libre.

## 4. Constancia de capacitación — `public.training_records` + `public.training_attendees`
`training_records`: `id uuid pk`, `held_at timestamptz not null`, `topic text not null` (<= 200), `trainer text not null` (<= 120), `modality_place text check in
('presencial','virtual')`, `modality_sync text check in ('sincronica','asincronica')`, `assisted boolean not null`, `duration_min int null check (1..1440)`,
`supersedes uuid null`, `created_by`, `created_by_email`, `created_at`.
`training_attendees`: `training_id uuid references training_records on delete restrict`, `person_id uuid references people`, `ack text check in
('conforme','con_observaciones','no_firma') default 'conforme'`, `observation text` (<= 500, identidad reservada: el auditor no ve person_id junto a la
observación; la vista del auditor muestra observaciones sin persona), PK (training_id, person_id).
INSERT/SELECT como EPP. Sin UPDATE/DELETE. Inserción de record + attendees en una RPC `create_training(held_at, topic, trainer, modality_place,
modality_sync, assisted, duration_min, attendees jsonb)` SECURITY DEFINER que valida roles y tamaño (<= 200 asistentes).

## 5. Auditoría — `public.access_log` y RPC `log_access`
`access_log`: `id bigint generated always as identity pk`, `at timestamptz not null default now()`, `user_id uuid`, `user_email text`, `role text`,
`action text not null check in ('view_live','record_start','record_stop','photo','export_csv','export_pdf','config_change','command','archive','delete_media',
'login','assist_open','assist_close','epp_create','training_create','hash_verify')`, `target text` (<= 120), `detail jsonb` (objeto, <= 1 KB).
- Escritura solo vía `rpc log_access(action text, target text, detail jsonb default '{}')` SECURITY DEFINER (usa auth.uid()/jwt; rate limit 120/min por
  usuario; rechaza si no es viewer/admin/auditor). Sin INSERT/UPDATE/DELETE directos para nadie.
- SELECT: `admin` y `auditor`. No Realtime. Retención 1 año en `casco_purge`.

## 6. Datos del empleador/organización — `public.org_settings`
Fila única (`id int pk check (id = 1)`): `legal_name`, `cuit`, `address`, `responsible_name`, `responsible_role`, `contact`. SELECT viewer/admin/auditor;
INSERT/UPDATE solo `admin` (upsert). Se usa en el encabezado de las constancias impresas.

## 7. Huella de media (hash)
El agente del casco calcula SHA-256 (hex minúscula) del archivo ANTES de subirlo y lo manda en `events.payload`:
`{"sha256":"<64 hex>","hash_alg":"sha256","size":<bytes>,"captured_at":"<ISO UTC del casco>"}` (en eventos `photo` y de video). El visor lo verifica bajo
demanda descargando el archivo firmado y calculando `crypto.subtle.digest('SHA-256')`: muestra "Íntegro" o "No coincide" y registra `hash_verify` en
access_log. No hay cambio de esquema: es `payload` jsonb existente.

## 8. Visor (web)
- Pestaña **Asistencia**: iniciar sesión (casco + tema) — se abre sola al tocar "Hablar" o "Iniciar" si no hay una abierta —, cerrar con resultado y nota
  (+ contador de fotos), lista del día con duración, KPIs (sesiones, duración media, % resueltas), exportar CSV; todo con textos en rioplatense.
- Pestaña **Constancias** (admin y viewer): subpestañas EPP y Capacitación; formularios con validación; listado con exportar CSV e imprimir/PDF con
  encabezado del empleador; nuevo registro corrige a uno anterior vía `supersedes`; rol auditor solo lee.
- Pestaña **Auditoría** (admin y auditor): tabla del `access_log` con filtros fecha/usuario/acción, paginada, CSV.
- Foto/video: botón "Verificar integridad" (hash).
- El visor llama `log_access` en: ver en vivo, grabar, sacar foto, exportar, cambiar configuración, enviar comando, archivar/borrar media, abrir/cerrar
  asistencia, crear constancia. Si falla `log_access`, no bloquea la acción (silencioso, 1 reintento).
- Rol `auditor`: sin botones de acción; solo lectura en todas las pestañas permitidas.

## 9. Notas de implementación (migración 013)
Decisiones donde la implementación SQL difiere o precisa el contrato. `supabase/migrations/013_asistencia_constancias_auditoria.sql`.
1. **Training solo por RPC.** `training_records` y `training_attendees` no tienen INSERT directo (ni grant ni policy): el alta es siempre
   `rpc create_training`. Evita agregar asistentes a una constancia ya emitida. Se agregó un 9.º parámetro opcional `supersedes uuid default null`
   (las llamadas con los 8 del contrato siguen funcionando). `attendees` = `[{"person_id":"<uuid>","ack":"conforme|con_observaciones|no_firma","observation":"..."}]`
   (`ack` por defecto `conforme`). Valida 1..200 asistentes, sin repetidos, personas existentes y no dadas de baja, `held_at` no futura (> now()+1 día).
2. **Auditor y asistentes.** El auditor NO lee `training_attendees` (RLS solo viewer/admin): lee la vista `training_attendees_audit`
   (training_id, person_id, ack, observation), que corre con los privilegios del dueño y filtra por rol. `person_id` viene null cuando el asistente dejó
   observación (identidad reservada).
3. **Auditor y `people`.** Sin cambios de columnas: los grants por columna de 007 ya excluyen `dni` y `contact_phone` para todos; el auditor solo suma
   una policy de SELECT. `people_full` y `devices_full` le devuelven 0 filas. También se sumó SELECT del auditor sobre `event_archive` (necesario para
   que `incident_report` muestre `archived_at`) y sobre `devices` (columnas del grant: sin imei/SIM).
4. **Storage.** El auditor NO recibe SELECT sobre `storage.objects` (el contrato habla de “evidencia” pero no de URLs firmadas). Ve los eventos
   `photo`/`video` con su hash en `payload`, pero no descarga el archivo. Si se quiere que verifique la huella, agregar una policy
   `media_select_auditor` análoga a `media_select_viewer`.
5. **Inmutabilidad reforzada.** Además de no dar UPDATE/DELETE, el trigger `immutable_row_guard` (epp_deliveries, training_*, access_log y DELETE en
   assist_sessions) rechaza todo lo que traiga JWT, incluido `service_role`. Solo pasa una sesión directa de base de datos sin JWT (SQL Editor,
   `casco_purge`). Para corregir datos de verdad: nuevo registro con `supersedes`.
6. **`supersedes`.** Debe apuntar a un registro existente de la MISMA persona (EPP) y un registro solo se puede corregir una vez (índice único
   parcial; la cadena sigue corrigiendo la corrección). `delivered_at` no puede ser futura.
7. **Fecha de entrega en hora Argentina.** `delivered_at` por defecto = `(now() at time zone 'America/Argentina/Buenos_Aires')::date` (no
   `current_date`, que en UTC corre el día después de las 21:00). El tope “no futura” usa la misma fecha.
8. **assist_sessions.** `outcome` no es obligatorio al cerrar (el contrato lo deja null por defecto; el visor debe pedirlo). Cerrar fija
   `ended_at = now()` y `closed_by_email`; mientras está abierta se pueden completar `note`/`photos`. No hay restricción de una sola sesión abierta por
   casco ni se exige que el casco exista en `devices`. La sesión cerrada es inmutable incluso para su dueño y para admin. `photos` 0..1000.
9. **log_access.** `target` es opcional (default null) y se recorta a 120 caracteres; un `detail` > 1 KB no se rechaza: se guarda
   `{"truncated":true,"bytes":N}` para no perder el asiento. Devuelve `void`. Rate limit 120/min por usuario (54000). Acción fuera de lista: 22023.
10. **Rate limits no definidos en el contrato** (mi elección): epp_deliveries 30/min, create_training 10/min por usuario (assist 20/min y log_access 120/min
    sí vienen del contrato). Código 54000.
11. **Retención.** Solo `access_log` (365 días) en `casco_purge`. assist_sessions, constancias y capacitaciones NO se purgan (respaldo legal): deciden
    ustedes si quieren un plazo; contienen datos personales (Ley 25.326).
12. **Pendiente de decisión: DNI en la constancia impresa.** El DNI solo se lee por `people_full` (admin). Un `viewer` que arma/imprime la constancia
    no ve el DNI del trabajador (exigido por Disp. GP 3/2022). Opciones: imprimir solo desde admin, o una RPC/vista que devuelva el DNI únicamente
    para la persona de una constancia propia. No se implementó para no ampliar el acceso a datos personales sin decisión explícita.
13. **Realtime** solo `assist_sessions`. El auditor recibe sus cambios por RLS.
14. `org_settings`: todos los campos opcionales; `cuit` con formato `NN-NNNNNNNN-N` (guiones opcionales); escritura con `aa_admin_only_trg` como el resto del registro.
