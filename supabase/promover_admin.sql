-- Promover al propietario a rol admin (Tanda 4, docs/PROTOCOLO-COMANDOS.md seccion 5).
-- Ejecutar a mano en Supabase > SQL Editor, DESPUES de migrations/010_comandos_config_roles.sql.
-- El rol vive en app_metadata (el usuario no lo puede editar). Tras correrlo: cerrar sesion y volver a entrar.
-- Idempotente: se puede repetir. Si "select" devuelve 0 filas, el email no existe en Authentication > Users.

update auth.users
   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}'::jsonb
 where email = 'jorge_e_castro@hotmail.com';

select email, raw_app_meta_data from auth.users where email = 'jorge_e_castro@hotmail.com';
