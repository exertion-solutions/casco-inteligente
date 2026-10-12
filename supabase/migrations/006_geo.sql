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
      check (type in ('sos','photo','video','heartbeat','fall','location','geofence')) not valid;
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
