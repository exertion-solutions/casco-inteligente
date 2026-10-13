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
