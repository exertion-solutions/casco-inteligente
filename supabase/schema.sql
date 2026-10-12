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
