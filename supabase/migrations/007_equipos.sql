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
