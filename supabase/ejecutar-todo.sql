-- Casco Inteligente: TODO en uno (schema + 002 event_acks + 003 stream_commands + 004 rtc_signals + 005 centro + 006 geo + 007 equipos + 008 retencion + 009 sos siempre + 010 comandos/config/roles + 011 archivar eventos + 012 borrar imagenes).
-- Pegar completo en Supabase > SQL Editor > Run. Idempotente.
-- NO incluye cron_escalate.sql (necesita extensiones y un secreto): ver SETUP.md paso 11.

-- ===========================================================================
-- schema.sql
-- ===========================================================================

-- Casco Inteligente: esquema Supabase (endurecido, idempotente)
-- Ejecutar completo en: Supabase > SQL Editor. Se puede re-ejecutar sin riesgo.
--
-- Modelo de confianza (la anon key es PUBLICA; toda la seguridad esta aqui):
--   * anon                  -> nada (sin grants, sin policies).
--   * authenticated sin rol -> nada.
--   * role='device'         -> SOLO inserta eventos de SU device_id y sube archivos
--                              bajo SU carpeta <device_id>/<photo|video>/. No lee,
--                              no actualiza, no borra, no lista.
--   * role='viewer'|'admin' -> solo lee eventos y archivos (URLs firmadas).
-- Los roles y device_id viven en auth.users.raw_app_meta_data (app_metadata): el
-- usuario NO puede modificarlos (a diferencia de user_metadata). Ver al final.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Helpers de claims (leen el JWT de la peticion)
-- ---------------------------------------------------------------------------
create or replace function public.jwt_role() returns text
language sql stable as $$ select auth.jwt() -> 'app_metadata' ->> 'role' $$;

create or replace function public.jwt_device_id() returns text
language sql stable as $$ select nullif(auth.jwt() -> 'app_metadata' ->> 'device_id', '') $$;

-- ---------------------------------------------------------------------------
-- Tabla events
-- ---------------------------------------------------------------------------
create table if not exists public.events (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  device_id   text not null,
  type        text not null,
  key_code    text,
  press_ms    integer,
  media_path  text,
  lat         double precision,
  lng         double precision,
  battery     integer,
  payload     jsonb not null default '{}'::jsonb
);

-- Constraints (NOT VALID: no revalidan filas viejas, si validan toda fila nueva).
alter table public.events drop constraint if exists events_type_check;
alter table public.events add constraint events_type_check
  check (type in ('sos','photo','video','heartbeat','fall','location','geofence','not_worn','inactive','equip','fall_cancel')) not valid;

alter table public.events drop constraint if exists events_device_id_fmt;
alter table public.events add constraint events_device_id_fmt
  check (device_id ~ '^[A-Za-z0-9_-]{1,64}$') not valid;

alter table public.events drop constraint if exists events_ranges_ck;
alter table public.events add constraint events_ranges_ck check (
  (key_code is null or length(key_code) <= 32)
  and (press_ms is null or press_ms between 0 and 600000)
  and (battery  is null or battery  between 0 and 100)
  and (lat is null or lat between -90  and 90)
  and (lng is null or lng between -180 and 180)
) not valid;

-- media_path: solo <device_id>/(photo|video)/<archivo>, sin '..'; el prefijo se
-- compara ademas con device_id en la policy, y aqui se fuerza el formato.
alter table public.events drop constraint if exists events_media_path_ck;
alter table public.events add constraint events_media_path_ck check (
  media_path is null
  or (length(media_path) <= 300
      and media_path ~ '^[A-Za-z0-9_-]+/(photo|video)/[^/]+$'
      and media_path !~ '\.\.')
) not valid;

alter table public.events drop constraint if exists events_payload_ck;
alter table public.events add constraint events_payload_ck check (
  jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 2048
) not valid;

create index if not exists events_created_idx on public.events (created_at desc);
create index if not exists events_device_idx  on public.events (device_id, created_at desc);
create index if not exists events_rate_idx    on public.events (device_id, type, created_at desc);

-- Trigger: fuerza created_at = now() (el device no puede falsear el reloj/orden)
-- y limita a 30 eventos por minuto por (device_id, type) contra inserciones masivas.
-- SECURITY DEFINER para contar aunque el device no tenga SELECT.
create or replace function public.events_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.created_at := now();
  if (select count(*) from public.events e
       where e.device_id = new.device_id and e.type = new.type
         and e.created_at > now() - interval '1 minute') >= 30 then
    raise exception 'rate limit: demasiados eventos % de %', new.type, new.device_id
      using errcode = '54000';
  end if;
  return new;
end $$;
revoke all on function public.events_guard() from public, anon, authenticated;

drop trigger if exists events_guard_trg on public.events;
create trigger events_guard_trg before insert on public.events
  for each row execute function public.events_guard();

-- Privilegios minimos (defensa en profundidad ademas de RLS).
alter table public.events enable row level security;
revoke all on public.events from anon;
revoke all on public.events from authenticated;
grant select, insert on public.events to authenticated;
-- (service_role conserva todo; no hay policies de UPDATE/DELETE: nadie via API.)

drop policy if exists events_insert_device on public.events;
create policy events_insert_device on public.events
  for insert to authenticated
  with check (
    public.jwt_role() = 'device'
    and public.jwt_device_id() is not null
    and device_id = public.jwt_device_id()
    and (media_path is null or split_part(media_path, '/', 1) = device_id)
  );

drop policy if exists events_select_viewer on public.events;
create policy events_select_viewer on public.events
  for select to authenticated
  using (public.jwt_role() in ('viewer','admin'));

-- ---------------------------------------------------------------------------
-- Storage: bucket privado con limites
-- ---------------------------------------------------------------------------
-- 50 MB = tope del plan gratuito; el agente ya limita con Config.MAX_UPLOAD_BYTES.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('casco-media', 'casco-media', false, 52428800,
        array['image/jpeg','image/png','video/mp4'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Limpia policies viejas y define el conjunto completo. No hay policy de
-- UPDATE ni DELETE: nadie via API puede sobrescribir (x-upsert falla) ni borrar;
-- la retencion/borrado se hace desde el dashboard o con service_role.
drop policy if exists media_insert_device on storage.objects;
drop policy if exists media_select_viewer on storage.objects;
drop policy if exists media_update_none   on storage.objects;
drop policy if exists media_delete_none   on storage.objects;

-- INSERT: solo device, solo <su device_id>/<photo|video>/<archivo> (3 niveles).
create policy media_insert_device on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'casco-media'
    and public.jwt_role() = 'device'
    and public.jwt_device_id() is not null
    and array_length(storage.foldername(name), 1) = 2
    and (storage.foldername(name))[1] = public.jwt_device_id()
    and (storage.foldername(name))[2] in ('photo','video')
    and name !~ '\.\.'
  );

-- SELECT: solo viewer/admin (listar y crear URLs firmadas). El device no lee.
create policy media_select_viewer on storage.objects
  for select to authenticated
  using (bucket_id = 'casco-media'
         and public.jwt_role() in ('viewer','admin'));

-- ---------------------------------------------------------------------------
-- Tiempo real para el visor (idempotente; respeta RLS: solo viewer/admin reciben)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime'
                   and schemaname = 'public' and tablename = 'events') then
    alter publication supabase_realtime add table public.events;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Asignar roles (reemplazar emails tras crear los usuarios en Authentication > Users).
-- IMPORTANTE: el device_id del claim DEBE ser igual al "device_id" del config del casco.
-- Sin el claim device_id el casco NO puede insertar (falla cerrada, a proposito).
-- Tras cambiar app_metadata, el usuario debe volver a iniciar sesion (token nuevo).
--
-- update auth.users set raw_app_meta_data =
--     coalesce(raw_app_meta_data,'{}'::jsonb) || '{"role":"device","device_id":"4132"}'
--   where email = 'casco-4132@tudominio.com';
-- update auth.users set raw_app_meta_data =
--     coalesce(raw_app_meta_data,'{}'::jsonb) || '{"role":"viewer"}'
--   where email = 'supervisor@tudominio.com';
--
-- Retencion opcional (evita crecimiento infinito de heartbeats; requiere pg_cron):
-- select cron.schedule('casco-purge-heartbeat', '0 3 * * *',
--   $$delete from public.events where type='heartbeat' and created_at < now() - interval '7 days'$$);

-- ===========================================================================
-- 002_event_acks.sql
-- ===========================================================================

-- Atender alertas (SOS / caida): quien la atendio, cuando y nota.
-- Idempotente. Ejecutar en Supabase > SQL Editor (despues de schema.sql).
-- Una alerta solo se puede atender una vez (event_id es PK): gana el primero.
-- No hay UPDATE ni DELETE: el registro de atencion es inmutable.

create table if not exists public.event_acks (
  event_id        uuid primary key references public.events(id) on delete cascade,
  acked_by        uuid not null default auth.uid(),
  acked_by_email  text not null default coalesce(auth.jwt() ->> 'email', ''),
  acked_at        timestamptz not null default now(),
  note            text check (note is null or length(note) <= 500)
);

alter table public.event_acks enable row level security;

revoke all on public.event_acks from anon;
revoke all on public.event_acks from authenticated;
grant select on public.event_acks to authenticated;
-- Solo estas columnas son escribibles: quien/cuando/email los fija el servidor.
grant insert (event_id, note) on public.event_acks to authenticated;

drop policy if exists acks_select_viewer on public.event_acks;
create policy acks_select_viewer on public.event_acks
  for select to authenticated
  using (public.jwt_role() in ('viewer','admin'));

drop policy if exists acks_insert_viewer on public.event_acks;
create policy acks_insert_viewer on public.event_acks
  for insert to authenticated
  with check (public.jwt_role() in ('viewer','admin') and acked_by = auth.uid());

do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime'
                   and schemaname = 'public' and tablename = 'event_acks') then
    alter publication supabase_realtime add table public.event_acks;
  end if;
end $$;

-- ===========================================================================
-- 003_stream_commands.sql
-- ===========================================================================

-- Video en vivo: cola de comandos start/stop para el casco (ver docs/PROTOCOLO-VIDEO.md).
-- Idempotente. Ejecutar en Supabase > SQL Editor (despues de schema.sql y 002).
--
--   * viewer/admin -> insertan comandos (solo device_id + action; el resto lo fija el servidor)
--                     y leen todo.
--   * device       -> lee SOLO comandos de su device_id de los ultimos 2 minutos. No inserta.
--   * Sin UPDATE ni DELETE para nadie via API (el historial es inmutable).
--   * Maximo 10 comandos por minuto por usuario (anti-abuso).

create table if not exists public.stream_commands (
  id                 uuid primary key default gen_random_uuid(),
  device_id          text not null check (device_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  action             text not null check (action in ('start','stop')),
  requested_by       uuid not null default auth.uid(),
  requested_by_email text not null default coalesce(auth.jwt() ->> 'email', ''),
  created_at         timestamptz not null default now()
);

create index if not exists stream_commands_device_idx
  on public.stream_commands (device_id, created_at desc);
create index if not exists stream_commands_user_idx
  on public.stream_commands (requested_by, created_at desc);

-- Trigger: created_at siempre = now() (nadie falsea el reloj; la vigencia de 2 min
-- depende de esto) y tope de 10 comandos/minuto por usuario.
-- SECURITY DEFINER + search_path vacio: cuenta aunque el usuario no pueda leer todo.
create or replace function public.stream_commands_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.created_at := now();
  if (select count(*) from public.stream_commands c
       where c.requested_by = new.requested_by
         and c.created_at > now() - interval '1 minute') >= 10 then
    raise exception 'rate limit: demasiados comandos de video'
      using errcode = '54000';
  end if;
  return new;
end $$;
revoke all on function public.stream_commands_guard() from public, anon, authenticated;

drop trigger if exists stream_commands_guard_trg on public.stream_commands;
create trigger stream_commands_guard_trg before insert on public.stream_commands
  for each row execute function public.stream_commands_guard();

alter table public.stream_commands enable row level security;

revoke all on public.stream_commands from anon;
revoke all on public.stream_commands from authenticated;
grant select on public.stream_commands to authenticated;
-- Solo estas columnas son escribibles: quien/email/fecha/id los fija el servidor.
grant insert (device_id, action) on public.stream_commands to authenticated;

drop policy if exists stream_cmd_insert_viewer on public.stream_commands;
create policy stream_cmd_insert_viewer on public.stream_commands
  for insert to authenticated
  with check (public.jwt_role() in ('viewer','admin') and requested_by = auth.uid());

drop policy if exists stream_cmd_select_viewer on public.stream_commands;
create policy stream_cmd_select_viewer on public.stream_commands
  for select to authenticated
  using (public.jwt_role() in ('viewer','admin'));

drop policy if exists stream_cmd_select_device on public.stream_commands;
create policy stream_cmd_select_device on public.stream_commands
  for select to authenticated
  using (public.jwt_role() = 'device'
         and public.jwt_device_id() is not null
         and device_id = public.jwt_device_id()
         and created_at > now() - interval '2 minutes');

-- Retencion opcional (requiere pg_cron; Database > Extensions > pg_cron):
-- select cron.schedule('casco-purge-stream-commands', '15 3 * * *',
--   $$delete from public.stream_commands where created_at < now() - interval '7 days'$$);

-- ===========================================================================
-- 004_rtc_signals.sql
-- ===========================================================================

-- Voz en vivo: senalizacion WebRTC (ver docs/PROTOCOLO-VOZ.md, seccion 2).
-- Idempotente. Ejecutar en Supabase > SQL Editor (despues de schema.sql, 002 y 003).
--
--   * viewer/admin -> insertan offer/ice/hangup (from_role='viewer') y leen todo.
--   * device       -> inserta answer/ice/hangup/busy SOLO con su device_id (from_role='device');
--                     lee SOLO filas de su device_id, from_role='viewer', ultimos 2 minutos.
--   * Sin UPDATE ni DELETE para nadie via API.
--   * Tope: 60 filas/min por (usuario, call_id) y 300/min por usuario (anti-abuso).
--
-- Nota para clientes: el device NO puede leer lo que inserta; usar insert SIN
-- `.select()` / `Prefer: return=minimal` (de lo contrario PostgREST responde 403/401).

create table if not exists public.rtc_signals (
  id         uuid primary key default gen_random_uuid(),
  device_id  text not null check (device_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  call_id    uuid not null,
  from_role  text not null check (from_role in ('viewer','device')),
  kind       text not null check (kind in ('offer','answer','ice','hangup','busy')),
  payload    jsonb not null default '{}'::jsonb
             check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 8192),
  created_at timestamptz not null default now(),
  -- Interno (no es parte del protocolo): quien inserto. Lo fija el default auth.uid()
  -- y no es escribible por clientes; sirve para el rate limit por (usuario, call_id).
  sender_id  uuid not null default auth.uid()
);

create index if not exists rtc_signals_device_idx on public.rtc_signals (device_id, created_at desc);
create index if not exists rtc_signals_call_idx   on public.rtc_signals (call_id, created_at);
create index if not exists rtc_signals_sender_idx on public.rtc_signals (sender_id, created_at desc);

-- Trigger BEFORE INSERT (SECURITY DEFINER + search_path vacio: cuenta aunque el
-- usuario no pueda leer todo). El cliente no controla created_at ni from_role.
-- Corre antes del WITH CHECK de RLS, que ve los valores ya fijados.
create or replace function public.rtc_signals_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r text := public.jwt_role();
begin
  new.created_at := now();
  if r = 'device' then
    new.from_role := 'device';
  elsif r in ('viewer','admin') then
    new.from_role := 'viewer';
  else
    raise exception 'rtc_signals: rol no autorizado' using errcode = '42501';
  end if;

  if (select count(*) from public.rtc_signals s
       where s.sender_id = new.sender_id and s.call_id = new.call_id
         and s.created_at > now() - interval '1 minute') >= 60 then
    raise exception 'rate limit: demasiadas senales de voz para la llamada'
      using errcode = '54000';
  end if;
  -- Tope global por usuario: evita esquivar el limite por llamada cambiando call_id.
  if (select count(*) from public.rtc_signals s
       where s.sender_id = new.sender_id
         and s.created_at > now() - interval '1 minute') >= 300 then
    raise exception 'rate limit: demasiadas senales de voz'
      using errcode = '54000';
  end if;
  return new;
end $$;
revoke all on function public.rtc_signals_guard() from public, anon, authenticated;

drop trigger if exists rtc_signals_guard_trg on public.rtc_signals;
create trigger rtc_signals_guard_trg before insert on public.rtc_signals
  for each row execute function public.rtc_signals_guard();

alter table public.rtc_signals enable row level security;

revoke all on public.rtc_signals from anon;
revoke all on public.rtc_signals from authenticated;
grant select on public.rtc_signals to authenticated;
-- Solo estas columnas son escribibles: id/from_role/created_at/sender_id los fija el servidor.
grant insert (device_id, call_id, kind, payload) on public.rtc_signals to authenticated;

drop policy if exists rtc_insert_viewer on public.rtc_signals;
create policy rtc_insert_viewer on public.rtc_signals
  for insert to authenticated
  with check (public.jwt_role() in ('viewer','admin')
              and from_role = 'viewer'
              and kind in ('offer','ice','hangup'));

drop policy if exists rtc_insert_device on public.rtc_signals;
create policy rtc_insert_device on public.rtc_signals
  for insert to authenticated
  with check (public.jwt_role() = 'device'
              and public.jwt_device_id() is not null
              and device_id = public.jwt_device_id()
              and from_role = 'device'
              and kind in ('answer','ice','hangup','busy'));

drop policy if exists rtc_select_viewer on public.rtc_signals;
create policy rtc_select_viewer on public.rtc_signals
  for select to authenticated
  using (public.jwt_role() in ('viewer','admin'));

drop policy if exists rtc_select_device on public.rtc_signals;
create policy rtc_select_device on public.rtc_signals
  for select to authenticated
  using (public.jwt_role() = 'device'
         and public.jwt_device_id() is not null
         and device_id = public.jwt_device_id()
         and from_role = 'viewer'
         and created_at > now() - interval '2 minutes');

-- Tiempo real para el visor (idempotente; respeta RLS: solo viewer/admin reciben).
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime'
                   and schemaname = 'public' and tablename = 'rtc_signals') then
    alter publication supabase_realtime add table public.rtc_signals;
  end if;
end $$;

-- Retencion recomendada (requiere pg_cron; Database > Extensions > pg_cron).
-- La senalizacion solo sirve segundos; borrar todo lo de mas de 1 dia:
-- select cron.schedule('casco-purge-rtc-signals', '30 3 * * *',
--   $$delete from public.rtc_signals where created_at < now() - interval '1 day'$$);

-- ===========================================================================
-- 005_centro.sql
-- ===========================================================================

-- Centro de mando: escalamiento y ordenes a cascos (evacuacion/mensajes).
-- Ver docs/PROTOCOLO-CENTRO.md secciones 2 y 4. (La grabacion es solo en el navegador: no hay tablas de clips.)
-- Idempotente. Ejecutar en Supabase > SQL Editor (despues de schema.sql, 002, 003 y 004).
--
-- Resumen de permisos (la anon key es publica; toda la seguridad esta aqui):
--   escalation_rules : viewer/admin leen; SOLO admin inserta/actualiza (sin DELETE: se desactiva con enabled=false).
--   escalations      : viewer/admin leen; nadie escribe via API. La escribe la Edge Function `escalate`
--                      con service_role (ver nota abajo).
--   broadcasts       : viewer/admin insertan (kind,message,device_ids,repeat) y leen; device lee solo los
--                      de los ultimos 2 min dirigidos a el (device_ids null o que lo incluya). Sin UPDATE/DELETE.
--   broadcast_acks   : device inserta SOLO con su device_id y SOLO de broadcasts que puede ver; viewer/admin leen.
--   Todos los campos de autoria/fecha (created_at, created_by, created_by_email, played_at)
--   los fija un trigger SECURITY DEFINER desde el JWT; el cliente no puede falsearlos.
--
-- Nota service_role (tabla escalations): la funcion `escalate` la lanza pg_cron sin ningun usuario, asi que
-- no hay un JWT de supervisor con el cual escribir. Usa SUPABASE_SERVICE_ROLE_KEY, que Supabase INYECTA en el
-- entorno de la Edge Function: nunca esta en el repo, ni en el cliente, ni se copia a mano. Se justifica porque
-- (1) la tabla es un log de sistema que ningun usuario debe poder escribir (si un viewer pudiera insertar una
-- fila "ok=true" silenciaria la escalacion de una alerta real) y (2) la funcion esta protegida por un secreto
-- de cabecera comparado en tiempo constante y falla cerrada. La funcion solo toca 4 tablas (ver README).

-- ---------------------------------------------------------------------------
-- events.type: ampliar con 'location' y 'geofence' (docs/PROTOCOLO-GEO.md).
-- NOT VALID: no revalida filas viejas, si valida toda fila nueva.
-- (schema.sql ya trae la misma lista; se repite aqui para bases creadas antes.)
-- ---------------------------------------------------------------------------
alter table public.events drop constraint if exists events_type_check;
alter table public.events add constraint events_type_check
  check (type in ('sos','photo','video','heartbeat','fall','location','geofence','not_worn','inactive','equip','fall_cancel')) not valid;

-- ===========================================================================
-- 1. escalation_rules  (regla global; editable solo por admin)
-- ===========================================================================
create table if not exists public.escalation_rules (
  id               uuid primary key default gen_random_uuid(),
  after_seconds    integer not null default 60
                   check (after_seconds between 0 and 3600),
  channel          text not null default 'teams' check (channel in ('teams')),
  enabled          boolean not null default false,
  -- Placeholders: {tipo} {device_id} {motivo} {edad} {mapa}
  message_template text not null
                   default 'ALERTA {tipo} sin atender: casco {device_id}. {motivo}. Hace {edad}. {mapa}'
                   check (length(message_template) between 1 and 500
                          and message_template !~ '[[:cntrl:]]'),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  updated_by       uuid
);

-- Trigger: fija updated_at/updated_by y limita a 10 reglas (cada regla habilitada puede
-- generar una notificacion por alerta: tope contra spam al webhook).
create or replace function public.escalation_rules_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  if tg_op = 'INSERT' then
    new.created_at := now();
    if (select count(*) from public.escalation_rules) >= 10 then
      raise exception 'escalation_rules: maximo 10 reglas' using errcode = '54000';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.escalation_rules_guard() from public, anon, authenticated;

drop trigger if exists escalation_rules_guard_trg on public.escalation_rules;
create trigger escalation_rules_guard_trg before insert or update on public.escalation_rules
  for each row execute function public.escalation_rules_guard();

alter table public.escalation_rules enable row level security;
revoke all on public.escalation_rules from anon;
revoke all on public.escalation_rules from authenticated;
grant select on public.escalation_rules to authenticated;
grant insert (after_seconds, channel, enabled, message_template) on public.escalation_rules to authenticated;
grant update (after_seconds, channel, enabled, message_template) on public.escalation_rules to authenticated;

drop policy if exists esc_rules_select on public.escalation_rules;
create policy esc_rules_select on public.escalation_rules
  for select to authenticated
  using (public.jwt_role() in ('viewer','admin'));

drop policy if exists esc_rules_insert_admin on public.escalation_rules;
create policy esc_rules_insert_admin on public.escalation_rules
  for insert to authenticated
  with check (public.jwt_role() = 'admin');

drop policy if exists esc_rules_update_admin on public.escalation_rules;
create policy esc_rules_update_admin on public.escalation_rules
  for update to authenticated
  using (public.jwt_role() = 'admin')
  with check (public.jwt_role() = 'admin');

-- Regla por defecto: 60 s, Teams, DESACTIVADA hasta configurar el webhook (SETUP.md paso 11).
-- Id fijo para que re-ejecutar no duplique ni pise cambios del admin.
insert into public.escalation_rules (id, after_seconds, channel, enabled)
values ('00000000-0000-4000-8000-0000000000e1', 60, 'teams', false)
on conflict (id) do nothing;

-- ===========================================================================
-- 2. escalations  (log + anti-duplicado; PK = event_id + rule_id)
-- ===========================================================================
create table if not exists public.escalations (
  event_id uuid not null references public.events(id) on delete cascade,
  rule_id  uuid not null references public.escalation_rules(id) on delete cascade,
  sent_at  timestamptz not null default now(),
  ok       boolean not null default false,
  detail   text check (detail is null or length(detail) <= 500),  -- nunca la URL del webhook
  primary key (event_id, rule_id)
);
create index if not exists escalations_sent_idx on public.escalations (sent_at desc);

alter table public.escalations enable row level security;
revoke all on public.escalations from anon;
revoke all on public.escalations from authenticated;
grant select on public.escalations to authenticated;
-- service_role (Edge Function escalate) ya suele tener todo por defecto en Supabase; se explicita.
grant select, insert, update on public.escalations to service_role;
grant select on public.escalation_rules to service_role;
grant select on public.events to service_role;
grant select on public.event_acks to service_role;

drop policy if exists escalations_select on public.escalations;
create policy escalations_select on public.escalations
  for select to authenticated
  using (public.jwt_role() in ('viewer','admin'));
-- Sin policies ni grants de INSERT/UPDATE/DELETE para authenticated.

-- ===========================================================================
-- 3. broadcasts  (evacuacion y mensajes del supervisor, texto a voz)
-- ===========================================================================
create table if not exists public.broadcasts (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('evacuacion','mensaje')),
  -- Vacio permitido solo en evacuacion (el casco dice "Dirijase al punto de reunion").
  message          text not null default ''
                   check (length(message) <= 200 and message !~ '[[:cntrl:]]'
                          and (kind = 'evacuacion' or length(btrim(message)) > 0)),
  -- null = todos los cascos; si no, 1..100 device_id validos y sin nulos.
  device_ids       text[]
                   check (device_ids is null
                          or (cardinality(device_ids) between 1 and 100
                              and array_position(device_ids, null::text) is null
                              and array_to_string(device_ids, ',')
                                  ~ '^[A-Za-z0-9_-]{1,64}(,[A-Za-z0-9_-]{1,64})*$')),
  repeat           integer not null default 3 check (repeat between 1 and 5),
  created_by       uuid not null default auth.uid(),
  created_by_email text not null default coalesce(auth.jwt() ->> 'email', ''),
  created_at       timestamptz not null default now()
);
create index if not exists broadcasts_created_idx on public.broadcasts (created_at desc);
create index if not exists broadcasts_user_idx    on public.broadcasts (created_by, created_at desc);

-- Trigger: rol viewer/admin, autoria y fecha desde el servidor, 6/min por usuario.
-- El advisory lock serializa por usuario: sin el, dos inserciones concurrentes
-- podrian ver ambas "5" y pasar de 6.
create or replace function public.broadcasts_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare u uuid := auth.uid();
begin
  if coalesce(public.jwt_role(), '') not in ('viewer','admin') or u is null then
    raise exception 'broadcasts: rol no autorizado' using errcode = '42501';
  end if;
  new.created_at       := now();
  new.created_by       := u;
  new.created_by_email := coalesce(auth.jwt() ->> 'email', '');
  perform pg_advisory_xact_lock(hashtextextended('broadcasts:' || u::text, 0));
  if (select count(*) from public.broadcasts b
       where b.created_by = u and b.created_at > now() - interval '1 minute') >= 6 then
    raise exception 'rate limit: demasiadas ordenes por minuto' using errcode = '54000';
  end if;
  return new;
end $$;
revoke all on function public.broadcasts_guard() from public, anon, authenticated;

drop trigger if exists broadcasts_guard_trg on public.broadcasts;
create trigger broadcasts_guard_trg before insert on public.broadcasts
  for each row execute function public.broadcasts_guard();

alter table public.broadcasts enable row level security;
revoke all on public.broadcasts from anon;
revoke all on public.broadcasts from authenticated;
grant select on public.broadcasts to authenticated;
grant insert (kind, message, device_ids, repeat) on public.broadcasts to authenticated;

drop policy if exists broadcasts_insert_viewer on public.broadcasts;
create policy broadcasts_insert_viewer on public.broadcasts
  for insert to authenticated
  with check (public.jwt_role() in ('viewer','admin') and created_by = auth.uid());

drop policy if exists broadcasts_select_viewer on public.broadcasts;
create policy broadcasts_select_viewer on public.broadcasts
  for select to authenticated
  using (public.jwt_role() in ('viewer','admin'));

drop policy if exists broadcasts_select_device on public.broadcasts;
create policy broadcasts_select_device on public.broadcasts
  for select to authenticated
  using (public.jwt_role() = 'device'
         and public.jwt_device_id() is not null
         and created_at > now() - interval '2 minutes'
         and (device_ids is null or public.jwt_device_id() = any (device_ids)));

-- ===========================================================================
-- 4. broadcast_acks  ("recibido por 3 de 3 cascos")
-- ===========================================================================
create table if not exists public.broadcast_acks (
  broadcast_id uuid not null references public.broadcasts(id) on delete cascade,
  device_id    text not null check (device_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  played_at    timestamptz not null default now(),
  primary key (broadcast_id, device_id)   -- un ack por casco y orden (idempotente)
);
create index if not exists broadcast_acks_device_idx on public.broadcast_acks (device_id, played_at desc);

-- Trigger: played_at = now() y tope 30 acks/min por casco.
create or replace function public.broadcast_acks_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.played_at := now();
  if (select count(*) from public.broadcast_acks a
       where a.device_id = new.device_id
         and a.played_at > now() - interval '1 minute') >= 30 then
    raise exception 'rate limit: demasiados acks de %', new.device_id using errcode = '54000';
  end if;
  return new;
end $$;
revoke all on function public.broadcast_acks_guard() from public, anon, authenticated;

drop trigger if exists broadcast_acks_guard_trg on public.broadcast_acks;
create trigger broadcast_acks_guard_trg before insert on public.broadcast_acks
  for each row execute function public.broadcast_acks_guard();

alter table public.broadcast_acks enable row level security;
revoke all on public.broadcast_acks from anon;
revoke all on public.broadcast_acks from authenticated;
grant select on public.broadcast_acks to authenticated;
grant insert (broadcast_id, device_id) on public.broadcast_acks to authenticated;

-- Solo con su device_id y solo de una orden que ese casco puede ver (vigente y dirigida a el).
-- El EXISTS repite las condiciones de broadcasts_select_device para no depender de que
-- esa policy no cambie.
-- Cliente: insertar con Prefer: return=minimal (el device no puede leer lo que inserta) y
-- tratar 409/23505 (ya registrado) como exito.
drop policy if exists bcack_insert_device on public.broadcast_acks;
create policy bcack_insert_device on public.broadcast_acks
  for insert to authenticated
  with check (
    public.jwt_role() = 'device'
    and public.jwt_device_id() is not null
    and broadcast_acks.device_id = public.jwt_device_id()
    and exists (
      select 1 from public.broadcasts b
       where b.id = broadcast_acks.broadcast_id
         and b.created_at > now() - interval '2 minutes'
         and (b.device_ids is null or broadcast_acks.device_id = any (b.device_ids))
    )
  );

drop policy if exists bcack_select_viewer on public.broadcast_acks;
create policy bcack_select_viewer on public.broadcast_acks
  for select to authenticated
  using (public.jwt_role() in ('viewer','admin'));

-- ===========================================================================
-- Tiempo real para el visor (idempotente; respeta RLS)
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['broadcasts','broadcast_acks'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime'
                     and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Retencion opcional (requiere pg_cron; Database > Extensions > pg_cron):
-- select cron.schedule('casco-purge-broadcasts', '45 3 * * *',
--   $$delete from public.broadcasts where created_at < now() - interval '90 days'$$);
-- select cron.schedule('casco-purge-escalations', '50 3 * * *',
--   $$delete from public.escalations where sent_at < now() - interval '90 days'$$);
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 006_geo.sql
-- ===========================================================================

-- Mapa: geocercas y georreferencias (ver docs/PROTOCOLO-GEO.md secciones 1, 2, 3 y 6).
-- Idempotente. Ejecutar en Supabase > SQL Editor (despues de schema.sql, 002, 003, 004 y 005).
--
-- Resumen de permisos (la anon key es publica; toda la seguridad esta aqui):
--   geofences  : viewer/admin leen TODO (incluye bajas) e insertan; modifican solo
--                name, kind, geometry, device_ids, message, alarm, active, deleted_at.
--                device lee SOLO las activas, no borradas, con device_ids null o que incluyan su device_id.
--   geo_points : viewer/admin igual (name, category, lat, lng, notes, alert_radius_m, message, alarm,
--                active, deleted_at). device lee SOLO los de category 'peligro' activos y no borrados
--                (el casco los trata como zonas restringidas circulares).
--   Sin DELETE por API (baja logica con deleted_at; una fila dada de baja queda congelada para la API).
--   created_by / created_at / updated_at los fija un trigger SECURITY DEFINER desde el JWT.
--   anon y authenticated sin rol: nada.
--
-- Decisiones (ver out/supabase-geo-report.md):
--   * shape NO es modificable: una zona circle sigue siendo circle (para cambiar de forma, crear otra).
--   * Un valor de alert_radius_m en una categoria distinta de 'peligro' se normaliza a NULL.
--   * message vacio o en blanco se normaliza a NULL (el casco usa la frase por defecto).
--   * Se agrega geo_points.updated_at (no estaba en el protocolo): el casco/visor pueden invalidar cache.

-- ---------------------------------------------------------------------------
-- events: tipos 'location' y 'geofence' (ya los trae schema.sql y 005; aqui solo se
-- repara una base vieja). NOT VALID: no revalida filas viejas, si valida toda fila nueva.
-- ---------------------------------------------------------------------------
do $$
declare d text;
begin
  select pg_get_constraintdef(oid) into d
    from pg_constraint
   where conrelid = 'public.events'::regclass and conname = 'events_type_check';
  if d is null or d !~ 'location' or d !~ 'geofence' then
    alter table public.events drop constraint if exists events_type_check;
    alter table public.events add constraint events_type_check
      check (type in ('sos','photo','video','heartbeat','fall','location','geofence','not_worn','inactive','equip','fall_cancel')) not valid;
  end if;
end $$;

-- Consultas de recorrido: where device_id = ? and type = 'location' and created_at > ? order by created_at desc.
-- (Es el mismo indice que usa el rate limit; si existe, no hace nada.)
create index if not exists events_rate_idx on public.events (device_id, type, created_at desc);

-- ---------------------------------------------------------------------------
-- Validadores de geometria (puros; los usa un CHECK, asi que ni el SQL Editor la puede romper)
-- ---------------------------------------------------------------------------
-- [lat,lng] con ambos numeros JSON y dentro de rango.
create or replace function public.geo_latlng_valid(p jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare la numeric; lo numeric;
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) <> 2 then return false; end if;
  if jsonb_typeof(p -> 0) <> 'number' or jsonb_typeof(p -> 1) <> 'number' then return false; end if;
  la := (p ->> 0)::numeric;
  lo := (p ->> 1)::numeric;
  return la between -90 and 90 and lo between -180 and 180;
end $$;

create or replace function public.geofence_geometry_valid(p_shape text, g jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare n integer; e jsonb;
begin
  if g is null or jsonb_typeof(g) <> 'object' or octet_length(g::text) > 8192 then return false; end if;
  if p_shape = 'circle' then
    -- exactamente {"center":[lat,lng],"radius_m":10..50000}
    if (select count(*) from jsonb_object_keys(g)) <> 2
       or not (g ? 'center') or not (g ? 'radius_m') then return false; end if;
    if jsonb_typeof(g -> 'radius_m') <> 'number' then return false; end if;
    if (g ->> 'radius_m')::numeric not between 10 and 50000 then return false; end if;
    return public.geo_latlng_valid(g -> 'center');
  elsif p_shape = 'polygon' then
    -- exactamente {"points":[[lat,lng],...]} con 3..100 puntos (al menos 3 distintos)
    if (select count(*) from jsonb_object_keys(g)) <> 1 or not (g ? 'points') then return false; end if;
    if jsonb_typeof(g -> 'points') <> 'array' then return false; end if;
    n := jsonb_array_length(g -> 'points');
    if n < 3 or n > 100 then return false; end if;
    for e in select * from jsonb_array_elements(g -> 'points') loop
      if not public.geo_latlng_valid(e) then return false; end if;
    end loop;
    return (select count(distinct x) from jsonb_array_elements(g -> 'points') x) >= 3;
  end if;
  return false;
end $$;

-- ===========================================================================
-- 1. geofences
-- ===========================================================================
create table if not exists public.geofences (
  id         uuid primary key default gen_random_uuid(),
  name       text not null
             check (length(btrim(name)) between 1 and 80 and name !~ '[[:cntrl:]]'),
  kind       text not null check (kind in ('permitida','restringida','informativa')),
  shape      text not null check (shape in ('circle','polygon')),
  geometry   jsonb not null,
  message    text check (message is null
                         or (length(message) between 1 and 140 and message !~ '[[:cntrl:]]')),
  alarm      text not null default 'voz_y_sirena' check (alarm in ('voz','sirena','voz_y_sirena')),
  -- null = todos los cascos; si no, 1..100 device_id validos y sin nulos.
  device_ids text[]
             check (device_ids is null
                    or (cardinality(device_ids) between 1 and 100
                        and array_position(device_ids, null::text) is null
                        and array_to_string(device_ids, ',')
                            ~ '^[A-Za-z0-9_-]{1,64}(,[A-Za-z0-9_-]{1,64})*$')),
  active     boolean not null default true,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint geofences_geometry_ck check (public.geofence_geometry_valid(shape, geometry))
);
create index if not exists geofences_created_idx on public.geofences (created_at desc);
create index if not exists geofences_user_idx    on public.geofences (created_by, created_at desc);

-- Trigger BEFORE INSERT/UPDATE (SECURITY DEFINER + search_path vacio).
--  INSERT: solo viewer/admin; fija autoria/fechas; 30 filas/min por usuario (con advisory lock
--          por usuario para que dos inserciones concurrentes no pasen de 30).
--  UPDATE: viewer/admin (o sesion sin JWT = SQL Editor/service_role); inmutables id, created_*, shape;
--          updated_at = now(); deleted_at = now() al dar de baja (no se puede falsear el instante).
create or replace function public.geofences_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare u uuid := auth.uid(); r text := public.jwt_role();
begin
  new.message := nullif(btrim(new.message), '');
  if tg_op = 'INSERT' then
    if coalesce(r, '') not in ('viewer','admin') or u is null then
      raise exception 'geofences: rol no autorizado' using errcode = '42501';
    end if;
    new.created_by := u;
    new.created_at := now();
    new.updated_at := now();
    new.deleted_at := null;
    perform pg_advisory_xact_lock(hashtextextended('geofences:' || u::text, 0));
    if (select count(*) from public.geofences g
         where g.created_by = u and g.created_at > now() - interval '1 minute') >= 30 then
      raise exception 'rate limit: demasiadas zonas por minuto' using errcode = '54000';
    end if;
  else
    if not (coalesce(r, '') in ('viewer','admin') or (r is null and u is null)) then
      raise exception 'geofences: rol no autorizado' using errcode = '42501';
    end if;
    if old.deleted_at is not null and r is not null then
      raise exception 'geofences: la zona ya fue dada de baja' using errcode = '42501';
    end if;
    new.id := old.id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.shape := old.shape;
    new.updated_at := now();
    if new.deleted_at is not null and old.deleted_at is null then
      new.deleted_at := now();
    end if;
  end if;
  return new;
end $$;
revoke all on function public.geofences_guard() from public, anon, authenticated;

drop trigger if exists geofences_guard_trg on public.geofences;
create trigger geofences_guard_trg before insert or update on public.geofences
  for each row execute function public.geofences_guard();

alter table public.geofences enable row level security;
revoke all on public.geofences from anon;
revoke all on public.geofences from authenticated;
grant select on public.geofences to authenticated;
grant insert (name, kind, shape, geometry, message, alarm, device_ids, active) on public.geofences to authenticated;
grant update (name, kind, geometry, message, alarm, device_ids, active, deleted_at) on public.geofences to authenticated;
-- Sin grant ni policy de DELETE: nadie via API.

drop policy if exists geofences_select_viewer on public.geofences;
create policy geofences_select_viewer on public.geofences
  for select to authenticated
  using (public.jwt_role() in ('viewer','admin'));

drop policy if exists geofences_select_device on public.geofences;
create policy geofences_select_device on public.geofences
  for select to authenticated
  using (public.jwt_role() = 'device'
         and public.jwt_device_id() is not null
         and active
         and deleted_at is null
         and (device_ids is null or public.jwt_device_id() = any (device_ids)));

drop policy if exists geofences_insert_viewer on public.geofences;
create policy geofences_insert_viewer on public.geofences
  for insert to authenticated
  with check (public.jwt_role() in ('viewer','admin') and created_by = auth.uid());

-- USING exige deleted_at is null: una fila dada de baja queda congelada para la API.
-- WITH CHECK no lo exige: asi la propia baja (deleted_at = ahora) pasa.
drop policy if exists geofences_update_viewer on public.geofences;
create policy geofences_update_viewer on public.geofences
  for update to authenticated
  using (public.jwt_role() in ('viewer','admin') and deleted_at is null)
  with check (public.jwt_role() in ('viewer','admin'));

-- ===========================================================================
-- 2. geo_points  (georreferencias; 'peligro' = zona restringida circular para el casco)
-- ===========================================================================
create table if not exists public.geo_points (
  id             uuid primary key default gen_random_uuid(),
  name           text not null
                 check (length(btrim(name)) between 1 and 80 and name !~ '[[:cntrl:]]'),
  category       text not null
                 check (category in ('punto_reunion','extintor','botiquin','acceso','peligro','otro')),
  lat            double precision not null check (lat between -90 and 90),
  lng            double precision not null check (lng between -180 and 180),
  -- Permite salto de linea y tabulacion; prohibe el resto de caracteres de control.
  notes          text check (notes is null
                             or (length(notes) <= 500 and notes !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]')),
  alert_radius_m integer,
  message        text check (message is null
                             or (length(message) between 1 and 140 and message !~ '[[:cntrl:]]')),
  alarm          text not null default 'voz_y_sirena' check (alarm in ('voz','sirena','voz_y_sirena')),
  active         boolean not null default true,
  created_by     uuid not null default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  -- Radio de alerta: obligatorio y 5..500 para 'peligro', nulo para el resto.
  constraint geo_points_radius_ck check (
    (category = 'peligro' and alert_radius_m is not null and alert_radius_m between 5 and 500)
    or (category <> 'peligro' and alert_radius_m is null))
);
create index if not exists geo_points_created_idx on public.geo_points (created_at desc);
create index if not exists geo_points_user_idx    on public.geo_points (created_by, created_at desc);

create or replace function public.geo_points_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare u uuid := auth.uid(); r text := public.jwt_role();
begin
  new.message := nullif(btrim(new.message), '');
  -- Radio: default 30 para peligro; el resto no usa radio.
  if new.category = 'peligro' then
    new.alert_radius_m := coalesce(new.alert_radius_m, 30);
  else
    new.alert_radius_m := null;
  end if;
  if tg_op = 'INSERT' then
    if coalesce(r, '') not in ('viewer','admin') or u is null then
      raise exception 'geo_points: rol no autorizado' using errcode = '42501';
    end if;
    new.created_by := u;
    new.created_at := now();
    new.updated_at := now();
    new.deleted_at := null;
    perform pg_advisory_xact_lock(hashtextextended('geo_points:' || u::text, 0));
    if (select count(*) from public.geo_points p
         where p.created_by = u and p.created_at > now() - interval '1 minute') >= 30 then
      raise exception 'rate limit: demasiados puntos por minuto' using errcode = '54000';
    end if;
  else
    if not (coalesce(r, '') in ('viewer','admin') or (r is null and u is null)) then
      raise exception 'geo_points: rol no autorizado' using errcode = '42501';
    end if;
    if old.deleted_at is not null and r is not null then
      raise exception 'geo_points: el punto ya fue dado de baja' using errcode = '42501';
    end if;
    new.id := old.id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.updated_at := now();
    if new.deleted_at is not null and old.deleted_at is null then
      new.deleted_at := now();
    end if;
  end if;
  return new;
end $$;
revoke all on function public.geo_points_guard() from public, anon, authenticated;

drop trigger if exists geo_points_guard_trg on public.geo_points;
create trigger geo_points_guard_trg before insert or update on public.geo_points
  for each row execute function public.geo_points_guard();

alter table public.geo_points enable row level security;
revoke all on public.geo_points from anon;
revoke all on public.geo_points from authenticated;
grant select on public.geo_points to authenticated;
grant insert (name, category, lat, lng, notes, alert_radius_m, message, alarm, active)
  on public.geo_points to authenticated;
grant update (name, category, lat, lng, notes, alert_radius_m, message, alarm, active, deleted_at)
  on public.geo_points to authenticated;

drop policy if exists geo_points_select_viewer on public.geo_points;
create policy geo_points_select_viewer on public.geo_points
  for select to authenticated
  using (public.jwt_role() in ('viewer','admin'));

drop policy if exists geo_points_select_device on public.geo_points;
create policy geo_points_select_device on public.geo_points
  for select to authenticated
  using (public.jwt_role() = 'device'
         and public.jwt_device_id() is not null
         and category = 'peligro'
         and active
         and deleted_at is null);

drop policy if exists geo_points_insert_viewer on public.geo_points;
create policy geo_points_insert_viewer on public.geo_points
  for insert to authenticated
  with check (public.jwt_role() in ('viewer','admin') and created_by = auth.uid());

drop policy if exists geo_points_update_viewer on public.geo_points;
create policy geo_points_update_viewer on public.geo_points
  for update to authenticated
  using (public.jwt_role() in ('viewer','admin') and deleted_at is null)
  with check (public.jwt_role() in ('viewer','admin'));

-- ===========================================================================
-- Tiempo real para el visor y el casco (idempotente; respeta RLS)
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['geofences','geo_points'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime'
                     and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Retencion (PROTOCOLO-GEO seccion 6: recorridos 30 dias; requiere pg_cron):
-- Database > Extensions > pg_cron, y despues en SQL Editor:
-- select cron.schedule('casco-purge-location', '20 3 * * *',
--   $$delete from public.events where type='location' and created_at < now() - interval '30 days'$$);
-- Opcional: limpiar bajas logicas viejas (90 dias):
-- select cron.schedule('casco-purge-geo-bajas', '25 3 * * *',
--   $$delete from public.geofences where deleted_at < now() - interval '90 days';
--     delete from public.geo_points where deleted_at < now() - interval '90 days'$$);
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 007_equipos.sql
-- ===========================================================================

-- Equipos: registro de cascos, grupos, personas y asignaciones casco <-> persona.
-- Idempotente. Ejecutar en Supabase > SQL Editor (despues de schema.sql, 002, 003, 004, 005 y 006).
-- El repo es PUBLICO: aqui no hay datos reales. Ver supabase/seed/equipos.example.sql.
--
-- Resumen de permisos (la anon key es publica; toda la seguridad esta aqui):
--   groups, devices, people : viewer/admin leen e insertan y editan por columna; sin DELETE por API
--                             (baja logica con deleted_at; una fila dada de baja queda congelada).
--   assignments             : viewer/admin leen e insertan (device_id, person_id); solo cierran (ends_at).
--   group_members           : solo estructura (fase 2). Sin escritura por API.
--   Privacidad (Ley 25.326):
--     * people.dni y people.contact_phone: solo role admin. La tabla NO concede SELECT de esas columnas
--       a nadie; el admin las lee por la vista public.people_full (filtra por jwt_role() = 'admin').
--       Un viewer no puede leerlas ni usarlas en un WHERE. Escribirlas: solo admin (trigger).
--     * devices.imei, sim1_iccid, sim2_iccid, sim_line, bt_headset_mac, notes, created_by: la tabla NO
--       concede SELECT de esas columnas (el casco, role device, lee su propia fila sin ellas). Viewer y
--       admin las leen por la vista public.devices_full.
--     * El rol device no accede a groups, people, assignments ni group_members.
--   OJO clientes: con SELECT por columna, `select=*` sobre devices/people da "permission denied".
--   Pedir columnas por nombre, o leer las vistas devices_full / people_full.
--
-- Decisiones (ver out/supabase-equipos-report.md):
--   * Un casco o persona NO puede tener dos asignaciones abiertas: al abrir una nueva, el trigger
--     CIERRA (ends_at = now()) la abierta anterior del casco y la abierta anterior de la persona.
--     Un indice unico parcial es la red de seguridad ante carreras.
--   * groups tambien tiene deleted_at (no estaba en el pedido) para tratar igual a las tres tablas.
--   * Unicos (name de grupo, imei, legajo) son parciales sobre filas no dadas de baja.
--   * devices.device_id es PK: una baja no libera el device_id (reactivar = SQL Editor).

-- ---------------------------------------------------------------------------
-- Guard generico para groups / devices / people (BEFORE INSERT OR UPDATE)
-- SECURITY DEFINER + search_path vacio. Las tres tablas tienen created_by, created_at,
-- updated_at y deleted_at.
--  INSERT: solo viewer/admin; fija autoria/fechas; 30 filas/min por usuario (advisory lock).
--  UPDATE: viewer/admin (o sesion sin JWT = SQL Editor/service_role); created_* inmutables;
--          updated_at = now(); deleted_at = now() al dar de baja; fila de baja congelada para la API.
-- ---------------------------------------------------------------------------
create or replace function public.registry_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare u uuid := auth.uid(); r text := public.jwt_role(); n bigint;
begin
  if tg_op = 'INSERT' then
    if coalesce(r, '') not in ('viewer','admin') or u is null then
      raise exception '%: rol no autorizado', tg_table_name using errcode = '42501';
    end if;
    new.created_by := u;
    new.created_at := now();
    new.updated_at := now();
    new.deleted_at := null;
    perform pg_advisory_xact_lock(hashtextextended(tg_table_name || ':' || u::text, 0));
    execute format('select count(*) from public.%I where created_by = $1 and created_at > now() - interval ''1 minute''',
                   tg_table_name) into n using u;
    if n >= 30 then
      raise exception 'rate limit: demasiadas altas por minuto en %', tg_table_name using errcode = '54000';
    end if;
  else
    if not (coalesce(r, '') in ('viewer','admin') or (r is null and u is null)) then
      raise exception '%: rol no autorizado', tg_table_name using errcode = '42501';
    end if;
    if old.deleted_at is not null and r is not null then
      raise exception '%: la fila ya fue dada de baja', tg_table_name using errcode = '42501';
    end if;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.updated_at := now();
    if new.deleted_at is not null and old.deleted_at is null then
      new.deleted_at := now();
    end if;
  end if;
  return new;
end $$;
revoke all on function public.registry_guard() from public, anon, authenticated;

-- ===========================================================================
-- 1. groups
-- ===========================================================================
create table if not exists public.groups (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) between 1 and 80 and name !~ '[[:cntrl:]]'),
  site       text check (site is null or (length(btrim(site)) between 1 and 80 and site !~ '[[:cntrl:]]')),
  notes      text check (notes is null
                         or (length(notes) <= 500 and notes !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]')),
  active     boolean not null default true,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists groups_name_uq on public.groups (lower(btrim(name))) where deleted_at is null;
create index if not exists groups_user_idx on public.groups (created_by, created_at desc);

drop trigger if exists groups_guard_trg on public.groups;
create trigger groups_guard_trg before insert or update on public.groups
  for each row execute function public.registry_guard();

alter table public.groups enable row level security;
revoke all on public.groups from anon;
revoke all on public.groups from authenticated;
grant select on public.groups to authenticated;
grant insert (name, site, notes, active) on public.groups to authenticated;
grant update (name, site, notes, active, deleted_at) on public.groups to authenticated;

drop policy if exists groups_select_viewer on public.groups;
create policy groups_select_viewer on public.groups
  for select to authenticated using (public.jwt_role() in ('viewer','admin'));
drop policy if exists groups_insert_viewer on public.groups;
create policy groups_insert_viewer on public.groups
  for insert to authenticated
  with check (public.jwt_role() in ('viewer','admin') and created_by = auth.uid());
drop policy if exists groups_update_viewer on public.groups;
create policy groups_update_viewer on public.groups
  for update to authenticated
  using (public.jwt_role() in ('viewer','admin') and deleted_at is null)
  with check (public.jwt_role() in ('viewer','admin'));

-- ===========================================================================
-- 2. devices  (registro de cascos; device_id = app_metadata.device_id = events.device_id)
-- ===========================================================================
create table if not exists public.devices (
  device_id       text primary key check (device_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  imei            text check (imei is null or imei ~ '^[0-9]{14,15}$'),
  name            text not null check (length(btrim(name)) between 1 and 80 and name !~ '[[:cntrl:]]'),
  model           text not null default 'rd_aqm6816'
                  check (length(btrim(model)) between 1 and 40 and model !~ '[[:cntrl:]]'),
  group_id        uuid references public.groups(id),
  sector          text check (sector is null or (length(btrim(sector)) between 1 and 60 and sector !~ '[[:cntrl:]]')),
  sim1_iccid      text check (sim1_iccid is null or sim1_iccid ~ '^[0-9]{18,22}$'),
  sim2_iccid      text check (sim2_iccid is null or sim2_iccid ~ '^[0-9]{18,22}$'),
  sim_line        text check (sim_line is null or sim_line ~ '^\+?[0-9]{6,15}$'),
  bt_headset_mac  text check (bt_headset_mac is null
                              or bt_headset_mac ~ '^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$'),
  status          text not null default 'activo' check (status in ('activo','mantenimiento','baja')),
  notes           text check (notes is null
                              or (length(notes) <= 500 and notes !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]')),
  created_by      uuid not null default auth.uid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
create unique index if not exists devices_imei_uq on public.devices (imei) where imei is not null and deleted_at is null;
create index if not exists devices_group_idx on public.devices (group_id);
create index if not exists devices_user_idx  on public.devices (created_by, created_at desc);

drop trigger if exists devices_guard_trg on public.devices;
create trigger devices_guard_trg before insert or update on public.devices
  for each row execute function public.registry_guard();

-- device_id inmutable para la API (ademas de no tener grant de UPDATE).
create or replace function public.devices_immutable() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.device_id is distinct from old.device_id and public.jwt_role() is not null then
    raise exception 'devices: device_id no se puede cambiar' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.devices_immutable() from public, anon, authenticated;
drop trigger if exists devices_immutable_trg on public.devices;
create trigger devices_immutable_trg before update on public.devices
  for each row execute function public.devices_immutable();

alter table public.devices enable row level security;
revoke all on public.devices from anon;
revoke all on public.devices from authenticated;
-- SELECT por columna: SIN imei, sim1_iccid, sim2_iccid, sim_line, bt_headset_mac, notes, created_by.
grant select (device_id, name, model, group_id, sector, status, created_at, updated_at, deleted_at)
  on public.devices to authenticated;
grant insert (device_id, imei, name, model, group_id, sector, sim1_iccid, sim2_iccid, sim_line,
              bt_headset_mac, status, notes) on public.devices to authenticated;
grant update (imei, name, model, group_id, sector, sim1_iccid, sim2_iccid, sim_line,
              bt_headset_mac, status, notes, deleted_at) on public.devices to authenticated;

drop policy if exists devices_select_viewer on public.devices;
create policy devices_select_viewer on public.devices
  for select to authenticated using (public.jwt_role() in ('viewer','admin'));
-- El casco lee SOLO su propia fila (y solo las columnas del grant de arriba).
drop policy if exists devices_select_device on public.devices;
create policy devices_select_device on public.devices
  for select to authenticated
  using (public.jwt_role() = 'device'
         and public.jwt_device_id() is not null
         and device_id = public.jwt_device_id()
         and deleted_at is null);
drop policy if exists devices_insert_viewer on public.devices;
create policy devices_insert_viewer on public.devices
  for insert to authenticated
  with check (public.jwt_role() in ('viewer','admin') and created_by = auth.uid());
drop policy if exists devices_update_viewer on public.devices;
create policy devices_update_viewer on public.devices
  for update to authenticated
  using (public.jwt_role() in ('viewer','admin') and deleted_at is null)
  with check (public.jwt_role() in ('viewer','admin'));

-- Vista con TODAS las columnas para viewer/admin. Corre con los privilegios del dueno (a proposito:
-- es la forma de dar columnas que la tabla no concede); el filtro de rol esta en la propia vista.
create or replace view public.devices_full as
  select device_id, imei, name, model, group_id, sector, sim1_iccid, sim2_iccid, sim_line,
         bt_headset_mac, status, notes, created_by, created_at, updated_at, deleted_at
    from public.devices
   where public.jwt_role() in ('viewer','admin');
revoke all on public.devices_full from anon;
revoke all on public.devices_full from authenticated;
grant select on public.devices_full to authenticated;

-- ===========================================================================
-- 3. people  (dni y contact_phone: solo admin)
-- ===========================================================================
create table if not exists public.people (
  id            uuid primary key default gen_random_uuid(),
  full_name     text not null check (length(btrim(full_name)) between 1 and 120 and full_name !~ '[[:cntrl:]]'),
  legajo        text check (legajo is null or legajo ~ '^[A-Za-z0-9._/-]{1,20}$'),
  dni           text check (dni is null or dni ~ '^[A-Za-z0-9]{5,15}$'),
  job_title     text check (job_title is null or (length(btrim(job_title)) between 1 and 80 and job_title !~ '[[:cntrl:]]')),
  sector        text check (sector is null or (length(btrim(sector)) between 1 and 60 and sector !~ '[[:cntrl:]]')),
  contact_phone text check (contact_phone is null or contact_phone ~ '^\+?[0-9 ()-]{6,20}$'),
  group_id      uuid references public.groups(id),
  active        boolean not null default true,
  created_by    uuid not null default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create unique index if not exists people_legajo_uq on public.people (legajo) where legajo is not null and deleted_at is null;
create index if not exists people_group_idx on public.people (group_id);
create index if not exists people_user_idx  on public.people (created_by, created_at desc);

drop trigger if exists people_guard_trg on public.people;
create trigger people_guard_trg before insert or update on public.people
  for each row execute function public.registry_guard();

-- Solo admin escribe dni / contact_phone (la columna es escribible por authenticated; el filtro es este).
-- Sesion sin JWT (SQL Editor) permitida.
create or replace function public.people_privacy_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r text := public.jwt_role();
begin
  if (tg_op = 'INSERT' and (new.dni is not null or new.contact_phone is not null))
     or (tg_op = 'UPDATE' and (new.dni is distinct from old.dni
                               or new.contact_phone is distinct from old.contact_phone)) then
    if r is distinct from 'admin' and not (r is null and auth.uid() is null) then
      raise exception 'people: dni y telefono solo los edita un admin' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.people_privacy_guard() from public, anon, authenticated;
drop trigger if exists people_privacy_guard_trg on public.people;
create trigger people_privacy_guard_trg before insert or update on public.people
  for each row execute function public.people_privacy_guard();

alter table public.people enable row level security;
revoke all on public.people from anon;
revoke all on public.people from authenticated;
-- SELECT por columna: SIN dni ni contact_phone (para nadie; el admin usa people_full).
grant select (id, full_name, legajo, job_title, sector, group_id, active, created_by, created_at, updated_at, deleted_at)
  on public.people to authenticated;
grant insert (full_name, legajo, dni, job_title, sector, contact_phone, group_id, active)
  on public.people to authenticated;
grant update (full_name, legajo, dni, job_title, sector, contact_phone, group_id, active, deleted_at)
  on public.people to authenticated;

drop policy if exists people_select_viewer on public.people;
create policy people_select_viewer on public.people
  for select to authenticated using (public.jwt_role() in ('viewer','admin'));
drop policy if exists people_insert_viewer on public.people;
create policy people_insert_viewer on public.people
  for insert to authenticated
  with check (public.jwt_role() in ('viewer','admin') and created_by = auth.uid());
drop policy if exists people_update_viewer on public.people;
create policy people_update_viewer on public.people
  for update to authenticated
  using (public.jwt_role() in ('viewer','admin') and deleted_at is null)
  with check (public.jwt_role() in ('viewer','admin'));

-- Vista completa SOLO para admin (devuelve 0 filas a cualquier otro rol).
create or replace view public.people_full as
  select id, full_name, legajo, dni, job_title, sector, contact_phone, group_id, active,
         created_by, created_at, updated_at, deleted_at
    from public.people
   where public.jwt_role() = 'admin';
revoke all on public.people_full from anon;
revoke all on public.people_full from authenticated;
grant select on public.people_full to authenticated;

-- ===========================================================================
-- 4. assignments  (historial casco <-> persona; ends_at null = vigente)
-- ===========================================================================
create table if not exists public.assignments (
  id         uuid primary key default gen_random_uuid(),
  device_id  text not null references public.devices(device_id),
  person_id  uuid not null references public.people(id),
  starts_at  timestamptz not null default now(),
  ends_at    timestamptz,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  constraint assignments_period_ck check (ends_at is null or ends_at >= starts_at)
);
-- Red de seguridad: como mucho UNA asignacion abierta por casco y por persona.
create unique index if not exists assignments_open_device_uq on public.assignments (device_id) where ends_at is null;
create unique index if not exists assignments_open_person_uq on public.assignments (person_id) where ends_at is null;
create index if not exists assignments_device_idx on public.assignments (device_id, starts_at desc);
create index if not exists assignments_person_idx on public.assignments (person_id, starts_at desc);
create index if not exists assignments_user_idx   on public.assignments (created_by, created_at desc);

create or replace function public.assignments_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare u uuid := auth.uid(); r text := public.jwt_role(); n bigint;
        dv record; pe record;
begin
  if tg_op = 'INSERT' then
    if coalesce(r, '') not in ('viewer','admin') or u is null then
      raise exception 'assignments: rol no autorizado' using errcode = '42501';
    end if;
    new.created_by := u;
    new.created_at := now();
    new.starts_at  := now();
    new.ends_at    := null;
    perform pg_advisory_xact_lock(hashtextextended('assignments:' || u::text, 0));
    select count(*) into n from public.assignments a
     where a.created_by = u and a.created_at > now() - interval '1 minute';
    if n >= 30 then
      raise exception 'rate limit: demasiadas asignaciones por minuto' using errcode = '54000';
    end if;
    select deleted_at, status into dv from public.devices where device_id = new.device_id;
    if not found or dv.deleted_at is not null or dv.status = 'baja' then
      raise exception 'assignments: casco inexistente o dado de baja' using errcode = '22023';
    end if;
    select deleted_at, active into pe from public.people where id = new.person_id;
    if not found or pe.deleted_at is not null or not pe.active then
      raise exception 'assignments: persona inexistente, inactiva o dada de baja' using errcode = '22023';
    end if;
    -- Serializa por casco y por persona y cierra las asignaciones abiertas anteriores.
    perform pg_advisory_xact_lock(hashtextextended('assign-dev:' || new.device_id, 0));
    perform pg_advisory_xact_lock(hashtextextended('assign-per:' || new.person_id::text, 0));
    update public.assignments set ends_at = now()
     where ends_at is null and (device_id = new.device_id or person_id = new.person_id);
  else
    if not (coalesce(r, '') in ('viewer','admin') or (r is null and u is null)) then
      raise exception 'assignments: rol no autorizado' using errcode = '42501';
    end if;
    if old.ends_at is not null and r is not null then
      raise exception 'assignments: la asignacion ya esta cerrada' using errcode = '42501';
    end if;
    new.id := old.id;
    new.device_id := old.device_id;
    new.person_id := old.person_id;
    new.starts_at := old.starts_at;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    if old.ends_at is null and new.ends_at is not null then
      new.ends_at := now();
    end if;
  end if;
  return new;
end $$;
revoke all on function public.assignments_guard() from public, anon, authenticated;
drop trigger if exists assignments_guard_trg on public.assignments;
create trigger assignments_guard_trg before insert or update on public.assignments
  for each row execute function public.assignments_guard();

alter table public.assignments enable row level security;
revoke all on public.assignments from anon;
revoke all on public.assignments from authenticated;
grant select on public.assignments to authenticated;
grant insert (device_id, person_id) on public.assignments to authenticated;
grant update (ends_at) on public.assignments to authenticated;

drop policy if exists assignments_select_viewer on public.assignments;
create policy assignments_select_viewer on public.assignments
  for select to authenticated using (public.jwt_role() in ('viewer','admin'));
drop policy if exists assignments_insert_viewer on public.assignments;
create policy assignments_insert_viewer on public.assignments
  for insert to authenticated
  with check (public.jwt_role() in ('viewer','admin') and created_by = auth.uid());
drop policy if exists assignments_update_viewer on public.assignments;
create policy assignments_update_viewer on public.assignments
  for update to authenticated
  using (public.jwt_role() in ('viewer','admin') and ends_at is null)
  with check (public.jwt_role() in ('viewer','admin'));

-- ===========================================================================
-- 5. group_members  (SOLO estructura; el filtrado por grupo es fase 2)
-- ===========================================================================
create table if not exists public.group_members (
  user_id    uuid not null references auth.users(id) on delete cascade,
  group_id   uuid not null references public.groups(id),
  created_at timestamptz not null default now(),
  primary key (user_id, group_id)
);
create index if not exists group_members_group_idx on public.group_members (group_id);

alter table public.group_members enable row level security;
revoke all on public.group_members from anon;
revoke all on public.group_members from authenticated;
grant select on public.group_members to authenticated;
-- Sin grants de escritura: la membresia la carga un admin desde el SQL Editor (fase 2: pantalla).
drop policy if exists group_members_select on public.group_members;
create policy group_members_select on public.group_members
  for select to authenticated
  using (public.jwt_role() = 'admin'
         or (public.jwt_role() = 'viewer' and user_id = auth.uid()));

-- true si el usuario del JWT pertenece al grupo. SECURITY DEFINER para poder usarse dentro de
-- policies de otras tablas sin que el usuario necesite leer group_members.
create or replace function public.user_in_group(p_group uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.group_members m
                  where m.user_id = auth.uid() and m.group_id = p_group)
$$;
revoke all on function public.user_in_group(uuid) from public, anon;
grant execute on function public.user_in_group(uuid) to authenticated;

-- PLAN FASE 2 (NO aplicado todavia): filtrar por grupo lo que ve cada supervisor.
--   * events / stream_commands / rtc_signals / broadcasts / geofences: agregar a la policy de SELECT
--     de viewer una condicion  (not exists (select 1 from public.group_members m where m.user_id = auth.uid())
--     or exists (select 1 from public.devices d where d.device_id = <tabla>.device_id
--                and public.user_in_group(d.group_id)))
--     es decir: un viewer sin membresias sigue viendo todo (compatibilidad); con membresias, solo los
--     cascos de sus grupos. admin siempre ve todo.
--   * Hace falta un indice en events(device_id) (ya existe events_device_idx) y cachear el join con
--     una funcion STABLE para no pagar un subselect por fila.
--   * Escribir tambien debe respetarlo: comandos, voz y ordenes solo a cascos de sus grupos.

-- ===========================================================================
-- Tiempo real (idempotente; respeta RLS). Ver nota de columnas en el informe.
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['devices','assignments'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime'
                     and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- VERIFICACION (al final debe mostrar: funciones 2, tablas 15, bucket 1, guard_trigger 1,
-- rtc_trigger 1, rtc_realtime 1, centro_tablas 4, centro_realtime 2,
-- regla_defecto 1, tipos_nuevos_events 2, centro_triggers_esperado_3 = 3,
-- geo_tablas 2, geo_triggers_esperado_2 = 2, geo_realtime 2, geo_validadores 2,
-- equipos_tablas 5, equipos_vistas 2, equipos_triggers_esperado_5 = 5, equipos_realtime 2)
-- ---------------------------------------------------------------------------
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname in ('jwt_role','jwt_device_id')) as funciones,
  (select count(*) from pg_tables where schemaname='public'
     and tablename in ('events','event_acks','stream_commands','rtc_signals',
                       'escalation_rules','escalations','broadcasts','broadcast_acks',
                       'geofences','geo_points',
                       'groups','devices','people','assignments','group_members')) as tablas,
  (select count(*) from storage.buckets where id='casco-media') as bucket,
  (select count(*) from pg_trigger where tgname='stream_commands_guard_trg') as guard_trigger,
  (select count(*) from pg_trigger where tgname='rtc_signals_guard_trg') as rtc_trigger,
  (select count(*) from pg_publication_tables where pubname='supabase_realtime'
     and schemaname='public' and tablename='rtc_signals') as rtc_realtime,
  (select count(*) from pg_tables where schemaname='public'
     and tablename in ('escalation_rules','escalations','broadcasts','broadcast_acks')) as centro_tablas,
  (select count(*) from pg_trigger where tgname in ('escalation_rules_guard_trg','broadcasts_guard_trg',
     'broadcast_acks_guard_trg') and not tgisinternal) as centro_triggers_esperado_3,
  (select count(*) from pg_publication_tables where pubname='supabase_realtime'
     and schemaname='public' and tablename in ('broadcasts','broadcast_acks')) as centro_realtime,
  (select count(*) from public.escalation_rules
     where id='00000000-0000-4000-8000-0000000000e1') as regla_defecto,
  (select count(*) from regexp_matches(
     (select pg_get_constraintdef(oid) from pg_constraint where conname='events_type_check'),
     '(location|geofence)', 'g')) as tipos_nuevos_events_esperado_2,
  (select count(*) from pg_tables where schemaname='public'
     and tablename in ('geofences','geo_points')) as geo_tablas,
  (select count(*) from pg_trigger where tgname in ('geofences_guard_trg','geo_points_guard_trg')
     and not tgisinternal) as geo_triggers_esperado_2,
  (select count(*) from pg_publication_tables where pubname='supabase_realtime'
     and schemaname='public' and tablename in ('geofences','geo_points')) as geo_realtime,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname in ('geo_latlng_valid','geofence_geometry_valid')) as geo_validadores,
  (select count(*) from pg_tables where schemaname='public'
     and tablename in ('groups','devices','people','assignments','group_members')) as equipos_tablas,
  (select count(*) from pg_views where schemaname='public'
     and viewname in ('devices_full','people_full')) as equipos_vistas,
  (select count(*) from pg_trigger where tgname in ('groups_guard_trg','devices_guard_trg','people_guard_trg',
     'assignments_guard_trg','people_privacy_guard_trg') and not tgisinternal) as equipos_triggers_esperado_5,
  (select count(*) from pg_publication_tables where pubname='supabase_realtime'
     and schemaname='public' and tablename in ('devices','assignments')) as equipos_realtime;

-- ===== 008_retencion_y_baja.sql =====
-- Retencion de datos (Ley 25.326), indice de alertas y corte de acceso de cascos dados de baja.
-- Ver out/audit-supabase.md R1-R3. Idempotente. Ejecutar en Supabase > SQL Editor (despues de 007).

create extension if not exists pg_cron;

create index if not exists events_alerts_idx on public.events (created_at desc)
  where type in ('sos','fall','geofence');

create or replace function public.casco_purge() returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.events        where type = 'heartbeat' and created_at < now() - interval '7 days';
  delete from public.events        where type = 'location'  and created_at < now() - interval '30 days';
  delete from public.events        where type = 'geofence'  and created_at < now() - interval '90 days';
  -- sos/fall/photo/video: 1 ano (la cascada se lleva event_acks y escalations: no acortar)
  delete from public.events        where type in ('sos','fall','photo','video') and created_at < now() - interval '365 days';
  delete from public.rtc_signals   where created_at < now() - interval '1 day';
  delete from public.stream_commands where created_at < now() - interval '7 days';
  delete from public.broadcasts    where created_at < now() - interval '90 days';
  delete from public.geofences     where deleted_at < now() - interval '90 days';
  delete from public.geo_points    where deleted_at < now() - interval '90 days';
end $$;
revoke all on function public.casco_purge() from public, anon, authenticated;

select cron.unschedule('casco-purge') where exists (select 1 from cron.job where jobname = 'casco-purge');
select cron.schedule('casco-purge', '10 3 * * *', $$select public.casco_purge()$$);

-- Un casco dado de baja (status='baja' o deleted_at) deja de insertar eventos aunque su JWT siga vigente.
create or replace function public.device_is_active(p text) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.devices d
                      where d.device_id = p and (d.deleted_at is not null or d.status = 'baja'))
$$;
revoke all on function public.device_is_active(text) from public, anon;
grant execute on function public.device_is_active(text) to authenticated;

drop policy if exists events_insert_device on public.events;
create policy events_insert_device on public.events
  for insert to authenticated
  with check (
    public.jwt_role() = 'device'
    and public.jwt_device_id() is not null
    and device_id = public.jwt_device_id()
    and (media_path is null or split_part(media_path, '/', 1) = device_id)
    and public.device_is_active(device_id)
  );

-- ===== 009_sos_siempre.sql =====
-- Un SOS / caida nunca se pierde por un error administrativo: un casco dado de baja sigue pudiendo
-- mandar sos y fall (el resto de sus eventos si se rechaza). Ver out/review-externa.md punto 7.
-- Idempotente. Ejecutar en Supabase > SQL Editor (despues de 008).
drop policy if exists events_insert_device on public.events;
create policy events_insert_device on public.events
  for insert to authenticated
  with check (
    public.jwt_role() = 'device'
    and public.jwt_device_id() is not null
    and device_id = public.jwt_device_id()
    and (media_path is null or split_part(media_path, '/', 1) = device_id)
    and (type in ('sos','fall') or public.device_is_active(device_id))
  );

-- ===== 010_comandos_config_roles.sql =====
-- Tanda 4: comandos a pedido, configuracion remota por casco, alertas nuevas, roles viewer/admin y reporte.
-- Ver docs/PROTOCOLO-COMANDOS.md. Idempotente. Ejecutar en Supabase > SQL Editor (despues de 009).
--
-- Resumen de permisos (la anon key es publica; toda la seguridad esta aqui):
--   device_commands     : viewer/admin insertan (device_id, action, params) y leen; restart_agent SOLO admin;
--                         device lee solo los de su device_id de los ultimos 2 min. Sin UPDATE/DELETE. 10/min por usuario.
--   device_command_acks : device inserta SOLO con su device_id, de un comando suyo reciente (<= 10 min) y solo si el
--                         casco esta activo; viewer/admin leen. Sin UPDATE/DELETE. 30/min por casco.
--   device_config       : admin inserta/actualiza; viewer/admin leen; device lee SOLO su fila. Claves y tipos validados.
--   Roles (seccion 5 del contrato): SOLO admin escribe devices, people, groups, assignments, geofences, geo_points y
--                         device_config; broadcasts kind='evacuacion' solo admin. viewer conserva lectura, event_acks,
--                         stream_commands, photo/torch/ping y broadcasts kind='mensaje'.
--   events.type         : + not_worn, inactive, equip, fall_cancel. sos y fall siguen aceptados de un casco dado de baja
--                         (migracion 009); el resto de los tipos (incluidos los nuevos) exige device_is_active.
--
-- Defensa en profundidad del cambio de roles: ademas de reescribir las policies, un trigger BEFORE INSERT OR UPDATE
-- (aa_admin_only_trg, se dispara antes que los guards 006/007 por orden alfabetico) rechaza a todo el que no sea admin.
-- Excepcion deliberada: una sesion directa de base de datos SIN JWT (SQL Editor, migraciones, fixtures de prueba) y
-- service_role pasan; PostgREST siempre setea request.jwt.claims, asi que ninguna peticion de la API cae en ese caso.
-- Si alguien vuelve a ejecutar 005/006/007 sueltas, las policies viejas de viewer reaparecen pero el trigger sigue
-- bloqueando; volve a correr esta migracion para limpiarlas.

-- ===========================================================================
-- 0. events.type: lista completa (existentes + nuevos). NOT VALID: no revalida filas viejas.
-- ===========================================================================
alter table public.events drop constraint if exists events_type_check;
alter table public.events add constraint events_type_check
  check (type in ('sos','photo','video','heartbeat','fall','location','geofence',
                  'not_worn','inactive','equip','fall_cancel')) not valid;

-- Alertas que requieren atencion (reporte e historial). El indice parcial de 008 no incluye los tipos nuevos.
create index if not exists events_attention_idx on public.events (created_at desc)
  where type in ('sos','fall','geofence','not_worn','inactive');

-- Regla de 009 (sos/fall siempre aceptados aunque el casco este de baja; el resto exige casco activo,
-- tipos nuevos incluidos). Se repite para que esta migracion sea autocontenida; no cambia nada respecto de 009.
drop policy if exists events_insert_device on public.events;
create policy events_insert_device on public.events
  for insert to authenticated
  with check (
    public.jwt_role() = 'device'
    and public.jwt_device_id() is not null
    and device_id = public.jwt_device_id()
    and (media_path is null or split_part(media_path, '/', 1) = device_id)
    and (type in ('sos','fall') or public.device_is_active(device_id))
  );

-- ===========================================================================
-- 1. Roles: solo admin escribe el registro, el mapa y la configuracion
-- ===========================================================================
-- Trigger generico. Permite: (a) role admin con usuario; (b) sesion directa de base de datos SIN JWT
-- (auth.jwt() null y auth.uid() null); (c) service_role. Bloquea viewer, device, anon y authenticated sin rol
-- (claims presentes sin admin).
create or replace function public.admin_only_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r text := public.jwt_role(); u uuid := auth.uid();
begin
  if (r = 'admin' and u is not null)
     or (auth.jwt() is null and u is null)
     or coalesce(auth.jwt() ->> 'role', '') = 'service_role' then
    return new;
  end if;
  raise exception '%: solo un admin puede modificar', tg_table_name using errcode = '42501';
end $$;
revoke all on function public.admin_only_guard() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['groups','devices','people','assignments','geofences','geo_points'] loop
    execute format('drop trigger if exists aa_admin_only_trg on public.%I', t);
    execute format('create trigger aa_admin_only_trg before insert or update on public.%I
                      for each row execute function public.admin_only_guard()', t);
  end loop;
end $$;

-- Policies: se quitan las de viewer y se crean las de admin (misma logica de baja logica/congelado que 006/007).
-- groups
drop policy if exists groups_insert_viewer on public.groups;
drop policy if exists groups_update_viewer on public.groups;
drop policy if exists groups_insert_admin on public.groups;
create policy groups_insert_admin on public.groups
  for insert to authenticated
  with check (public.jwt_role() = 'admin' and created_by = auth.uid());
drop policy if exists groups_update_admin on public.groups;
create policy groups_update_admin on public.groups
  for update to authenticated
  using (public.jwt_role() = 'admin' and deleted_at is null)
  with check (public.jwt_role() = 'admin');

-- devices
drop policy if exists devices_insert_viewer on public.devices;
drop policy if exists devices_update_viewer on public.devices;
drop policy if exists devices_insert_admin on public.devices;
create policy devices_insert_admin on public.devices
  for insert to authenticated
  with check (public.jwt_role() = 'admin' and created_by = auth.uid());
drop policy if exists devices_update_admin on public.devices;
create policy devices_update_admin on public.devices
  for update to authenticated
  using (public.jwt_role() = 'admin' and deleted_at is null)
  with check (public.jwt_role() = 'admin');

-- people
drop policy if exists people_insert_viewer on public.people;
drop policy if exists people_update_viewer on public.people;
drop policy if exists people_insert_admin on public.people;
create policy people_insert_admin on public.people
  for insert to authenticated
  with check (public.jwt_role() = 'admin' and created_by = auth.uid());
drop policy if exists people_update_admin on public.people;
create policy people_update_admin on public.people
  for update to authenticated
  using (public.jwt_role() = 'admin' and deleted_at is null)
  with check (public.jwt_role() = 'admin');

-- assignments (solo se cierran: ends_at)
drop policy if exists assignments_insert_viewer on public.assignments;
drop policy if exists assignments_update_viewer on public.assignments;
drop policy if exists assignments_insert_admin on public.assignments;
create policy assignments_insert_admin on public.assignments
  for insert to authenticated
  with check (public.jwt_role() = 'admin' and created_by = auth.uid());
drop policy if exists assignments_update_admin on public.assignments;
create policy assignments_update_admin on public.assignments
  for update to authenticated
  using (public.jwt_role() = 'admin' and ends_at is null)
  with check (public.jwt_role() = 'admin');

-- geofences
drop policy if exists geofences_insert_viewer on public.geofences;
drop policy if exists geofences_update_viewer on public.geofences;
drop policy if exists geofences_insert_admin on public.geofences;
create policy geofences_insert_admin on public.geofences
  for insert to authenticated
  with check (public.jwt_role() = 'admin' and created_by = auth.uid());
drop policy if exists geofences_update_admin on public.geofences;
create policy geofences_update_admin on public.geofences
  for update to authenticated
  using (public.jwt_role() = 'admin' and deleted_at is null)
  with check (public.jwt_role() = 'admin');

-- geo_points
drop policy if exists geo_points_insert_viewer on public.geo_points;
drop policy if exists geo_points_update_viewer on public.geo_points;
drop policy if exists geo_points_insert_admin on public.geo_points;
create policy geo_points_insert_admin on public.geo_points
  for insert to authenticated
  with check (public.jwt_role() = 'admin' and created_by = auth.uid());
drop policy if exists geo_points_update_admin on public.geo_points;
create policy geo_points_update_admin on public.geo_points
  for update to authenticated
  using (public.jwt_role() = 'admin' and deleted_at is null)
  with check (public.jwt_role() = 'admin');

-- device_ids: el CHECK de 005/006 valida la lista unida con comas, asi que UN elemento '4132,9999' pasaba.
-- Validador por elemento (inmutable; un CHECK no admite subconsultas, por eso va en funcion). NOT VALID: solo filas nuevas.
create or replace function public.device_ids_valid(p text[]) returns boolean
language sql immutable set search_path = '' as $$
  select p is null
      or (cardinality(p) between 1 and 100
          and array_position(p, null::text) is null
          and not exists (select 1 from unnest(p) d where d !~ '^[A-Za-z0-9_-]{1,64}$'))
$$;
alter table public.broadcasts drop constraint if exists broadcasts_device_ids_elems_ck;
alter table public.broadcasts add constraint broadcasts_device_ids_elems_ck
  check (public.device_ids_valid(device_ids)) not valid;
alter table public.geofences drop constraint if exists geofences_device_ids_elems_ck;
alter table public.geofences add constraint geofences_device_ids_elems_ck
  check (public.device_ids_valid(device_ids)) not valid;

-- Los grants por columna de 005/006/007 no cambian (el filtro de rol esta en policies + trigger).

-- broadcasts: viewer y admin mandan 'mensaje'; 'evacuacion' solo admin.
drop policy if exists broadcasts_insert_viewer on public.broadcasts;
drop policy if exists broadcasts_insert_by_role on public.broadcasts;
create policy broadcasts_insert_by_role on public.broadcasts
  for insert to authenticated
  with check (
    public.jwt_role() in ('viewer','admin')
    and created_by = auth.uid()
    and (kind <> 'evacuacion' or public.jwt_role() = 'admin')
  );

create or replace function public.broadcasts_kind_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'evacuacion'
     and public.jwt_role() is distinct from 'admin'
     and not (auth.jwt() is null and auth.uid() is null)
     and coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'broadcasts: la evacuacion solo la manda un admin' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.broadcasts_kind_guard() from public, anon, authenticated;
drop trigger if exists aa_broadcast_kind_trg on public.broadcasts;
create trigger aa_broadcast_kind_trg before insert on public.broadcasts
  for each row execute function public.broadcasts_kind_guard();

-- ===========================================================================
-- 2. device_commands  (supervisor -> casco: foto, linterna, reinicio, ping)
-- ===========================================================================
create table if not exists public.device_commands (
  id                 uuid primary key default gen_random_uuid(),
  device_id          text not null check (device_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  action             text not null
                     check (action in ('photo','torch_on','torch_off','restart_agent','ping')),
  params             jsonb not null default '{}'::jsonb
                     check (jsonb_typeof(params) = 'object' and octet_length(params::text) <= 1024),
  requested_by       uuid not null default auth.uid(),
  requested_by_email text not null default coalesce(auth.jwt() ->> 'email', ''),
  created_at         timestamptz not null default now()
);
create index if not exists device_commands_device_idx on public.device_commands (device_id, created_at desc);
create index if not exists device_commands_user_idx   on public.device_commands (requested_by, created_at desc);

-- Trigger: rol viewer/admin, restart_agent solo admin, autoria y fecha del servidor, 10/min por usuario
-- (advisory lock por usuario: dos inserciones concurrentes no pasan de 10).
create or replace function public.device_commands_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare u uuid := auth.uid(); r text := public.jwt_role();
begin
  if coalesce(r, '') not in ('viewer','admin') or u is null then
    raise exception 'device_commands: rol no autorizado' using errcode = '42501';
  end if;
  if new.action = 'restart_agent' and r <> 'admin' then
    raise exception 'device_commands: restart_agent solo lo manda un admin' using errcode = '42501';
  end if;
  new.created_at         := now();
  new.requested_by       := u;
  new.requested_by_email := coalesce(auth.jwt() ->> 'email', '');
  perform pg_advisory_xact_lock(hashtextextended('device_commands:' || u::text, 0));
  if (select count(*) from public.device_commands c
       where c.requested_by = u and c.created_at > now() - interval '1 minute') >= 10 then
    raise exception 'rate limit: demasiados comandos por minuto' using errcode = '54000';
  end if;
  return new;
end $$;
revoke all on function public.device_commands_guard() from public, anon, authenticated;

drop trigger if exists device_commands_guard_trg on public.device_commands;
create trigger device_commands_guard_trg before insert on public.device_commands
  for each row execute function public.device_commands_guard();

alter table public.device_commands enable row level security;
revoke all on public.device_commands from anon;
revoke all on public.device_commands from authenticated;
grant select on public.device_commands to authenticated;
grant insert (device_id, action, params) on public.device_commands to authenticated;
-- Sin grants ni policies de UPDATE/DELETE: el historial es inmutable para la API.

drop policy if exists dcmd_insert on public.device_commands;
create policy dcmd_insert on public.device_commands
  for insert to authenticated
  with check (
    public.jwt_role() in ('viewer','admin')
    and requested_by = auth.uid()
    and (action <> 'restart_agent' or public.jwt_role() = 'admin')
  );

drop policy if exists dcmd_select_viewer on public.device_commands;
create policy dcmd_select_viewer on public.device_commands
  for select to authenticated
  using (public.jwt_role() in ('viewer','admin'));

drop policy if exists dcmd_select_device on public.device_commands;
create policy dcmd_select_device on public.device_commands
  for select to authenticated
  using (public.jwt_role() = 'device'
         and public.jwt_device_id() is not null
         and device_id = public.jwt_device_id()
         and created_at > now() - interval '2 minutes');

-- ===========================================================================
-- 3. device_command_acks  (resultado del casco; PK = un ack por comando y casco)
-- ===========================================================================
create table if not exists public.device_command_acks (
  command_id uuid not null references public.device_commands(id) on delete cascade,
  device_id  text not null check (device_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  ok         boolean not null,
  detail     text check (detail is null or length(detail) <= 200),
  created_at timestamptz not null default now(),
  primary key (command_id, device_id)
);
create index if not exists device_command_acks_device_idx on public.device_command_acks (device_id, created_at desc);

-- true si el comando existe, es de ese casco y tiene <= 10 min (la foto puede tardar en subir; la policy de
-- SELECT del casco solo ve 2 min, por eso esta funcion es SECURITY DEFINER).
create or replace function public.device_command_ack_ok(p_cmd uuid, p_dev text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.device_commands c
                  where c.id = p_cmd and c.device_id = p_dev
                    and c.created_at > now() - interval '10 minutes')
$$;
revoke all on function public.device_command_ack_ok(uuid, text) from public, anon;
grant execute on function public.device_command_ack_ok(uuid, text) to authenticated;

-- Trigger: created_at = now() y tope 30 acks/min por casco.
create or replace function public.device_command_acks_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.created_at := now();
  if (select count(*) from public.device_command_acks a
       where a.device_id = new.device_id
         and a.created_at > now() - interval '1 minute') >= 30 then
    raise exception 'rate limit: demasiados acks de %', new.device_id using errcode = '54000';
  end if;
  return new;
end $$;
revoke all on function public.device_command_acks_guard() from public, anon, authenticated;

drop trigger if exists device_command_acks_guard_trg on public.device_command_acks;
create trigger device_command_acks_guard_trg before insert on public.device_command_acks
  for each row execute function public.device_command_acks_guard();

alter table public.device_command_acks enable row level security;
revoke all on public.device_command_acks from anon;
revoke all on public.device_command_acks from authenticated;
grant select on public.device_command_acks to authenticated;
grant insert (command_id, device_id, ok, detail) on public.device_command_acks to authenticated;

-- Cliente: insertar con Prefer: return=minimal y tratar 409/23505 (ya registrado) como exito.
-- device_is_active: un casco de baja no confirma comandos (regla 009: solo sos/fall pasan siempre).
drop policy if exists dcack_insert_device on public.device_command_acks;
create policy dcack_insert_device on public.device_command_acks
  for insert to authenticated
  with check (
    public.jwt_role() = 'device'
    and public.jwt_device_id() is not null
    and device_command_acks.device_id = public.jwt_device_id()
    and public.device_is_active(device_command_acks.device_id)
    and public.device_command_ack_ok(device_command_acks.command_id, device_command_acks.device_id)
  );

drop policy if exists dcack_select_viewer on public.device_command_acks;
create policy dcack_select_viewer on public.device_command_acks
  for select to authenticated
  using (public.jwt_role() in ('viewer','admin'));

-- ===========================================================================
-- 4. device_config  (configuracion remota por casco; solo admin escribe)
-- ===========================================================================
-- Solo claves permitidas y con el tipo correcto. Los RANGOS los valida el casco (la config local es el respaldo).
create or replace function public.device_config_valid(p jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare k text; v jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' or octet_length(p::text) > 2048 then return false; end if;
  for k, v in select * from jsonb_each(p) loop
    if k in ('fall_g_threshold','inactivity_s','not_worn_s','heartbeat_s','location_s',
             'location_s_alert','broadcast_volume') then
      if jsonb_typeof(v) <> 'number' then return false; end if;
    elsif k in ('stream_audio','voice_commands','torch_allowed') then
      if jsonb_typeof(v) <> 'boolean' then return false; end if;
    else
      return false;
    end if;
  end loop;
  return true;
end $$;

create table if not exists public.device_config (
  device_id  text primary key check (device_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  config     jsonb not null default '{}'::jsonb,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  constraint device_config_ck check (public.device_config_valid(config))
);

create or replace function public.device_config_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  if tg_op = 'UPDATE' then
    new.device_id := old.device_id;
  end if;
  return new;
end $$;
revoke all on function public.device_config_guard() from public, anon, authenticated;

drop trigger if exists device_config_guard_trg on public.device_config;
create trigger device_config_guard_trg before insert or update on public.device_config
  for each row execute function public.device_config_guard();

drop trigger if exists aa_admin_only_trg on public.device_config;
create trigger aa_admin_only_trg before insert or update on public.device_config
  for each row execute function public.admin_only_guard();

alter table public.device_config enable row level security;
revoke all on public.device_config from anon;
revoke all on public.device_config from authenticated;
grant select on public.device_config to authenticated;
grant insert (device_id, config) on public.device_config to authenticated;
grant update (config) on public.device_config to authenticated;
-- Sin DELETE: para "borrar" la config se guarda {} (el casco vuelve a su config local).

drop policy if exists dcfg_select_viewer on public.device_config;
create policy dcfg_select_viewer on public.device_config
  for select to authenticated
  using (public.jwt_role() in ('viewer','admin'));

drop policy if exists dcfg_select_device on public.device_config;
create policy dcfg_select_device on public.device_config
  for select to authenticated
  using (public.jwt_role() = 'device'
         and public.jwt_device_id() is not null
         and device_id = public.jwt_device_id());

drop policy if exists dcfg_insert_admin on public.device_config;
create policy dcfg_insert_admin on public.device_config
  for insert to authenticated
  with check (public.jwt_role() = 'admin');

drop policy if exists dcfg_update_admin on public.device_config;
create policy dcfg_update_admin on public.device_config
  for update to authenticated
  using (public.jwt_role() = 'admin')
  with check (public.jwt_role() = 'admin');

-- ===========================================================================
-- 5. incident_report  (una fila por alerta: sos, fall, geocerca que requiere atencion, not_worn, inactive)
-- ===========================================================================
-- security_invoker = true: corre con los permisos y la RLS de quien consulta (viewer/admin ven; device 0 filas).
-- Geocerca que requiere Atender = misma regla que el visor: restringida/enter, permitida/exit o peligro/enter.
-- (011 agrega archived_at al final de la lista.)
create or replace view public.incident_report with (security_invoker = true) as
  select e.id               as event_id,
         e.created_at,
         e.device_id,
         d.name             as device_name,
         e.type,
         case when e.type = 'geofence'
              then jsonb_strip_nulls(jsonb_build_object(
                     'zone_name', left(e.payload ->> 'zone_name', 60),
                     'kind',      left(e.payload ->> 'kind', 20),
                     'action',    left(e.payload ->> 'action', 10)))
              else jsonb_strip_nulls(jsonb_build_object(
                     'reason',    left(e.payload ->> 'reason', 60)))
         end                as payload,
         e.lat,
         e.lng,
         a.acked_at,
         a.acked_by_email,
         a.note,
         case when a.acked_at is not null
              then greatest(0, extract(epoch from (a.acked_at - e.created_at))::integer)
         end                as tta_s
    from public.events e
    left join public.event_acks a on a.event_id = e.id
    left join public.devices d    on d.device_id = e.device_id
   where e.type in ('sos','fall','not_worn','inactive')
      or (e.type = 'geofence'
          and ((e.payload ->> 'kind' = 'restringida' and e.payload ->> 'action' = 'enter')
            or (e.payload ->> 'kind' = 'permitida'   and e.payload ->> 'action' = 'exit')
            or (e.payload ->> 'kind' = 'peligro'     and e.payload ->> 'action' = 'enter')));
revoke all on public.incident_report from anon;
revoke all on public.incident_report from authenticated;
grant select on public.incident_report to authenticated;

-- ===========================================================================
-- 6. Retencion (Ley 25.326): casco_purge de 008 + tablas y tipos nuevos
-- ===========================================================================
create or replace function public.casco_purge() returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.events        where type = 'heartbeat' and created_at < now() - interval '7 days';
  delete from public.events        where type = 'location'  and created_at < now() - interval '30 days';
  delete from public.events        where type in ('geofence','equip','fall_cancel') and created_at < now() - interval '90 days';
  -- sos/fall/photo/video/not_worn/inactive: 1 ano (la cascada se lleva event_acks y escalations: no acortar)
  delete from public.events        where type in ('sos','fall','photo','video','not_worn','inactive')
                                     and created_at < now() - interval '365 days';
  delete from public.rtc_signals   where created_at < now() - interval '1 day';
  delete from public.stream_commands where created_at < now() - interval '7 days';
  delete from public.device_commands where created_at < now() - interval '7 days';  -- cascada: device_command_acks
  delete from public.broadcasts    where created_at < now() - interval '90 days';
  delete from public.geofences     where deleted_at < now() - interval '90 days';
  delete from public.geo_points    where deleted_at < now() - interval '90 days';
end $$;
revoke all on function public.casco_purge() from public, anon, authenticated;

-- ===========================================================================
-- 7. Tiempo real (idempotente; respeta RLS)
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['device_commands','device_command_acks','device_config'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime'
                     and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ===========================================================================
-- 8. Promover al propietario a admin (NO se ejecuta: bloque comentado).
--    Mismo SQL en supabase/promover_admin.sql. Despues, cerrar sesion y volver a entrar en el visor
--    (el rol viaja dentro del token).
-- ===========================================================================
-- update auth.users
--    set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}'::jsonb
--  where email = 'jorge_e_castro@hotmail.com';
-- select email, raw_app_meta_data from auth.users where email = 'jorge_e_castro@hotmail.com';

-- ===== 011_archivar_eventos.sql =====
-- Archivar eventos (decision del usuario): el admin oculta del Historial/Reportes alertas ya resueltas SIN perder el registro.
-- Idempotente. Ejecutar en Supabase > SQL Editor (despues de 010).
--
--   event_archive : INSERT (archivar) y DELETE (desarchivar) solo role admin; SELECT viewer/admin; el casco (device) no ve nada.
--                   Sin UPDATE. Grants por columna: insert (event_id, reason). archived_by / archived_at / archived_by_email
--                   los fija el trigger desde el JWT. 60 por minuto por usuario.
--   Solo se archiva lo ya ATENDIDO (fila en event_acks) o informativo. Una alerta pendiente (sos, fall, not_worn, inactive,
--   geocerca que requiere Atender) se rechaza con un mensaje claro.
--   La fila del evento NO se toca; borrar el evento (casco_purge) borra su archivo por cascada.
--   incident_report: expone archived_at (null si no esta archivado) y NO excluye archivados (el visor filtra).

create table if not exists public.event_archive (
  event_id          uuid primary key references public.events(id) on delete cascade,
  archived_by       uuid not null default auth.uid(),
  archived_by_email text default coalesce(auth.jwt() ->> 'email', ''),
  archived_at       timestamptz not null default now(),
  reason            text check (reason is null or length(reason) <= 200)
);
create index if not exists event_archive_at_idx   on public.event_archive (archived_at desc);
create index if not exists event_archive_user_idx on public.event_archive (archived_by, archived_at desc);

create or replace function public.event_archive_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare u uuid := auth.uid(); ev record;
begin
  -- admin con usuario, o sesion directa de DB sin JWT (SQL Editor / service_role). Nunca viewer, device ni anon.
  if not ((public.jwt_role() = 'admin' and u is not null)
          or (auth.jwt() is null and u is null)
          or coalesce(auth.jwt() ->> 'role', '') = 'service_role') then
    raise exception 'event_archive: solo un admin puede archivar' using errcode = '42501';
  end if;

  select e.type, e.payload into ev from public.events e where e.id = new.event_id;
  if found
     and (ev.type in ('sos','fall','not_worn','inactive')
          or (ev.type = 'geofence'
              and ((ev.payload ->> 'kind' = 'restringida' and ev.payload ->> 'action' = 'enter')
                or (ev.payload ->> 'kind' = 'permitida'   and ev.payload ->> 'action' = 'exit')
                or (ev.payload ->> 'kind' = 'peligro'     and ev.payload ->> 'action' = 'enter'))))
     and not exists (select 1 from public.event_acks a where a.event_id = new.event_id) then
    raise exception 'event_archive: la alerta esta pendiente de atender; atendela antes de archivarla'
      using errcode = '22023';
  end if;

  new.archived_at := now();
  if u is not null then
    new.archived_by       := u;
    new.archived_by_email := coalesce(auth.jwt() ->> 'email', '');
    perform pg_advisory_xact_lock(hashtextextended('event_archive:' || u::text, 0));
    if (select count(*) from public.event_archive x
         where x.archived_by = u and x.archived_at > now() - interval '1 minute') >= 60 then
      raise exception 'rate limit: demasiados eventos archivados por minuto' using errcode = '54000';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.event_archive_guard() from public, anon, authenticated;

drop trigger if exists event_archive_guard_trg on public.event_archive;
create trigger event_archive_guard_trg before insert on public.event_archive
  for each row execute function public.event_archive_guard();

alter table public.event_archive enable row level security;
revoke all on public.event_archive from anon;
revoke all on public.event_archive from authenticated;
grant select on public.event_archive to authenticated;
grant insert (event_id, reason) on public.event_archive to authenticated;
grant delete on public.event_archive to authenticated;   -- desarchivar; sin UPDATE

drop policy if exists earch_select_viewer on public.event_archive;
create policy earch_select_viewer on public.event_archive
  for select to authenticated
  using (public.jwt_role() in ('viewer','admin'));

drop policy if exists earch_insert_admin on public.event_archive;
create policy earch_insert_admin on public.event_archive
  for insert to authenticated
  with check (public.jwt_role() = 'admin' and archived_by = auth.uid());

drop policy if exists earch_delete_admin on public.event_archive;
create policy earch_delete_admin on public.event_archive
  for delete to authenticated
  using (public.jwt_role() = 'admin');

-- incident_report (010) + archived_at al FINAL de la lista (CREATE OR REPLACE VIEW solo permite agregar columnas al final).
create or replace view public.incident_report with (security_invoker = true) as
  select e.id               as event_id,
         e.created_at,
         e.device_id,
         d.name             as device_name,
         e.type,
         case when e.type = 'geofence'
              then jsonb_strip_nulls(jsonb_build_object(
                     'zone_name', left(e.payload ->> 'zone_name', 60),
                     'kind',      left(e.payload ->> 'kind', 20),
                     'action',    left(e.payload ->> 'action', 10)))
              else jsonb_strip_nulls(jsonb_build_object(
                     'reason',    left(e.payload ->> 'reason', 60)))
         end                as payload,
         e.lat,
         e.lng,
         a.acked_at,
         a.acked_by_email,
         a.note,
         case when a.acked_at is not null
              then greatest(0, extract(epoch from (a.acked_at - e.created_at))::integer)
         end                as tta_s,
         ar.archived_at
    from public.events e
    left join public.event_acks a     on a.event_id = e.id
    left join public.devices d        on d.device_id = e.device_id
    left join public.event_archive ar on ar.event_id = e.id
   where e.type in ('sos','fall','not_worn','inactive')
      or (e.type = 'geofence'
          and ((e.payload ->> 'kind' = 'restringida' and e.payload ->> 'action' = 'enter')
            or (e.payload ->> 'kind' = 'permitida'   and e.payload ->> 'action' = 'exit')
            or (e.payload ->> 'kind' = 'peligro'     and e.payload ->> 'action' = 'enter')));
revoke all on public.incident_report from anon;
revoke all on public.incident_report from authenticated;
grant select on public.incident_report to authenticated;

-- Tiempo real (idempotente; respeta RLS: el casco no recibe nada de esta tabla)
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime'
                   and schemaname = 'public' and tablename = 'event_archive') then
    alter publication supabase_realtime add table public.event_archive;
  end if;
end $$;

-- ===== 012_borrar_imagenes.sql =====
-- Borrar imagenes desde el visor (decision del usuario): solo admin. Idempotente. Ejecutar despues de 011.
--
-- Flujo del visor (JWT del admin): 1) sb.storage.from('casco-media').remove([path])  2) insert en event_archive
-- (event_id, reason 'Imagen eliminada'). Esta migracion solo agrega el permiso de borrado en Storage.
--   * DELETE en storage.objects: bucket 'casco-media', role admin, ruta <device_id>/<photo|video>/<archivo>
--     (device_id valido, sin '..'). viewer, device y anon NO borran. SELECT (viewer/admin) e INSERT (device) no cambian.
--   * Sigue sin policy de UPDATE: nadie sobrescribe (x-upsert falla).
--   * event_archive (011) ya acepta photo y video: son informativos (no estan en la lista de alertas pendientes del trigger),
--     asi que se archivan sin event_acks; reason admite hasta 200 caracteres. No hay cambios en 011.
--   * El evento en events NO se modifica (inmutable): la baja de la imagen queda en event_archive (archived_at, reason).
--     El evento conserva media_path apuntando a un archivo que ya no existe; el visor debe tratarlo como "imagen eliminada".

drop policy if exists media_delete_none  on storage.objects;
drop policy if exists media_delete_admin on storage.objects;
create policy media_delete_admin on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'casco-media'
    and public.jwt_role() = 'admin'
    and array_length(storage.foldername(name), 1) = 2
    and (storage.foldername(name))[1] ~ '^[A-Za-z0-9_-]{1,64}$'
    and (storage.foldername(name))[2] in ('photo','video')
    and name !~ '\.\.'
  );

-- ===== 013_asistencia_constancias_auditoria.sql =====
-- Tanda C: asistencia remota registrada, constancias de EPP y capacitacion, auditoria de accesos y rol auditor.
-- Ver docs/PROTOCOLO-ASISTENCIA.md (contrato) y su seccion "Notas de implementacion". Idempotente.
-- Ejecutar en Supabase > SQL Editor (despues de 012).
--
-- Resumen de permisos (la anon key es publica; toda la seguridad esta aqui):
--   rol auditor        : SOLO lectura (policies *_select_auditor, aditivas): events, event_acks, event_archive, devices (columnas
--                        del grant: sin imei/SIM), people (columnas del grant: sin dni/telefono), incident_report, assist_sessions,
--                        assist_report, epp_deliveries, training_records, access_log, org_settings, y training_attendees_audit
--                        (vista: la persona NO se muestra junto a la observacion). No escribe nada; no ve comandos ni config.
--   assist_sessions    : viewer/admin abren (device_id, topic; 20/min por usuario); cierra quien la abrio o admin, solo mientras
--                        ended_at is null (ended_at/closed_by_email los fija el trigger); sin DELETE. Realtime.
--   epp_deliveries     : viewer/admin insertan; SIN UPDATE/DELETE (correccion = fila nueva con supersedes). 30/min por usuario.
--   training_records / training_attendees : se escriben SOLO por rpc create_training (SECURITY DEFINER; viewer/admin, <= 200
--                        asistentes, 10/min por usuario); SIN UPDATE/DELETE.
--   access_log         : escritura SOLO por rpc log_access (120/min por usuario); SELECT admin y auditor; sin UPDATE/DELETE;
--                        retencion 1 ano en casco_purge. Sin Realtime.
--   org_settings       : fila unica (id = 1); SELECT viewer/admin/auditor; INSERT/UPDATE solo admin (upsert).
-- Inmutabilidad en dos capas: sin grants de UPDATE/DELETE + trigger immutable_row_guard (rechaza todo lo que tenga JWT,
-- incluido service_role). Pasan solo las sesiones directas de base de datos SIN JWT (SQL Editor, pg_cron/casco_purge).

-- ===========================================================================
-- 0. Guardia generica de inmutabilidad
-- ===========================================================================
create or replace function public.immutable_row_guard() returns trigger
language plpgsql security definer set search_path = '' as $fn$
begin
  if auth.jwt() is null and auth.uid() is null then
    return coalesce(new, old);   -- sesion de DB sin JWT (mantenimiento, casco_purge)
  end if;
  raise exception '%: registro inmutable; corregilo con un registro nuevo que lo reemplace', tg_table_name
    using errcode = '42501';
end $fn$;
revoke all on function public.immutable_row_guard() from public, anon, authenticated;

-- ===========================================================================
-- 1. Rol auditor: lectura aditiva sobre lo existente (las policies de viewer/admin no se tocan)
-- ===========================================================================
-- Las columnas visibles las limitan los grants por columna de 007 (devices sin imei/SIM; people sin dni/telefono);
-- devices_full / people_full siguen filtrando por rol y devuelven 0 filas al auditor.
drop policy if exists events_select_auditor on public.events;
create policy events_select_auditor on public.events
  for select to authenticated using (public.jwt_role() = 'auditor');

drop policy if exists acks_select_auditor on public.event_acks;
create policy acks_select_auditor on public.event_acks
  for select to authenticated using (public.jwt_role() = 'auditor');

drop policy if exists earch_select_auditor on public.event_archive;   -- necesaria para el left join de incident_report
create policy earch_select_auditor on public.event_archive
  for select to authenticated using (public.jwt_role() = 'auditor');

drop policy if exists devices_select_auditor on public.devices;
create policy devices_select_auditor on public.devices
  for select to authenticated using (public.jwt_role() = 'auditor');

drop policy if exists people_select_auditor on public.people;
create policy people_select_auditor on public.people
  for select to authenticated using (public.jwt_role() = 'auditor');

-- ===========================================================================
-- 2. assist_sessions  (sesiones de asistencia remota)
-- ===========================================================================
create table if not exists public.assist_sessions (
  id               uuid primary key default gen_random_uuid(),
  device_id        text not null check (device_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,
  topic            text check (topic is null or length(topic) <= 200),
  outcome          text check (outcome is null or outcome in ('resuelto','derivado','sin_resolver')),
  note             text check (note is null or length(note) <= 1000),
  photos           integer not null default 0 check (photos between 0 and 1000),
  opened_by        uuid default auth.uid(),
  opened_by_email  text default coalesce(auth.jwt() ->> 'email', ''),
  closed_by_email  text,
  constraint assist_sessions_period_ck check (ended_at is null or ended_at >= started_at)
);
create index if not exists assist_sessions_device_idx on public.assist_sessions (device_id, started_at desc);
create index if not exists assist_sessions_user_idx   on public.assist_sessions (opened_by, started_at desc);
create index if not exists assist_sessions_open_idx   on public.assist_sessions (device_id) where ended_at is null;

create or replace function public.assist_sessions_guard() returns trigger
language plpgsql security definer set search_path = '' as $fn$
declare
  u    uuid := auth.uid();
  r    text := public.jwt_role();
  mail text := coalesce(auth.jwt() ->> 'email', '');
begin
  if tg_op = 'INSERT' then
    if coalesce(r, '') not in ('viewer','admin') or u is null then
      raise exception 'assist_sessions: rol no autorizado' using errcode = '42501';
    end if;
    new.started_at      := now();
    new.ended_at        := null;
    new.closed_by_email := null;
    new.outcome         := null;
    new.note            := null;
    new.photos          := 0;
    new.opened_by       := u;
    new.opened_by_email := mail;
    perform pg_advisory_xact_lock(hashtextextended('assist_sessions:' || u::text, 0));
    if (select count(*) from public.assist_sessions s
         where s.opened_by = u and s.started_at > now() - interval '1 minute') >= 20 then
      raise exception 'rate limit: demasiadas sesiones de asistencia por minuto' using errcode = '54000';
    end if;
    return new;
  end if;

  -- UPDATE (cerrar / completar). Sesion directa de DB sin JWT: mantenimiento, sin restricciones.
  if auth.jwt() is null and u is null then
    return new;
  end if;
  if coalesce(r, '') not in ('viewer','admin') or u is null then
    raise exception 'assist_sessions: rol no autorizado' using errcode = '42501';
  end if;
  if old.ended_at is not null then
    raise exception 'assist_sessions: la sesion ya esta cerrada' using errcode = '42501';
  end if;
  if old.opened_by is distinct from u and r <> 'admin' then
    raise exception 'assist_sessions: solo quien la abrio o un admin puede cerrarla' using errcode = '42501';
  end if;
  new.id              := old.id;
  new.device_id       := old.device_id;
  new.started_at      := old.started_at;
  new.topic           := old.topic;
  new.opened_by       := old.opened_by;
  new.opened_by_email := old.opened_by_email;
  new.closed_by_email := old.closed_by_email;
  if new.ended_at is not null then
    new.ended_at        := now();
    new.closed_by_email := mail;
  end if;
  return new;
end $fn$;
revoke all on function public.assist_sessions_guard() from public, anon, authenticated;

drop trigger if exists assist_sessions_guard_trg on public.assist_sessions;
create trigger assist_sessions_guard_trg before insert or update on public.assist_sessions
  for each row execute function public.assist_sessions_guard();

drop trigger if exists assist_sessions_nodelete_trg on public.assist_sessions;
create trigger assist_sessions_nodelete_trg before delete on public.assist_sessions
  for each row execute function public.immutable_row_guard();

alter table public.assist_sessions enable row level security;
revoke all on public.assist_sessions from anon;
revoke all on public.assist_sessions from authenticated;
grant select on public.assist_sessions to authenticated;
grant insert (device_id, topic) on public.assist_sessions to authenticated;
grant update (ended_at, outcome, note, photos) on public.assist_sessions to authenticated;
-- Sin DELETE para nadie.

drop policy if exists assist_select on public.assist_sessions;
create policy assist_select on public.assist_sessions
  for select to authenticated
  using (public.jwt_role() in ('viewer','admin','auditor'));

drop policy if exists assist_insert on public.assist_sessions;
create policy assist_insert on public.assist_sessions
  for insert to authenticated
  with check (public.jwt_role() in ('viewer','admin') and opened_by = auth.uid());

drop policy if exists assist_update on public.assist_sessions;
create policy assist_update on public.assist_sessions
  for update to authenticated
  using (public.jwt_role() in ('viewer','admin')
         and ended_at is null
         and (opened_by = auth.uid() or public.jwt_role() = 'admin'))
  with check (public.jwt_role() in ('viewer','admin'));

-- Reporte: una fila por sesion con nombre del casco y duracion (null mientras esta abierta).
create or replace view public.assist_report with (security_invoker = true) as
  select s.id              as session_id,
         s.device_id,
         d.name            as device_name,
         s.started_at,
         s.ended_at,
         case when s.ended_at is not null
              then greatest(0, extract(epoch from (s.ended_at - s.started_at))::integer)
         end               as dur_s,
         s.topic,
         s.outcome,
         s.photos,
         s.opened_by_email,
         s.closed_by_email,
         s.note
    from public.assist_sessions s
    left join public.devices d on d.device_id = s.device_id;
revoke all on public.assist_report from anon;
revoke all on public.assist_report from authenticated;
grant select on public.assist_report to authenticated;

-- ===========================================================================
-- 3. epp_deliveries  (constancia de entrega de EPP; Disp. GP 3/2022)
-- ===========================================================================
create table if not exists public.epp_deliveries (
  id               uuid primary key default gen_random_uuid(),
  person_id        uuid not null references public.people(id),
  device_id        text check (device_id is null or device_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  item             text not null check (length(btrim(item)) between 1 and 120),
  quantity         integer not null default 1 check (quantity between 1 and 999),
  model            text check (model is null or length(model) <= 120),
  brand            text check (brand is null or length(brand) <= 120),
  certified        boolean not null,
  cert_ref         text check (cert_ref is null or length(cert_ref) <= 200),
  -- fecha de Argentina (UTC-3): current_date del servidor corre el dia a las 21:00 locales
  delivered_at     date not null default ((now() at time zone 'America/Argentina/Buenos_Aires')::date),
  worker_ack       text not null check (worker_ack in ('conforme','con_observaciones','no_firma')),
  observation      text check (observation is null or length(observation) <= 500),
  supersedes       uuid references public.epp_deliveries(id),
  created_by       uuid default auth.uid(),
  created_by_email text default coalesce(auth.jwt() ->> 'email', ''),
  created_at       timestamptz not null default now()
);
create index if not exists epp_deliveries_person_idx  on public.epp_deliveries (person_id, delivered_at desc);
create index if not exists epp_deliveries_device_idx  on public.epp_deliveries (device_id, created_at desc) where device_id is not null;
create index if not exists epp_deliveries_user_idx    on public.epp_deliveries (created_by, created_at desc);
-- Un registro se corrige una sola vez (la cadena sigue corrigiendo la correccion).
create unique index if not exists epp_deliveries_supersedes_uq on public.epp_deliveries (supersedes) where supersedes is not null;

create or replace function public.epp_deliveries_guard() returns trigger
language plpgsql security definer set search_path = '' as $fn$
declare
  u     uuid := auth.uid();
  r     text := public.jwt_role();
  today date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  prev  uuid;
begin
  if coalesce(r, '') not in ('viewer','admin') or u is null then
    raise exception 'epp_deliveries: rol no autorizado' using errcode = '42501';
  end if;
  new.created_by       := u;
  new.created_by_email := coalesce(auth.jwt() ->> 'email', '');
  new.created_at       := now();
  if new.delivered_at > today then
    raise exception 'epp_deliveries: la fecha de entrega no puede ser futura' using errcode = '22023';
  end if;
  if new.supersedes is not null then
    select e.person_id into prev from public.epp_deliveries e where e.id = new.supersedes;
    if not found then
      raise exception 'epp_deliveries: el registro a corregir no existe' using errcode = '22023';
    end if;
    if prev is distinct from new.person_id then
      raise exception 'epp_deliveries: la correccion debe ser de la misma persona' using errcode = '22023';
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('epp_deliveries:' || u::text, 0));
  if (select count(*) from public.epp_deliveries e
       where e.created_by = u and e.created_at > now() - interval '1 minute') >= 30 then
    raise exception 'rate limit: demasiadas constancias de EPP por minuto' using errcode = '54000';
  end if;
  return new;
end $fn$;
revoke all on function public.epp_deliveries_guard() from public, anon, authenticated;

drop trigger if exists epp_deliveries_guard_trg on public.epp_deliveries;
create trigger epp_deliveries_guard_trg before insert on public.epp_deliveries
  for each row execute function public.epp_deliveries_guard();

drop trigger if exists epp_deliveries_immutable_trg on public.epp_deliveries;
create trigger epp_deliveries_immutable_trg before update or delete on public.epp_deliveries
  for each row execute function public.immutable_row_guard();

alter table public.epp_deliveries enable row level security;
revoke all on public.epp_deliveries from anon;
revoke all on public.epp_deliveries from authenticated;
grant select on public.epp_deliveries to authenticated;
grant insert (person_id, device_id, item, quantity, model, brand, certified, cert_ref,
              delivered_at, worker_ack, observation, supersedes)
  on public.epp_deliveries to authenticated;
-- Sin UPDATE/DELETE.

drop policy if exists epp_select on public.epp_deliveries;
create policy epp_select on public.epp_deliveries
  for select to authenticated
  using (public.jwt_role() in ('viewer','admin','auditor'));

drop policy if exists epp_insert on public.epp_deliveries;
create policy epp_insert on public.epp_deliveries
  for insert to authenticated
  with check (public.jwt_role() in ('viewer','admin') and created_by = auth.uid());

-- ===========================================================================
-- 4. training_records + training_attendees  (constancia de capacitacion; Disp. GP 2/2022, DI-2021-2)
-- ===========================================================================
create table if not exists public.training_records (
  id               uuid primary key default gen_random_uuid(),
  held_at          timestamptz not null,
  topic            text not null check (length(btrim(topic)) between 1 and 200),
  trainer          text not null check (length(btrim(trainer)) between 1 and 120),
  modality_place   text check (modality_place is null or modality_place in ('presencial','virtual')),
  modality_sync    text check (modality_sync is null or modality_sync in ('sincronica','asincronica')),
  assisted         boolean not null,
  duration_min     integer check (duration_min is null or duration_min between 1 and 1440),
  supersedes       uuid references public.training_records(id),
  created_by       uuid default auth.uid(),
  created_by_email text default coalesce(auth.jwt() ->> 'email', ''),
  created_at       timestamptz not null default now()
);
create index if not exists training_records_held_idx on public.training_records (held_at desc);
create index if not exists training_records_user_idx on public.training_records (created_by, created_at desc);
create unique index if not exists training_records_supersedes_uq on public.training_records (supersedes) where supersedes is not null;

create table if not exists public.training_attendees (
  training_id uuid not null references public.training_records(id) on delete restrict,
  person_id   uuid not null references public.people(id),
  ack         text not null default 'conforme' check (ack in ('conforme','con_observaciones','no_firma')),
  observation text check (observation is null or length(observation) <= 500),
  primary key (training_id, person_id)
);
create index if not exists training_attendees_person_idx on public.training_attendees (person_id);

create or replace function public.training_records_guard() returns trigger
language plpgsql security definer set search_path = '' as $fn$
declare u uuid := auth.uid(); r text := public.jwt_role();
begin
  if coalesce(r, '') not in ('viewer','admin') or u is null then
    raise exception 'training_records: rol no autorizado' using errcode = '42501';
  end if;
  new.created_by       := u;
  new.created_by_email := coalesce(auth.jwt() ->> 'email', '');
  new.created_at       := now();
  perform pg_advisory_xact_lock(hashtextextended('training_records:' || u::text, 0));
  if (select count(*) from public.training_records t
       where t.created_by = u and t.created_at > now() - interval '1 minute') >= 10 then
    raise exception 'rate limit: demasiadas capacitaciones por minuto' using errcode = '54000';
  end if;
  return new;
end $fn$;
revoke all on function public.training_records_guard() from public, anon, authenticated;

drop trigger if exists training_records_guard_trg on public.training_records;
create trigger training_records_guard_trg before insert on public.training_records
  for each row execute function public.training_records_guard();

create or replace function public.training_attendees_guard() returns trigger
language plpgsql security definer set search_path = '' as $fn$
begin
  if coalesce(public.jwt_role(), '') not in ('viewer','admin') or auth.uid() is null then
    raise exception 'training_attendees: rol no autorizado' using errcode = '42501';
  end if;
  return new;
end $fn$;
revoke all on function public.training_attendees_guard() from public, anon, authenticated;

drop trigger if exists training_attendees_guard_trg on public.training_attendees;
create trigger training_attendees_guard_trg before insert on public.training_attendees
  for each row execute function public.training_attendees_guard();

drop trigger if exists training_records_immutable_trg on public.training_records;
create trigger training_records_immutable_trg before update or delete on public.training_records
  for each row execute function public.immutable_row_guard();
drop trigger if exists training_attendees_immutable_trg on public.training_attendees;
create trigger training_attendees_immutable_trg before update or delete on public.training_attendees
  for each row execute function public.immutable_row_guard();

alter table public.training_records enable row level security;
alter table public.training_attendees enable row level security;
revoke all on public.training_records from anon;
revoke all on public.training_records from authenticated;
revoke all on public.training_attendees from anon;
revoke all on public.training_attendees from authenticated;
grant select on public.training_records to authenticated;
grant select on public.training_attendees to authenticated;
-- Sin INSERT directo: el alta es atomica por create_training (record + asistentes). Sin UPDATE/DELETE.

drop policy if exists training_records_select on public.training_records;
create policy training_records_select on public.training_records
  for select to authenticated
  using (public.jwt_role() in ('viewer','admin','auditor'));

-- La tabla de asistentes la leen viewer/admin; el auditor lee training_attendees_audit (abajo).
drop policy if exists training_attendees_select on public.training_attendees;
create policy training_attendees_select on public.training_attendees
  for select to authenticated
  using (public.jwt_role() in ('viewer','admin'));

-- Vista del auditor: corre con los privilegios del dueno (como people_full); el filtro de rol esta en la vista.
-- La persona se muestra solo si el asistente NO dejo observacion (identidad reservada junto a la observacion).
create or replace view public.training_attendees_audit as
  select a.training_id,
         case when a.observation is null then a.person_id end as person_id,
         a.ack,
         a.observation
    from public.training_attendees a
   where public.jwt_role() = 'auditor';
revoke all on public.training_attendees_audit from anon;
revoke all on public.training_attendees_audit from authenticated;
grant select on public.training_attendees_audit to authenticated;

-- attendees: [{"person_id":"<uuid>","ack":"conforme|con_observaciones|no_firma","observation":"..."}, ...]
-- (ack por defecto 'conforme'; observation opcional). Devuelve el id de la capacitacion.
create or replace function public.create_training(
  held_at timestamptz, topic text, trainer text, modality_place text, modality_sync text,
  assisted boolean, duration_min integer, attendees jsonb, supersedes uuid default null)
returns uuid
language plpgsql security definer set search_path = '' as $fn$
declare
  u  uuid := auth.uid();
  r  text := public.jwt_role();
  n  integer;
  v_id uuid;
begin
  if coalesce(r, '') not in ('viewer','admin') or u is null then
    raise exception 'create_training: rol no autorizado' using errcode = '42501';
  end if;
  if create_training.attendees is null or jsonb_typeof(create_training.attendees) <> 'array' then
    raise exception 'create_training: attendees debe ser un arreglo' using errcode = '22023';
  end if;
  n := jsonb_array_length(create_training.attendees);
  if n < 1 or n > 200 then
    raise exception 'create_training: entre 1 y 200 asistentes (recibidos %)', n using errcode = '22023';
  end if;
  if create_training.held_at is null or create_training.held_at > now() + interval '1 day' then
    raise exception 'create_training: fecha invalida (no puede ser futura)' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(create_training.attendees) e
              where jsonb_typeof(e) <> 'object'
                 or coalesce(e ->> 'person_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 or coalesce(e ->> 'ack', 'conforme') not in ('conforme','con_observaciones','no_firma')
                 or length(coalesce(e ->> 'observation', '')) > 500) then
    raise exception 'create_training: asistente invalido (person_id, ack u observation)' using errcode = '22023';
  end if;
  if (select count(distinct (e ->> 'person_id')::uuid) from jsonb_array_elements(create_training.attendees) e) <> n then
    raise exception 'create_training: asistentes repetidos' using errcode = '22023';
  end if;
  if (select count(*) from public.people p
       where p.deleted_at is null
         and p.id in (select (e ->> 'person_id')::uuid from jsonb_array_elements(create_training.attendees) e)) <> n then
    raise exception 'create_training: hay asistentes inexistentes o dados de baja' using errcode = '22023';
  end if;
  if create_training.supersedes is not null
     and not exists (select 1 from public.training_records t where t.id = create_training.supersedes) then
    raise exception 'create_training: el registro a corregir no existe' using errcode = '22023';
  end if;

  insert into public.training_records(held_at, topic, trainer, modality_place, modality_sync, assisted, duration_min, supersedes)
  values (create_training.held_at, create_training.topic, create_training.trainer, create_training.modality_place,
          create_training.modality_sync, create_training.assisted, create_training.duration_min, create_training.supersedes)
  returning training_records.id into v_id;

  insert into public.training_attendees(training_id, person_id, ack, observation)
  select v_id, (e ->> 'person_id')::uuid, coalesce(e ->> 'ack', 'conforme'), nullif(e ->> 'observation', '')
    from jsonb_array_elements(create_training.attendees) e;

  return v_id;
end $fn$;
revoke all on function public.create_training(timestamptz, text, text, text, text, boolean, integer, jsonb, uuid)
  from public, anon;
grant execute on function public.create_training(timestamptz, text, text, text, text, boolean, integer, jsonb, uuid)
  to authenticated;

-- ===========================================================================
-- 5. access_log + rpc log_access  (auditoria de accesos)
-- ===========================================================================
create table if not exists public.access_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  user_id    uuid,
  user_email text,
  role       text,
  action     text not null
             check (action in ('view_live','record_start','record_stop','photo','export_csv','export_pdf','config_change',
                               'command','archive','delete_media','login','assist_open','assist_close','epp_create',
                               'training_create','hash_verify')),
  target     text check (target is null or length(target) <= 120),
  detail     jsonb not null default '{}'::jsonb
             check (jsonb_typeof(detail) = 'object' and octet_length(detail::text) <= 1024)
);
create index if not exists access_log_at_idx   on public.access_log (at desc);
create index if not exists access_log_user_idx on public.access_log (user_id, at desc);

drop trigger if exists access_log_immutable_trg on public.access_log;
create trigger access_log_immutable_trg before update or delete on public.access_log
  for each row execute function public.immutable_row_guard();

alter table public.access_log enable row level security;
revoke all on public.access_log from anon;
revoke all on public.access_log from authenticated;
grant select on public.access_log to authenticated;
-- Sin INSERT/UPDATE/DELETE directos: solo la rpc log_access (SECURITY DEFINER).

drop policy if exists access_log_select on public.access_log;
create policy access_log_select on public.access_log
  for select to authenticated
  using (public.jwt_role() in ('admin','auditor'));

create or replace function public.log_access(
  action text, target text default null, detail jsonb default '{}'::jsonb)
returns void
language plpgsql security definer set search_path = '' as $fn$
declare
  u uuid := auth.uid();
  r text := public.jwt_role();
  d jsonb := coalesce(log_access.detail, '{}'::jsonb);
begin
  if coalesce(r, '') not in ('viewer','admin','auditor') or u is null then
    raise exception 'log_access: rol no autorizado' using errcode = '42501';
  end if;
  if log_access.action is null or log_access.action not in
     ('view_live','record_start','record_stop','photo','export_csv','export_pdf','config_change','command','archive',
      'delete_media','login','assist_open','assist_close','epp_create','training_create','hash_verify') then
    raise exception 'log_access: accion invalida' using errcode = '22023';
  end if;
  if jsonb_typeof(d) <> 'object' then
    raise exception 'log_access: detail debe ser un objeto' using errcode = '22023';
  end if;
  if octet_length(d::text) > 1024 then   -- no se pierde el asiento: se marca como truncado
    d := jsonb_build_object('truncated', true, 'bytes', octet_length(d::text));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('access_log:' || u::text, 0));
  if (select count(*) from public.access_log l
       where l.user_id = u and l.at > now() - interval '1 minute') >= 120 then
    raise exception 'rate limit: demasiados registros de auditoria por minuto' using errcode = '54000';
  end if;
  insert into public.access_log(user_id, user_email, role, action, target, detail)
  values (u, coalesce(auth.jwt() ->> 'email', ''), r, log_access.action, left(log_access.target, 120), d);
end $fn$;
revoke all on function public.log_access(text, text, jsonb) from public, anon;
grant execute on function public.log_access(text, text, jsonb) to authenticated;

-- ===========================================================================
-- 6. org_settings  (datos del empleador; encabezado de las constancias)
-- ===========================================================================
create table if not exists public.org_settings (
  id               integer primary key check (id = 1),
  legal_name       text check (legal_name is null or length(legal_name) <= 200),
  cuit             text check (cuit is null or cuit ~ '^[0-9]{2}-?[0-9]{8}-?[0-9]$'),
  address          text check (address is null or length(address) <= 300),
  responsible_name text check (responsible_name is null or length(responsible_name) <= 120),
  responsible_role text check (responsible_role is null or length(responsible_role) <= 120),
  contact          text check (contact is null or length(contact) <= 200),
  updated_by       uuid,
  updated_at       timestamptz not null default now()
);

create or replace function public.org_settings_guard() returns trigger
language plpgsql security definer set search_path = '' as $fn$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $fn$;
revoke all on function public.org_settings_guard() from public, anon, authenticated;

drop trigger if exists org_settings_guard_trg on public.org_settings;
create trigger org_settings_guard_trg before insert or update on public.org_settings
  for each row execute function public.org_settings_guard();

drop trigger if exists aa_admin_only_trg on public.org_settings;
create trigger aa_admin_only_trg before insert or update on public.org_settings
  for each row execute function public.admin_only_guard();

alter table public.org_settings enable row level security;
revoke all on public.org_settings from anon;
revoke all on public.org_settings from authenticated;
grant select on public.org_settings to authenticated;
grant insert (id, legal_name, cuit, address, responsible_name, responsible_role, contact)
  on public.org_settings to authenticated;
grant update (legal_name, cuit, address, responsible_name, responsible_role, contact)
  on public.org_settings to authenticated;
-- Sin DELETE.

drop policy if exists org_select on public.org_settings;
create policy org_select on public.org_settings
  for select to authenticated
  using (public.jwt_role() in ('viewer','admin','auditor'));

drop policy if exists org_insert_admin on public.org_settings;
create policy org_insert_admin on public.org_settings
  for insert to authenticated
  with check (public.jwt_role() = 'admin');

drop policy if exists org_update_admin on public.org_settings;
create policy org_update_admin on public.org_settings
  for update to authenticated
  using (public.jwt_role() = 'admin')
  with check (public.jwt_role() = 'admin');

-- ===========================================================================
-- 7. Retencion (Ley 25.326): casco_purge de 010 + access_log 1 ano
-- ===========================================================================
-- assist_sessions, epp_deliveries y training_* NO se purgan (constancias: respaldo legal; ver notas del protocolo).
create or replace function public.casco_purge() returns void
language plpgsql security definer set search_path = '' as $fn$
begin
  delete from public.events        where type = 'heartbeat' and created_at < now() - interval '7 days';
  delete from public.events        where type = 'location'  and created_at < now() - interval '30 days';
  delete from public.events        where type in ('geofence','equip','fall_cancel') and created_at < now() - interval '90 days';
  -- sos/fall/photo/video/not_worn/inactive: 1 ano (la cascada se lleva event_acks y escalations: no acortar)
  delete from public.events        where type in ('sos','fall','photo','video','not_worn','inactive')
                                     and created_at < now() - interval '365 days';
  delete from public.rtc_signals   where created_at < now() - interval '1 day';
  delete from public.stream_commands where created_at < now() - interval '7 days';
  delete from public.device_commands where created_at < now() - interval '7 days';  -- cascada: device_command_acks
  delete from public.broadcasts    where created_at < now() - interval '90 days';
  delete from public.geofences     where deleted_at < now() - interval '90 days';
  delete from public.geo_points    where deleted_at < now() - interval '90 days';
  delete from public.access_log    where at < now() - interval '365 days';
end $fn$;
revoke all on function public.casco_purge() from public, anon, authenticated;

-- ===========================================================================
-- 8. Tiempo real: solo assist_sessions (idempotente; respeta RLS)
-- ===========================================================================
do $do$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime'
                   and schemaname = 'public' and tablename = 'assist_sessions') then
    alter publication supabase_realtime add table public.assist_sessions;
  end if;
end $do$;

-- Verificacion rapida de 010, 011 y 013 (tablas, vista, triggers admin-only, publicacion realtime)
select
  (select count(*) from pg_tables where schemaname='public'
     and tablename in ('device_commands','device_command_acks','device_config','event_archive')) as tanda4_5_tablas_esperado_4,
  (select count(*) from pg_views where schemaname='public' and viewname = 'incident_report') as vista_esperado_1,
  (select count(*) from pg_trigger where tgname = 'aa_admin_only_trg' and not tgisinternal) as triggers_admin_esperado_7,
  (select count(*) from pg_publication_tables where pubname='supabase_realtime' and schemaname='public'
     and tablename in ('device_commands','device_command_acks','device_config','event_archive')) as realtime_esperado_4,
  (select count(*) from pg_tables where schemaname='public'
     and tablename in ('assist_sessions','epp_deliveries','training_records','training_attendees','access_log','org_settings')) as tanda_c_tablas_esperado_6,
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
     and proname in ('log_access','create_training','immutable_row_guard')) as tanda_c_funciones_esperado_3,
  (select count(*) from pg_publication_tables where pubname='supabase_realtime' and schemaname='public'
     and tablename = 'assist_sessions') as tanda_c_realtime_esperado_1;
