-- Casco Inteligente: esquema Supabase
-- Ejecutar completo en: Supabase > SQL Editor.
-- Roles via app_metadata.role: 'device' (casco), 'viewer' (supervisor), 'admin'.

create extension if not exists pgcrypto;

create table if not exists public.events (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  device_id   text not null,
  type        text not null check (type in ('sos','photo','video','heartbeat')),
  key_code    text,
  press_ms    integer,
  media_path  text,
  lat         double precision,
  lng         double precision,
  battery     integer,
  payload     jsonb not null default '{}'::jsonb
);

create index if not exists events_created_idx on public.events (created_at desc);
create index if not exists events_device_idx  on public.events (device_id, created_at desc);

alter table public.events enable row level security;

-- El casco solo inserta; los supervisores solo leen.
drop policy if exists events_insert_device on public.events;
create policy events_insert_device on public.events
  for insert to authenticated
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'device');

drop policy if exists events_select_viewer on public.events;
create policy events_select_viewer on public.events
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') in ('viewer','admin'));

-- Bucket privado para fotos/videos
insert into storage.buckets (id, name, public)
values ('casco-media', 'casco-media', false)
on conflict (id) do nothing;

drop policy if exists media_insert_device on storage.objects;
create policy media_insert_device on storage.objects
  for insert to authenticated
  with check (bucket_id = 'casco-media'
              and (auth.jwt() -> 'app_metadata' ->> 'role') = 'device');

drop policy if exists media_select_viewer on storage.objects;
create policy media_select_viewer on storage.objects
  for select to authenticated
  using (bucket_id = 'casco-media'
         and (auth.jwt() -> 'app_metadata' ->> 'role') in ('viewer','admin'));

-- Tiempo real para el visor
alter publication supabase_realtime add table public.events;

-- Asignar roles (reemplazar los emails tras crear los usuarios en Authentication > Users):
-- update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data,'{}'::jsonb) || '{"role":"device"}'
--   where email = 'casco-4132@tudominio.com';
-- update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data,'{}'::jsonb) || '{"role":"viewer"}'
--   where email = 'supervisor@tudominio.com';
