-- EJEMPLO de alta de equipos y personas. TODOS los valores son INVENTADOS (el repo es publico).
-- Para cargar los datos reales: copiar este archivo FUERA del repo (o a un archivo ignorado por git,
-- por ejemplo supabase/seed/equipos.local.sql), reemplazar los valores y correrlo en SQL Editor.
-- NUNCA subir IMEI, ICCID, DNI, telefonos ni nombres reales al repositorio.
--
-- Requiere haber corrido supabase/migrations/007_equipos.sql.
-- Por que el set_config del principio: las tablas solo aceptan altas de un usuario con rol
-- (viewer/admin) y fijan "created_by" desde su JWT. El SQL Editor no tiene JWT, asi que se simula
-- el de tu usuario admin dentro de la transaccion. Cambia el email por el de tu supervisor/admin
-- (el que tiene role admin en app_metadata; hace falta admin para cargar dni y telefono).

begin;

select set_config('request.jwt.claims',
  json_build_object(
    'role', 'authenticated',
    'sub',  (select id from auth.users where email = 'supervisor@tudominio.com'),
    'email', 'supervisor@tudominio.com',
    'app_metadata', json_build_object('role', 'admin')
  )::text, true);

-- Grupos (ej. una locacion o un equipo de trabajo)
insert into public.groups (id, name, site, notes) values
  ('11111111-1111-4111-8111-111111111111', 'Cuadrilla de ejemplo', 'Locacion Ejemplo', 'Dato de ejemplo');

-- Cascos. device_id = el "device_id" del config del casco = app_metadata.device_id del usuario del casco.
--   imei: 15 digitos (marcar *#06# en el casco o ver la caja). ICCID: los 19-20 digitos impresos en la SIM.
--   sim_line: numero de la linea. bt_headset_mac: MAC del auricular Bluetooth (AA:BB:CC:DD:EE:FF).
insert into public.devices
  (device_id, imei, name, model, group_id, sector, sim1_iccid, sim2_iccid, sim_line, bt_headset_mac, status, notes)
values
  ('4132', '86665202XXXXXXX', 'Casco de ejemplo 1', 'rd_aqm6816', '11111111-1111-4111-8111-111111111111',
   'Sector de ejemplo', '8954000000000000XXXX', '8954000000000001XXXX', '+54911XXXXXXXX',
   'AA:BB:CC:DD:EE:01', 'activo', 'Dato de ejemplo'),
  ('4133', '86665202XXXXXXY', 'Casco de ejemplo 2', 'rd_aqm6816', '11111111-1111-4111-8111-111111111111',
   'Sector de ejemplo', null, null, null, null, 'mantenimiento', null);

-- Personas. dni y contact_phone solo los puede cargar/ver un admin.
insert into public.people (id, full_name, legajo, dni, job_title, sector, contact_phone, group_id) values
  ('22222222-2222-4222-8222-222222222221', 'Persona de Ejemplo Uno',  'L-0001', '00000001', 'Operador',
   'Sector de ejemplo', '+54911XXXXXXXX', '11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222', 'Persona de Ejemplo Dos',  'L-0002', '00000002', 'Supervisor',
   'Sector de ejemplo', null, '11111111-1111-4111-8111-111111111111');

-- Asignacion casco <-> persona (abrir una nueva cierra sola la anterior del casco y de la persona).
insert into public.assignments (device_id, person_id) values
  ('4132', '22222222-2222-4222-8222-222222222221');

commit;

-- Para ver el resultado (como admin, las vistas completas):
--   select * from public.devices_full;   select * from public.people_full;
--   select * from public.assignments where ends_at is null;
-- Nota: con los valores "XXXX" de este ejemplo el IMEI/ICCID no pasan la validacion (solo digitos): a
-- proposito, para que no se pueda correr sin reemplazarlos por los reales.
