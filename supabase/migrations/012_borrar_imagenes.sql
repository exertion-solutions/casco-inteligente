-- Borrar imagenes desde el visor (decision del usuario): solo admin. Idempotente. Ejecutar despues de 011.
--
-- Flujo del visor (JWT del admin): 1) sb.storage.from('casco-media').remove([path])  2) insert en event_archive
-- (event_id, reason 'Imagen eliminada'). Esta migracion solo agrega el permiso de borrado en Storage.
--   * DELETE en storage.objects: bucket 'casco-media', role admin, ruta <device_id>/<photo|video>/<archivo>
--     (device_id valido, sin '..'). viewer, device y anon NO borran. SELECT (viewer/admin) e INSERT (device) no cambian.
--   * Sigue sin policy de UPDATE: nadie sobrescribe (x-upsert falla).
--   * event_archive (011) ya acepta photo y video: son informativos (no estan en la lista de alertas pendientes del trigger),
--     asi que se archivan sin event_acks; reason admite hasta 200 caracteres. No hay cambios en 011.
--   * El evento en events NO se modifica (inmutable): la baja de la imagen queda en event_archive (archived_at, reason).
--     El evento conserva media_path apuntando a un archivo que ya no existe; el visor debe tratarlo como "imagen eliminada".

drop policy if exists media_delete_none  on storage.objects;
drop policy if exists media_delete_admin on storage.objects;
create policy media_delete_admin on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'casco-media'
    and public.jwt_role() = 'admin'
    and array_length(storage.foldername(name), 1) = 2
    and (storage.foldername(name))[1] ~ '^[A-Za-z0-9_-]{1,64}$'
    and (storage.foldername(name))[2] in ('photo','video')
    and name !~ '\.\.'
  );
