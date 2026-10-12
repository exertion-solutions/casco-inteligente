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
-- (aa_admin_only_trg, se dispara antes que los guards 006/007 por orden alfabetico) rechaza a todo el que no sea admin
-- (o una sesion sin JWT = SQL Editor/service_role). Si alguien vuelve a ejecutar 005/006/007 sueltas, las policies
-- viejas de viewer reaparecen pero el trigger sigue bloqueando; volve a correr esta migracion para limpiarlas.

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
-- Trigger generico. Permite admin o sesion sin JWT (SQL Editor / service_role, igual que los guards 006/007).
create or replace function public.admin_only_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r text := public.jwt_role(); u uuid := auth.uid();
begin
  if r = 'admin' or (r is null and u is null) then
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
     and not (public.jwt_role() is null and auth.uid() is null) then
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
