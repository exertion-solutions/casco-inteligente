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
