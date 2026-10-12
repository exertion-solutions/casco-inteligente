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
