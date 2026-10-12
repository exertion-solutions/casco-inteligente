-- Un SOS / caida nunca se pierde por un error administrativo: un casco dado de baja sigue pudiendo
-- mandar sos y fall (el resto de sus eventos si se rechaza). Ver out/review-externa.md punto 7.
-- Idempotente. Ejecutar en Supabase > SQL Editor (despues de 008).
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
