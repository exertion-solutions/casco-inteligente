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
