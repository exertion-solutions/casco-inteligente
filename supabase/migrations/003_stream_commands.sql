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
