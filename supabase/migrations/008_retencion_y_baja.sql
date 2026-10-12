-- Retencion de datos (Ley 25.326), indice de alertas y corte de acceso de cascos dados de baja.
-- Ver out/audit-supabase.md R1-R3. Idempotente. Ejecutar en Supabase > SQL Editor (despues de 007).

create extension if not exists pg_cron;

create index if not exists events_alerts_idx on public.events (created_at desc)
  where type in ('sos','fall','geofence');

create or replace function public.casco_purge() returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.events        where type = 'heartbeat' and created_at < now() - interval '7 days';
  delete from public.events        where type = 'location'  and created_at < now() - interval '30 days';
  delete from public.events        where type = 'geofence'  and created_at < now() - interval '90 days';
  -- sos/fall/photo/video: 1 ano (la cascada se lleva event_acks y escalations: no acortar)
  delete from public.events        where type in ('sos','fall','photo','video') and created_at < now() - interval '365 days';
  delete from public.rtc_signals   where created_at < now() - interval '1 day';
  delete from public.stream_commands where created_at < now() - interval '7 days';
  delete from public.broadcasts    where created_at < now() - interval '90 days';
  delete from public.geofences     where deleted_at < now() - interval '90 days';
  delete from public.geo_points    where deleted_at < now() - interval '90 days';
end $$;
revoke all on function public.casco_purge() from public, anon, authenticated;

select cron.unschedule('casco-purge') where exists (select 1 from cron.job where jobname = 'casco-purge');
select cron.schedule('casco-purge', '10 3 * * *', $$select public.casco_purge()$$);

-- Un casco dado de baja (status='baja' o deleted_at) deja de insertar eventos aunque su JWT siga vigente.
create or replace function public.device_is_active(p text) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.devices d
                      where d.device_id = p and (d.deleted_at is not null or d.status = 'baja'))
$$;
revoke all on function public.device_is_active(text) from public, anon;
grant execute on function public.device_is_active(text) to authenticated;

drop policy if exists events_insert_device on public.events;
create policy events_insert_device on public.events
  for insert to authenticated
  with check (
    public.jwt_role() = 'device'
    and public.jwt_device_id() is not null
    and device_id = public.jwt_device_id()
    and (media_path is null or split_part(media_path, '/', 1) = device_id)
    and public.device_is_active(device_id)
  );
