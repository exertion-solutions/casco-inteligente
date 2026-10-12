-- Pruebas de RLS / Storage para Casco Inteligente.
-- USO: Supabase > SQL Editor > pegar TODO > Run. Es solo lectura neta: cada caso corre
-- en una subtransaccion que se revierte (no deja filas ni objetos).
-- Resultado: una tabla con columnas test | expected | got | ok. TODAS deben ser ok = true.
-- Requiere haber ejecutado antes supabase/schema.sql y migrations/002, 003, 004, 005, 006 y 007.
--
-- Como simula identidades: fija request.jwt.claims (lo que lee auth.jwt()) y hace
-- SET LOCAL ROLE anon|authenticated, igual que PostgREST/Storage.
-- 'ALLOWED' = la sentencia termino sin error y afecto >=1 fila (o fue un DO sin error).
-- 'DENIED'  = error de permiso/RLS/constraint/trigger, o 0 filas visibles/afectadas.

create or replace function pg_temp.t(
  p_name text, p_expect text, p_role text, p_claims text, p_sql text, p_setup text default null)
returns table(test text, expected text, got text, ok boolean)
language plpgsql as $$
declare r text; n bigint;
begin
  begin
    if p_setup is not null then execute p_setup; end if;      -- como postgres
    perform set_config('request.jwt.claims', p_claims, true);
    execute format('set local role %I', p_role);
    execute p_sql;
    get diagnostics n = row_count;
    r := case when n = 0 and p_sql !~* '^\s*do\M' then 'DENIED' else 'ALLOWED' end;
    raise exception using message = '__rollback__';            -- revierte todo
  exception when others then
    if sqlerrm <> '__rollback__' then r := 'DENIED'; end if;
  end;
  return query select p_name, p_expect, r, (r = p_expect);
end $$;

with c as (select
  '{"role":"anon"}'::text as anon,
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000001"}'::text as norole,
  -- user_metadata es editable por el usuario: NO debe dar permisos
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000002","user_metadata":{"role":"device","device_id":"4132"}}'::text as usermeta,
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000003","app_metadata":{"role":"device","device_id":"4132"}}'::text as dev,
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000004","app_metadata":{"role":"device"}}'::text as dev_noid,
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000005","app_metadata":{"role":"viewer"}}'::text as viewer,
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000006","app_metadata":{"role":"admin"}}'::text as admin,
  $s$insert into public.events(device_id,type) values ('4132','sos'),('9999','sos')$s$ as seed_ev,
  $s$insert into storage.objects(bucket_id,name) values ('casco-media','4132/photo/seed.jpg')$s$ as seed_obj,
  -- stream_commands: el trigger fuerza created_at=now(); para "vencido" se envejece con UPDATE (como postgres).
  $s$insert into public.stream_commands(device_id,action,requested_by) values ('4132','start','00000000-0000-0000-0000-000000000009')$s$ as seed_cmd,
  $s$insert into public.stream_commands(device_id,action,requested_by) values ('9999','start','00000000-0000-0000-0000-000000000009')$s$ as seed_cmd_other,
  $s$do $d$ begin
       insert into public.stream_commands(device_id,action,requested_by) values ('4132','start','00000000-0000-0000-0000-000000000009');
       update public.stream_commands set created_at = now() - interval '5 minutes';
     end $d$$s$ as seed_cmd_old,
  -- rtc_signals: el trigger exige un rol en el JWT, asi que el seed fija claims de viewer/device
  -- (el helper vuelve a fijar los claims del caso despues del setup). 'old' envejece las
  -- filas con UPDATE (como postgres).
  $s$do $d$ begin
       perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000009","app_metadata":{"role":"viewer"}}',true);
       insert into public.rtc_signals(device_id,call_id,kind) values
         ('4132','aaaaaaaa-0000-0000-0000-000000000001','offer'),
         ('9999','aaaaaaaa-0000-0000-0000-000000000002','offer');
       perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000008","app_metadata":{"role":"device","device_id":"4132"}}',true);
       insert into public.rtc_signals(device_id,call_id,kind) values
         ('4132','aaaaaaaa-0000-0000-0000-000000000001','answer');
     end $d$$s$ as seed_rtc,
  $s$do $d$ begin
       perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000009","app_metadata":{"role":"viewer"}}',true);
       insert into public.rtc_signals(device_id,call_id,kind) values ('4132','aaaaaaaa-0000-0000-0000-000000000003','offer');
       update public.rtc_signals set created_at = now() - interval '5 minutes';
     end $d$$s$ as seed_rtc_old,
  -- Centro de mando (migracion 005). Ids fijos: regla e1 (la por defecto), evento eeee..01,
  -- ordenes cccc..01 (a todos), ..02 (a 4132), ..03 (a 9999), ..04 (a todos, vencida).
  $s$insert into public.escalation_rules(id) values ('00000000-0000-4000-8000-0000000000e1') on conflict (id) do nothing$s$ as seed_rule,
  $s$do $d$ begin
       insert into public.escalation_rules(id) values ('00000000-0000-4000-8000-0000000000e1') on conflict (id) do nothing;
       insert into public.events(id,device_id,type) values ('eeeeeeee-0000-0000-0000-000000000001','4132','sos') on conflict (id) do nothing;
     end $d$$s$ as seed_esc_ev,
  $s$do $d$ begin
       insert into public.escalation_rules(id) values ('00000000-0000-4000-8000-0000000000e1') on conflict (id) do nothing;
       insert into public.events(id,device_id,type) values ('eeeeeeee-0000-0000-0000-000000000001','4132','sos') on conflict (id) do nothing;
       insert into public.escalations(event_id,rule_id,ok,detail)
         values ('eeeeeeee-0000-0000-0000-000000000001','00000000-0000-4000-8000-0000000000e1',true,'HTTP 200');
     end $d$$s$ as seed_esc,
  -- broadcasts: el trigger exige rol viewer/admin en el JWT, asi que el seed fija claims de viewer.
  $s$do $d$ begin
       perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000009","email":"seed@test.local","app_metadata":{"role":"viewer"}}',true);
       insert into public.broadcasts(id,kind,message,device_ids) values
         ('cccccccc-0000-0000-0000-000000000001','mensaje','a todos',null),
         ('cccccccc-0000-0000-0000-000000000002','mensaje','a 4132','{4132}'),
         ('cccccccc-0000-0000-0000-000000000003','mensaje','a 9999','{9999}');
     end $d$$s$ as seed_bc,
  $s$do $d$ begin
       perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000009","email":"seed@test.local","app_metadata":{"role":"viewer"}}',true);
       insert into public.broadcasts(id,kind,message,device_ids) values
         ('cccccccc-0000-0000-0000-000000000003','mensaje','a 9999','{9999}'),
         ('cccccccc-0000-0000-0000-000000000004','mensaje','vencida',null);
       update public.broadcasts set created_at = now() - interval '5 minutes'
         where id = 'cccccccc-0000-0000-0000-000000000004';
     end $d$$s$ as seed_bc_old,
  $s$do $d$ begin
       perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000009","email":"seed@test.local","app_metadata":{"role":"viewer"}}',true);
       insert into public.broadcasts(id,kind,message,device_ids) values
         ('cccccccc-0000-0000-0000-000000000001','mensaje','a todos',null);
       insert into public.broadcast_acks(broadcast_id,device_id)
         values ('cccccccc-0000-0000-0000-000000000001','4132');
     end $d$$s$ as seed_ack
  ,
  -- Mapa (migracion 006). Geocercas 99999999..01 global activa, ..02 solo 4132, ..03 solo 9999,
  -- ..04 global inactiva, ..05 global dada de baja. Puntos dddddddd..01 peligro activo, ..02 extintor,
  -- ..03 peligro inactivo, ..04 peligro dado de baja. Los inserta un viewer (el trigger lo exige).
  $s$do $d$ begin
       perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000009","app_metadata":{"role":"viewer"}}',true);
       insert into public.geofences(id,name,kind,shape,geometry,device_ids,active) values
         ('99999999-0000-0000-0000-000000000001','global','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}',null,true),
         ('99999999-0000-0000-0000-000000000002','solo 4132','permitida','polygon','{"points":[[-34.60,-58.40],[-34.61,-58.40],[-34.61,-58.41]]}','{4132}',true),
         ('99999999-0000-0000-0000-000000000003','solo 9999','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}','{9999}',true),
         ('99999999-0000-0000-0000-000000000004','inactiva','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}',null,false),
         ('99999999-0000-0000-0000-000000000005','de baja','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}',null,true);
       update public.geofences set deleted_at = now() where id = '99999999-0000-0000-0000-000000000005';
     end $d$$s$ as seed_gf,
  $s$do $d$ begin
       perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000009","app_metadata":{"role":"viewer"}}',true);
       insert into public.geo_points(id,name,category,lat,lng,active) values
         ('dddddddd-0000-0000-0000-000000000001','valvula','peligro',-34.6,-58.4,true),
         ('dddddddd-0000-0000-0000-000000000002','extintor 1','extintor',-34.6,-58.4,true),
         ('dddddddd-0000-0000-0000-000000000003','pozo','peligro',-34.6,-58.4,false),
         ('dddddddd-0000-0000-0000-000000000004','viejo','peligro',-34.6,-58.4,true);
       update public.geo_points set deleted_at = now() where id = 'dddddddd-0000-0000-0000-000000000004';
     end $d$$s$ as seed_gp
  ,
  -- Equipos (migracion 007). grupo a1a1..01; cascos 4132 (con imei/SIM, asignado a Persona Uno),
  -- 9999 (libre), 7777 (baja); personas b2b2..01 (con dni/telefono), ..02, ..03 (inactiva).
  -- Los carga un admin (el trigger exige rol y solo admin escribe dni/telefono).
  $s$do $d$ begin
       perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000009","app_metadata":{"role":"admin"}}',true);
       insert into public.groups(id,name) values ('a1a1a1a1-0000-0000-0000-000000000001','Grupo A');
       insert into public.devices(device_id,imei,name,group_id,sim1_iccid,sim_line) values
         ('4132','866652020000001','Casco 4132','a1a1a1a1-0000-0000-0000-000000000001','8954000000000000001','+5491100000001'),
         ('9999','866652020000002','Casco 9999',null,null,null);
       insert into public.devices(device_id,name,status) values ('7777','Casco 7777','baja');
       insert into public.people(id,full_name,legajo,dni,job_title,sector,contact_phone,group_id) values
         ('b2b2b2b2-0000-0000-0000-000000000001','Persona Uno','L001','12345678','Operador','Sector 1','+5491100000000','a1a1a1a1-0000-0000-0000-000000000001'),
         ('b2b2b2b2-0000-0000-0000-000000000002','Persona Dos','L002',null,null,null,null,null);
       insert into public.people(id,full_name,active) values ('b2b2b2b2-0000-0000-0000-000000000003','Persona Inactiva',false);
       insert into public.assignments(device_id,person_id) values ('4132','b2b2b2b2-0000-0000-0000-000000000001');
     end $d$$s$ as seed_eq,
  $s$do $d$ begin
       perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000009","app_metadata":{"role":"admin"}}',true);
       insert into public.groups(id,name) values ('a1a1a1a1-0000-0000-0000-000000000001','Grupo A');
       insert into public.devices(device_id,imei,name,group_id,sim1_iccid,sim_line) values
         ('4132','866652020000001','Casco 4132','a1a1a1a1-0000-0000-0000-000000000001','8954000000000000001','+5491100000001'),
         ('9999','866652020000002','Casco 9999',null,null,null);
       insert into public.devices(device_id,name,status) values ('7777','Casco 7777','baja');
       insert into public.people(id,full_name,legajo,dni,job_title,sector,contact_phone,group_id) values
         ('b2b2b2b2-0000-0000-0000-000000000001','Persona Uno','L001','12345678','Operador','Sector 1','+5491100000000','a1a1a1a1-0000-0000-0000-000000000001'),
         ('b2b2b2b2-0000-0000-0000-000000000002','Persona Dos','L002',null,null,null,null,null);
       insert into public.people(id,full_name,active) values ('b2b2b2b2-0000-0000-0000-000000000003','Persona Inactiva',false);
       insert into public.assignments(device_id,person_id) values ('4132','b2b2b2b2-0000-0000-0000-000000000001');
       update public.assignments set ends_at = now();
     end $d$$s$ as seed_eq_closed
)
select r.* from c, lateral (
  -- ===================== anon (solo anon key) =====================
            select * from pg_temp.t('anon: SELECT events',               'DENIED',  'anon', c.anon, 'select * from public.events', c.seed_ev)
  union all select * from pg_temp.t('anon: INSERT events',               'DENIED',  'anon', c.anon, $q$insert into public.events(device_id,type) values ('4132','sos')$q$)
  union all select * from pg_temp.t('anon: SELECT storage.objects',      'DENIED',  'anon', c.anon, 'select * from storage.objects', c.seed_obj)
  union all select * from pg_temp.t('anon: INSERT storage.objects',      'DENIED',  'anon', c.anon, $q$insert into storage.objects(bucket_id,name) values ('casco-media','4132/photo/a.jpg')$q$)
  -- ============ authenticated sin rol / con user_metadata falso ============
  union all select * from pg_temp.t('sin rol: SELECT events',            'DENIED',  'authenticated', c.norole, 'select * from public.events', c.seed_ev)
  union all select * from pg_temp.t('sin rol: INSERT events',            'DENIED',  'authenticated', c.norole, $q$insert into public.events(device_id,type) values ('4132','sos')$q$)
  union all select * from pg_temp.t('sin rol: SELECT storage',           'DENIED',  'authenticated', c.norole, 'select * from storage.objects', c.seed_obj)
  union all select * from pg_temp.t('sin rol: INSERT storage',           'DENIED',  'authenticated', c.norole, $q$insert into storage.objects(bucket_id,name) values ('casco-media','4132/photo/a.jpg')$q$)
  union all select * from pg_temp.t('user_metadata falso: INSERT events','DENIED',  'authenticated', c.usermeta, $q$insert into public.events(device_id,type) values ('4132','sos')$q$)
  union all select * from pg_temp.t('user_metadata falso: INSERT storage','DENIED', 'authenticated', c.usermeta, $q$insert into storage.objects(bucket_id,name) values ('casco-media','4132/photo/a.jpg')$q$)
  -- ============================ device ============================
  union all select * from pg_temp.t('device: INSERT sos propio',         'ALLOWED', 'authenticated', c.dev, $q$insert into public.events(device_id,type,key_code,press_ms,battery) values ('4132','sos','KEY_F11',1500,80)$q$)
  union all select * from pg_temp.t('device: INSERT device_id ajeno',    'DENIED',  'authenticated', c.dev, $q$insert into public.events(device_id,type) values ('9999','sos')$q$)
  union all select * from pg_temp.t('device: INSERT media_path propio',  'ALLOWED', 'authenticated', c.dev, $q$insert into public.events(device_id,type,media_path) values ('4132','photo','4132/photo/1_a.jpg')$q$)
  union all select * from pg_temp.t('device: INSERT media_path ajeno',   'DENIED',  'authenticated', c.dev, $q$insert into public.events(device_id,type,media_path) values ('4132','photo','9999/photo/1_a.jpg')$q$)
  union all select * from pg_temp.t('device: media_path con ..',         'DENIED',  'authenticated', c.dev, $q$insert into public.events(device_id,type,media_path) values ('4132','photo','4132/photo/../../9999/photo/a.jpg')$q$)
  union all select * from pg_temp.t('device: type invalido',             'DENIED',  'authenticated', c.dev, $q$insert into public.events(device_id,type) values ('4132','admin_cmd')$q$)
  union all select * from pg_temp.t('device: device_id con HTML',        'DENIED',  'authenticated', c.dev, $q$insert into public.events(device_id,type) values ('<img src=x onerror=1>','sos')$q$)
  union all select * from pg_temp.t('device: payload > 2 KB',            'DENIED',  'authenticated', c.dev, $q$insert into public.events(device_id,type,payload) values ('4132','sos', jsonb_build_object('x', repeat('a',3000)))$q$)
  union all select * from pg_temp.t('device: battery fuera de rango',    'DENIED',  'authenticated', c.dev, $q$insert into public.events(device_id,type,battery) values ('4132','heartbeat',500)$q$)
  union all select * from pg_temp.t('device: SELECT events (no lee)',    'DENIED',  'authenticated', c.dev, 'select * from public.events', c.seed_ev)
  union all select * from pg_temp.t('device: UPDATE events',             'DENIED',  'authenticated', c.dev, $q$update public.events set type='fall' where device_id='4132'$q$, c.seed_ev)
  union all select * from pg_temp.t('device: DELETE events',             'DENIED',  'authenticated', c.dev, $q$delete from public.events where device_id='4132'$q$, c.seed_ev)
  union all select * from pg_temp.t('device sin claim device_id: INSERT','DENIED',  'authenticated', c.dev_noid, $q$insert into public.events(device_id,type) values ('4132','sos')$q$)
  union all select * from pg_temp.t('device: 30 heartbeats/min',         'ALLOWED', 'authenticated', c.dev, $q$do $b$ begin for i in 1..30 loop insert into public.events(device_id,type) values ('4132','heartbeat'); end loop; end $b$$q$)
  union all select * from pg_temp.t('device: 31 heartbeats/min (DoS)',   'DENIED',  'authenticated', c.dev, $q$do $b$ begin for i in 1..31 loop insert into public.events(device_id,type) values ('4132','heartbeat'); end loop; end $b$$q$)
  -- ---- storage como device ----
  union all select * from pg_temp.t('device: subir a su carpeta photo',  'ALLOWED', 'authenticated', c.dev, $q$insert into storage.objects(bucket_id,name) values ('casco-media','4132/photo/1_a.jpg')$q$)
  union all select * from pg_temp.t('device: subir a su carpeta video',  'ALLOWED', 'authenticated', c.dev, $q$insert into storage.objects(bucket_id,name) values ('casco-media','4132/video/1_a.mp4')$q$)
  union all select * from pg_temp.t('device: subir a carpeta ajena',     'DENIED',  'authenticated', c.dev, $q$insert into storage.objects(bucket_id,name) values ('casco-media','9999/photo/1_a.jpg')$q$)
  union all select * from pg_temp.t('device: subir a la raiz',           'DENIED',  'authenticated', c.dev, $q$insert into storage.objects(bucket_id,name) values ('casco-media','a.jpg')$q$)
  union all select * from pg_temp.t('device: subcarpeta no permitida',   'DENIED',  'authenticated', c.dev, $q$insert into storage.objects(bucket_id,name) values ('casco-media','4132/docs/a.jpg')$q$)
  union all select * from pg_temp.t('device: path traversal ..',         'DENIED',  'authenticated', c.dev, $q$insert into storage.objects(bucket_id,name) values ('casco-media','4132/photo/../x.jpg')$q$)
  union all select * from pg_temp.t('device sin claim: subir',           'DENIED',  'authenticated', c.dev_noid, $q$insert into storage.objects(bucket_id,name) values ('casco-media','4132/photo/1_a.jpg')$q$)
  union all select * from pg_temp.t('device: listar bucket (SELECT)',    'DENIED',  'authenticated', c.dev, 'select * from storage.objects', c.seed_obj)
  union all select * from pg_temp.t('device: sobrescribir (UPDATE)',     'DENIED',  'authenticated', c.dev, $q$update storage.objects set name='4132/photo/seed2.jpg' where name='4132/photo/seed.jpg'$q$, c.seed_obj)
  union all select * from pg_temp.t('device: borrar objeto (DELETE)',    'DENIED',  'authenticated', c.dev, $q$delete from storage.objects where name='4132/photo/seed.jpg'$q$, c.seed_obj)
  -- ========================== viewer / admin ==========================
  union all select * from pg_temp.t('viewer: SELECT events',             'ALLOWED', 'authenticated', c.viewer, 'select * from public.events', c.seed_ev)
  union all select * from pg_temp.t('viewer: INSERT events',             'DENIED',  'authenticated', c.viewer, $q$insert into public.events(device_id,type) values ('4132','sos')$q$)
  union all select * from pg_temp.t('viewer: UPDATE events',             'DENIED',  'authenticated', c.viewer, $q$update public.events set type='fall'$q$, c.seed_ev)
  union all select * from pg_temp.t('viewer: DELETE events',             'DENIED',  'authenticated', c.viewer, $q$delete from public.events$q$, c.seed_ev)
  union all select * from pg_temp.t('viewer: SELECT storage',            'ALLOWED', 'authenticated', c.viewer, 'select * from storage.objects', c.seed_obj)
  union all select * from pg_temp.t('viewer: INSERT storage',            'DENIED',  'authenticated', c.viewer, $q$insert into storage.objects(bucket_id,name) values ('casco-media','4132/photo/a.jpg')$q$)
  union all select * from pg_temp.t('viewer: DELETE storage',            'DENIED',  'authenticated', c.viewer, $q$delete from storage.objects where name='4132/photo/seed.jpg'$q$, c.seed_obj)
  union all select * from pg_temp.t('admin: SELECT events',              'ALLOWED', 'authenticated', c.admin, 'select * from public.events', c.seed_ev)
  union all select * from pg_temp.t('admin: INSERT events',              'DENIED',  'authenticated', c.admin, $q$insert into public.events(device_id,type) values ('4132','sos')$q$)
  -- ======================= stream_commands (video) =======================
  -- Requiere migrations/003_stream_commands.sql. Sub 000...0009 = usuario del seed.
  union all select * from pg_temp.t('cmd anon: SELECT',                  'DENIED',  'anon', c.anon, 'select * from public.stream_commands', c.seed_cmd)
  union all select * from pg_temp.t('cmd anon: INSERT',                  'DENIED',  'anon', c.anon, $q$insert into public.stream_commands(device_id,action) values ('4132','start')$q$)
  union all select * from pg_temp.t('cmd sin rol: SELECT',               'DENIED',  'authenticated', c.norole, 'select * from public.stream_commands', c.seed_cmd)
  union all select * from pg_temp.t('cmd sin rol: INSERT',               'DENIED',  'authenticated', c.norole, $q$insert into public.stream_commands(device_id,action) values ('4132','start')$q$)
  union all select * from pg_temp.t('cmd user_metadata falso: INSERT',   'DENIED',  'authenticated', c.usermeta, $q$insert into public.stream_commands(device_id,action) values ('4132','start')$q$)
  union all select * from pg_temp.t('cmd device: SELECT propio reciente','ALLOWED', 'authenticated', c.dev, $q$select * from public.stream_commands where device_id='4132'$q$, c.seed_cmd)
  union all select * from pg_temp.t('cmd device: SELECT ajeno',          'DENIED',  'authenticated', c.dev, $q$select * from public.stream_commands where device_id='9999'$q$, c.seed_cmd_other)
  union all select * from pg_temp.t('cmd device: SELECT propio vencido', 'DENIED',  'authenticated', c.dev, 'select * from public.stream_commands', c.seed_cmd_old)
  union all select * from pg_temp.t('cmd device: INSERT',                'DENIED',  'authenticated', c.dev, $q$insert into public.stream_commands(device_id,action) values ('4132','start')$q$)
  union all select * from pg_temp.t('cmd device: UPDATE',                'DENIED',  'authenticated', c.dev, $q$update public.stream_commands set action='stop'$q$, c.seed_cmd)
  union all select * from pg_temp.t('cmd device: DELETE',                'DENIED',  'authenticated', c.dev, 'delete from public.stream_commands', c.seed_cmd)
  union all select * from pg_temp.t('cmd viewer: INSERT start',          'ALLOWED', 'authenticated', c.viewer, $q$insert into public.stream_commands(device_id,action) values ('4132','start')$q$)
  union all select * from pg_temp.t('cmd admin: INSERT stop',            'ALLOWED', 'authenticated', c.admin, $q$insert into public.stream_commands(device_id,action) values ('4132','stop')$q$)
  union all select * from pg_temp.t('cmd viewer: SELECT todo',           'ALLOWED', 'authenticated', c.viewer, 'select * from public.stream_commands', c.seed_cmd_old)
  union all select * from pg_temp.t('cmd viewer: action invalida',       'DENIED',  'authenticated', c.viewer, $q$insert into public.stream_commands(device_id,action) values ('4132','reboot')$q$)
  union all select * from pg_temp.t('cmd viewer: device_id con HTML',    'DENIED',  'authenticated', c.viewer, $q$insert into public.stream_commands(device_id,action) values ('<b>','start')$q$)
  union all select * from pg_temp.t('cmd viewer: falsear requested_by',  'DENIED',  'authenticated', c.viewer, $q$insert into public.stream_commands(device_id,action,requested_by) values ('4132','start','00000000-0000-0000-0000-0000000000aa')$q$)
  union all select * from pg_temp.t('cmd viewer: falsear created_at',    'DENIED',  'authenticated', c.viewer, $q$insert into public.stream_commands(device_id,action,created_at) values ('4132','start', now() + interval '1 day')$q$)
  union all select * from pg_temp.t('cmd viewer: UPDATE',                'DENIED',  'authenticated', c.viewer, $q$update public.stream_commands set action='stop'$q$, c.seed_cmd)
  union all select * from pg_temp.t('cmd viewer: DELETE',                'DENIED',  'authenticated', c.viewer, 'delete from public.stream_commands', c.seed_cmd)
  union all select * from pg_temp.t('cmd viewer: 10 comandos/min',       'ALLOWED', 'authenticated', c.viewer, $q$do $b$ begin for i in 1..10 loop insert into public.stream_commands(device_id,action) values ('4132','start'); end loop; end $b$$q$)
  union all select * from pg_temp.t('cmd viewer: 11 comandos/min',       'DENIED',  'authenticated', c.viewer, $q$do $b$ begin for i in 1..11 loop insert into public.stream_commands(device_id,action) values ('4132','start'); end loop; end $b$$q$)
  union all select 'RLS activo en stream_commands', 'OK',
            (select case when relrowsecurity then 'OK' else 'BAD' end from pg_class where oid = 'public.stream_commands'::regclass),
            (select relrowsecurity from pg_class where oid = 'public.stream_commands'::regclass)
  -- ======================= rtc_signals (voz en vivo) =======================
  -- Requiere migrations/004_rtc_signals.sql.
  union all select * from pg_temp.t('rtc anon: SELECT', 'DENIED', 'anon', c.anon, 'select * from public.rtc_signals', c.seed_rtc)
  union all select * from pg_temp.t('rtc anon: INSERT', 'DENIED', 'anon', c.anon, $q$insert into public.rtc_signals(device_id,call_id,kind) values ('4132','bbbbbbbb-0000-0000-0000-000000000001','offer')$q$)
  union all select * from pg_temp.t('rtc sin rol: SELECT', 'DENIED', 'authenticated', c.norole, 'select * from public.rtc_signals', c.seed_rtc)
  union all select * from pg_temp.t('rtc sin rol: INSERT', 'DENIED', 'authenticated', c.norole, $q$insert into public.rtc_signals(device_id,call_id,kind) values ('4132','bbbbbbbb-0000-0000-0000-000000000001','offer')$q$)
  union all select * from pg_temp.t('rtc user_metadata falso: INSERT', 'DENIED', 'authenticated', c.usermeta, $q$insert into public.rtc_signals(device_id,call_id,kind) values ('4132','bbbbbbbb-0000-0000-0000-000000000001','answer')$q$)
  union all select * from pg_temp.t('rtc viewer: INSERT offer', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.rtc_signals(device_id,call_id,kind) values ('4132','bbbbbbbb-0000-0000-0000-000000000001','offer')$q$)
  union all select * from pg_temp.t('rtc viewer: INSERT ice', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.rtc_signals(device_id,call_id,kind,payload) values ('4132','bbbbbbbb-0000-0000-0000-000000000001','ice','{"candidate":"x","sdpMid":"0","sdpMLineIndex":0}'::jsonb)$q$)
  union all select * from pg_temp.t('rtc viewer: INSERT hangup', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.rtc_signals(device_id,call_id,kind) values ('4132','bbbbbbbb-0000-0000-0000-000000000001','hangup')$q$)
  union all select * from pg_temp.t('rtc admin: INSERT offer', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.rtc_signals(device_id,call_id,kind) values ('4132','bbbbbbbb-0000-0000-0000-000000000001','offer')$q$)
  union all select * from pg_temp.t('rtc viewer: INSERT answer (no le corresponde)', 'DENIED', 'authenticated', c.viewer, $q$insert into public.rtc_signals(device_id,call_id,kind) values ('4132','bbbbbbbb-0000-0000-0000-000000000001','answer')$q$)
  union all select * from pg_temp.t('rtc viewer: INSERT busy (no le corresponde)', 'DENIED', 'authenticated', c.viewer, $q$insert into public.rtc_signals(device_id,call_id,kind) values ('4132','bbbbbbbb-0000-0000-0000-000000000001','busy')$q$)
  union all select * from pg_temp.t('rtc viewer: kind invalido', 'DENIED', 'authenticated', c.viewer, $q$insert into public.rtc_signals(device_id,call_id,kind) values ('4132','bbbbbbbb-0000-0000-0000-000000000001','foo')$q$)
  union all select * from pg_temp.t('rtc viewer: device_id con HTML', 'DENIED', 'authenticated', c.viewer, $q$insert into public.rtc_signals(device_id,call_id,kind) values ('<b>','bbbbbbbb-0000-0000-0000-000000000001','offer')$q$)
  union all select * from pg_temp.t('rtc device: INSERT answer propio', 'ALLOWED', 'authenticated', c.dev, $q$insert into public.rtc_signals(device_id,call_id,kind) values ('4132','bbbbbbbb-0000-0000-0000-000000000001','answer')$q$)
  union all select * from pg_temp.t('rtc device: INSERT ice propio', 'ALLOWED', 'authenticated', c.dev, $q$insert into public.rtc_signals(device_id,call_id,kind) values ('4132','bbbbbbbb-0000-0000-0000-000000000001','ice')$q$)
  union all select * from pg_temp.t('rtc device: INSERT hangup propio', 'ALLOWED', 'authenticated', c.dev, $q$insert into public.rtc_signals(device_id,call_id,kind) values ('4132','bbbbbbbb-0000-0000-0000-000000000001','hangup')$q$)
  union all select * from pg_temp.t('rtc device: INSERT busy propio', 'ALLOWED', 'authenticated', c.dev, $q$insert into public.rtc_signals(device_id,call_id,kind) values ('4132','bbbbbbbb-0000-0000-0000-000000000001','busy')$q$)
  union all select * from pg_temp.t('rtc device: INSERT offer (no puede)', 'DENIED', 'authenticated', c.dev, $q$insert into public.rtc_signals(device_id,call_id,kind) values ('4132','bbbbbbbb-0000-0000-0000-000000000001','offer')$q$)
  union all select * from pg_temp.t('rtc device: INSERT device_id ajeno', 'DENIED', 'authenticated', c.dev, $q$insert into public.rtc_signals(device_id,call_id,kind) values ('9999','bbbbbbbb-0000-0000-0000-000000000001','answer')$q$)
  union all select * from pg_temp.t('rtc device sin claim device_id: INSERT', 'DENIED', 'authenticated', c.dev_noid, $q$insert into public.rtc_signals(device_id,call_id,kind) values ('4132','bbbbbbbb-0000-0000-0000-000000000001','answer')$q$)
  union all select * from pg_temp.t('rtc viewer: from_role explicito (sin permiso de columna)', 'DENIED', 'authenticated', c.viewer, $q$insert into public.rtc_signals(device_id,call_id,kind,from_role) values ('4132','bbbbbbbb-0000-0000-0000-000000000001','offer','device')$q$)
  union all select * from pg_temp.t('rtc device: from_role explicito (sin permiso de columna)', 'DENIED', 'authenticated', c.dev, $q$insert into public.rtc_signals(device_id,call_id,kind,from_role) values ('4132','bbbbbbbb-0000-0000-0000-000000000001','answer','viewer')$q$)
  union all select * from pg_temp.t('rtc viewer: falsear created_at', 'DENIED', 'authenticated', c.viewer, $q$insert into public.rtc_signals(device_id,call_id,kind,created_at) values ('4132','bbbbbbbb-0000-0000-0000-000000000001','offer',now() + interval '1 day')$q$)
  union all select * from pg_temp.t('rtc viewer: falsear sender_id', 'DENIED', 'authenticated', c.viewer, $q$insert into public.rtc_signals(device_id,call_id,kind,sender_id) values ('4132','bbbbbbbb-0000-0000-0000-000000000001','offer','00000000-0000-0000-0000-0000000000aa')$q$)
  union all select * from pg_temp.t('rtc trigger: from_role falsificado se pisa (viewer)', 'ALLOWED', 'postgres', c.viewer,
            $q$do $b$ declare r text; begin
                 insert into public.rtc_signals(device_id,call_id,from_role,kind) values ('4132', gen_random_uuid(), 'device', 'offer') returning from_role into r;
                 if r <> 'viewer' then raise exception 'from_role no pisado: %', r; end if;
               end $b$$q$)
  union all select * from pg_temp.t('rtc trigger: from_role falsificado se pisa (device)', 'ALLOWED', 'postgres', c.dev,
            $q$do $b$ declare r text; begin
                 insert into public.rtc_signals(device_id,call_id,from_role,kind) values ('4132', gen_random_uuid(), 'viewer', 'answer') returning from_role into r;
                 if r <> 'device' then raise exception 'from_role no pisado: %', r; end if;
               end $b$$q$)
  union all select * from pg_temp.t('rtc trigger: created_at se pisa a now()', 'ALLOWED', 'postgres', c.viewer,
            $q$do $b$ declare t timestamptz; begin
                 insert into public.rtc_signals(device_id,call_id,kind,created_at) values ('4132', gen_random_uuid(), 'offer', now() + interval '1 day') returning created_at into t;
                 if t > now() + interval '1 second' then raise exception 'created_at no pisado'; end if;
               end $b$$q$)
  union all select * from pg_temp.t('rtc trigger: JWT sin rol se rechaza (aun como postgres)', 'DENIED', 'postgres', c.norole,
            $q$insert into public.rtc_signals(device_id,call_id,kind) values ('4132', gen_random_uuid(), 'offer')$q$)
  union all select * from pg_temp.t('rtc viewer: payload > 8 KB', 'DENIED', 'authenticated', c.viewer, $q$insert into public.rtc_signals(device_id,call_id,kind,payload) values ('4132','bbbbbbbb-0000-0000-0000-000000000001','offer', jsonb_build_object('sdp', repeat('a',9000)))$q$)
  union all select * from pg_temp.t('rtc viewer: payload ~8 KB (permitido)', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.rtc_signals(device_id,call_id,kind,payload) values ('4132','bbbbbbbb-0000-0000-0000-000000000001','offer', jsonb_build_object('sdp', repeat('a',8000)))$q$)
  union all select * from pg_temp.t('rtc viewer: payload no objeto', 'DENIED', 'authenticated', c.viewer, $q$insert into public.rtc_signals(device_id,call_id,kind,payload) values ('4132','bbbbbbbb-0000-0000-0000-000000000001','offer', '[1,2]'::jsonb)$q$)
  union all select * from pg_temp.t('rtc device: SELECT viewer propio reciente', 'ALLOWED', 'authenticated', c.dev, $q$select * from public.rtc_signals where device_id='4132' and from_role='viewer'$q$, c.seed_rtc)
  union all select * from pg_temp.t('rtc device: SELECT casco ajeno', 'DENIED', 'authenticated', c.dev, $q$select * from public.rtc_signals where device_id='9999'$q$, c.seed_rtc)
  union all select * from pg_temp.t('rtc device: SELECT from_role device (lo suyo)', 'DENIED', 'authenticated', c.dev, $q$select * from public.rtc_signals where from_role='device'$q$, c.seed_rtc)
  union all select * from pg_temp.t('rtc device: SELECT propio vencido (>2 min)', 'DENIED', 'authenticated', c.dev, 'select * from public.rtc_signals', c.seed_rtc_old)
  union all select * from pg_temp.t('rtc viewer: SELECT todo', 'ALLOWED', 'authenticated', c.viewer, 'select * from public.rtc_signals', c.seed_rtc_old)
  union all select * from pg_temp.t('rtc admin: SELECT todo', 'ALLOWED', 'authenticated', c.admin, 'select * from public.rtc_signals', c.seed_rtc)
  union all select * from pg_temp.t('rtc device: UPDATE', 'DENIED', 'authenticated', c.dev, $q$update public.rtc_signals set kind='hangup'$q$, c.seed_rtc)
  union all select * from pg_temp.t('rtc device: DELETE', 'DENIED', 'authenticated', c.dev, 'delete from public.rtc_signals', c.seed_rtc)
  union all select * from pg_temp.t('rtc viewer: UPDATE', 'DENIED', 'authenticated', c.viewer, $q$update public.rtc_signals set kind='hangup'$q$, c.seed_rtc)
  union all select * from pg_temp.t('rtc viewer: DELETE', 'DENIED', 'authenticated', c.viewer, 'delete from public.rtc_signals', c.seed_rtc)
  union all select * from pg_temp.t('rtc viewer: 60 senales/min en una llamada', 'ALLOWED', 'authenticated', c.viewer, $q$do $b$ begin for i in 1..60 loop insert into public.rtc_signals(device_id,call_id,kind) values ('4132','bbbbbbbb-0000-0000-0000-000000000001','ice'); end loop; end $b$$q$)
  union all select * from pg_temp.t('rtc viewer: 61 senales/min en una llamada', 'DENIED', 'authenticated', c.viewer, $q$do $b$ begin for i in 1..61 loop insert into public.rtc_signals(device_id,call_id,kind) values ('4132','bbbbbbbb-0000-0000-0000-000000000001','ice'); end loop; end $b$$q$)
  union all select * from pg_temp.t('rtc device: 61 senales/min en una llamada', 'DENIED', 'authenticated', c.dev, $q$do $b$ begin for i in 1..61 loop insert into public.rtc_signals(device_id,call_id,kind) values ('4132','bbbbbbbb-0000-0000-0000-000000000001','ice'); end loop; end $b$$q$)
  union all select * from pg_temp.t('rtc viewer: 300 senales/min (llamadas distintas)', 'ALLOWED', 'authenticated', c.viewer, $q$do $b$ begin for i in 1..300 loop insert into public.rtc_signals(device_id,call_id,kind) values ('4132',gen_random_uuid(),'ice'); end loop; end $b$$q$)
  union all select * from pg_temp.t('rtc viewer: 301 senales/min (esquivar por call_id)', 'DENIED', 'authenticated', c.viewer, $q$do $b$ begin for i in 1..301 loop insert into public.rtc_signals(device_id,call_id,kind) values ('4132',gen_random_uuid(),'ice'); end loop; end $b$$q$)
  union all select 'RLS activo en rtc_signals', 'OK',
            (select case when relrowsecurity then 'OK' else 'BAD' end from pg_class where oid = 'public.rtc_signals'::regclass),
            (select relrowsecurity from pg_class where oid = 'public.rtc_signals'::regclass)
  union all select 'rtc_signals: sin policy de UPDATE/DELETE', 'OK',
            case when not exists (select 1 from pg_policies where schemaname='public' and tablename='rtc_signals' and cmd in ('UPDATE','DELETE','ALL')) then 'OK' else 'BAD' end,
            not exists (select 1 from pg_policies where schemaname='public' and tablename='rtc_signals' and cmd in ('UPDATE','DELETE','ALL'))
  union all select 'rtc_signals en publicacion realtime', 'OK',
            case when exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='rtc_signals') then 'OK' else 'BAD' end,
            exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='rtc_signals')
  -- ======================= Centro de mando (migracion 005) =======================
  -- ---- escalation_rules ----
  union all select * from pg_temp.t('rules anon: SELECT', 'DENIED', 'anon', c.anon, 'select * from public.escalation_rules', c.seed_rule)
  union all select * from pg_temp.t('rules sin rol: SELECT', 'DENIED', 'authenticated', c.norole, 'select * from public.escalation_rules', c.seed_rule)
  union all select * from pg_temp.t('rules device: SELECT', 'DENIED', 'authenticated', c.dev, 'select * from public.escalation_rules', c.seed_rule)
  union all select * from pg_temp.t('rules viewer: SELECT', 'ALLOWED', 'authenticated', c.viewer, 'select * from public.escalation_rules', c.seed_rule)
  union all select * from pg_temp.t('rules admin: SELECT', 'ALLOWED', 'authenticated', c.admin, 'select * from public.escalation_rules', c.seed_rule)
  union all select * from pg_temp.t('rules viewer: UPDATE (solo admin edita)', 'DENIED', 'authenticated', c.viewer, $q$update public.escalation_rules set enabled = true$q$, c.seed_rule)
  union all select * from pg_temp.t('rules viewer: INSERT', 'DENIED', 'authenticated', c.viewer, $q$insert into public.escalation_rules(after_seconds) values (30)$q$)
  union all select * from pg_temp.t('rules device: UPDATE', 'DENIED', 'authenticated', c.dev, $q$update public.escalation_rules set enabled = true$q$, c.seed_rule)
  union all select * from pg_temp.t('rules admin: UPDATE enabled', 'ALLOWED', 'authenticated', c.admin, $q$update public.escalation_rules set enabled = true where id = '00000000-0000-4000-8000-0000000000e1'$q$, c.seed_rule)
  union all select * from pg_temp.t('rules admin: UPDATE after_seconds/plantilla', 'ALLOWED', 'authenticated', c.admin, $q$update public.escalation_rules set after_seconds = 120, message_template = 'Alerta {tipo} {device_id}' where id = '00000000-0000-4000-8000-0000000000e1'$q$, c.seed_rule)
  union all select * from pg_temp.t('rules admin: INSERT', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.escalation_rules(after_seconds, enabled) values (0, false)$q$)
  union all select * from pg_temp.t('rules admin: DELETE (sin grant)', 'DENIED', 'authenticated', c.admin, 'delete from public.escalation_rules', c.seed_rule)
  union all select * from pg_temp.t('rules admin: after_seconds negativo', 'DENIED', 'authenticated', c.admin, $q$insert into public.escalation_rules(after_seconds) values (-1)$q$)
  union all select * from pg_temp.t('rules admin: after_seconds > 3600', 'DENIED', 'authenticated', c.admin, $q$insert into public.escalation_rules(after_seconds) values (7200)$q$)
  union all select * from pg_temp.t('rules admin: channel invalido', 'DENIED', 'authenticated', c.admin, $q$insert into public.escalation_rules(channel) values ('sms')$q$)
  union all select * from pg_temp.t('rules admin: plantilla > 500', 'DENIED', 'authenticated', c.admin, $q$insert into public.escalation_rules(message_template) values (repeat('a',501))$q$)
  union all select * from pg_temp.t('rules admin: falsear created_at (sin grant de columna)', 'DENIED', 'authenticated', c.admin, $q$update public.escalation_rules set created_at = now() - interval '1 year'$q$, c.seed_rule)
  union all select * from pg_temp.t('rules admin: falsear updated_by (sin grant de columna)', 'DENIED', 'authenticated', c.admin, $q$update public.escalation_rules set updated_by = '00000000-0000-0000-0000-0000000000aa'$q$, c.seed_rule)
  union all select * from pg_temp.t('rules admin: maximo 10 reglas', 'DENIED', 'authenticated', c.admin, $q$do $b$ begin for i in 1..10 loop insert into public.escalation_rules(after_seconds) values (30); end loop; end $b$$q$, c.seed_rule)
  union all select * from pg_temp.t('rules trigger: updated_by lo fija el JWT', 'ALLOWED', 'authenticated', c.admin,
            $q$do $b$ declare u uuid; begin
                 update public.escalation_rules set enabled = true where id = '00000000-0000-4000-8000-0000000000e1' returning updated_by into u;
                 if u is distinct from '00000000-0000-0000-0000-000000000006'::uuid then raise exception 'updated_by=%', u; end if;
               end $b$$q$, c.seed_rule)
  -- ---- escalations ----
  union all select * from pg_temp.t('esc anon: SELECT', 'DENIED', 'anon', c.anon, 'select * from public.escalations', c.seed_esc)
  union all select * from pg_temp.t('esc sin rol: SELECT', 'DENIED', 'authenticated', c.norole, 'select * from public.escalations', c.seed_esc)
  union all select * from pg_temp.t('esc device: SELECT', 'DENIED', 'authenticated', c.dev, 'select * from public.escalations', c.seed_esc)
  union all select * from pg_temp.t('esc viewer: SELECT', 'ALLOWED', 'authenticated', c.viewer, 'select * from public.escalations', c.seed_esc)
  union all select * from pg_temp.t('esc admin: SELECT', 'ALLOWED', 'authenticated', c.admin, 'select * from public.escalations', c.seed_esc)
  union all select * from pg_temp.t('esc viewer: INSERT (solo service_role)', 'DENIED', 'authenticated', c.viewer, $q$insert into public.escalations(event_id,rule_id,ok) values ('eeeeeeee-0000-0000-0000-000000000001','00000000-0000-4000-8000-0000000000e1',true)$q$, c.seed_esc_ev)
  union all select * from pg_temp.t('esc admin: INSERT (solo service_role)', 'DENIED', 'authenticated', c.admin, $q$insert into public.escalations(event_id,rule_id,ok) values ('eeeeeeee-0000-0000-0000-000000000001','00000000-0000-4000-8000-0000000000e1',true)$q$, c.seed_esc_ev)
  union all select * from pg_temp.t('esc device: INSERT', 'DENIED', 'authenticated', c.dev, $q$insert into public.escalations(event_id,rule_id,ok) values ('eeeeeeee-0000-0000-0000-000000000001','00000000-0000-4000-8000-0000000000e1',true)$q$, c.seed_esc_ev)
  union all select * from pg_temp.t('esc viewer: UPDATE', 'DENIED', 'authenticated', c.viewer, $q$update public.escalations set ok = false$q$, c.seed_esc)
  union all select * from pg_temp.t('esc admin: UPDATE', 'DENIED', 'authenticated', c.admin, $q$update public.escalations set ok = false$q$, c.seed_esc)
  union all select * from pg_temp.t('esc admin: DELETE', 'DENIED', 'authenticated', c.admin, 'delete from public.escalations', c.seed_esc)
  union all select * from pg_temp.t('esc service_role: INSERT', 'ALLOWED', 'service_role', '{"role":"service_role"}', $q$insert into public.escalations(event_id,rule_id,ok,detail) values ('eeeeeeee-0000-0000-0000-000000000001','00000000-0000-4000-8000-0000000000e1',false,'enviando')$q$, c.seed_esc_ev)
  union all select * from pg_temp.t('esc service_role: UPDATE', 'ALLOWED', 'service_role', '{"role":"service_role"}', $q$update public.escalations set ok = true, detail = 'HTTP 200'$q$, c.seed_esc)
  union all select * from pg_temp.t('esc duplicado (event_id, rule_id) no se repite', 'DENIED', 'postgres', c.admin, $q$insert into public.escalations(event_id,rule_id,ok) values ('eeeeeeee-0000-0000-0000-000000000001','00000000-0000-4000-8000-0000000000e1',true)$q$, c.seed_esc)
  union all select * from pg_temp.t('esc detail > 500', 'DENIED', 'postgres', c.admin, $q$insert into public.escalations(event_id,rule_id,ok,detail) values ('eeeeeeee-0000-0000-0000-000000000001','00000000-0000-4000-8000-0000000000e1',false,repeat('a',501))$q$, c.seed_esc_ev)
  -- ---- events: nuevos tipos (location / geofence) ----
  union all select * from pg_temp.t('events device: INSERT location', 'ALLOWED', 'authenticated', c.dev, $q$insert into public.events(device_id,type,lat,lng) values ('4132','location',-34.6,-58.4)$q$)
  union all select * from pg_temp.t('events device: INSERT geofence', 'ALLOWED', 'authenticated', c.dev, $q$insert into public.events(device_id,type,payload) values ('4132','geofence','{"zone_id":"z","kind":"restringida","action":"enter"}'::jsonb)$q$)
  -- ---- broadcasts ----
  union all select * from pg_temp.t('bc anon: SELECT', 'DENIED', 'anon', c.anon, 'select * from public.broadcasts', c.seed_bc)
  union all select * from pg_temp.t('bc anon: INSERT', 'DENIED', 'anon', c.anon, $q$insert into public.broadcasts(kind,message) values ('mensaje','hola')$q$)
  union all select * from pg_temp.t('bc sin rol: SELECT', 'DENIED', 'authenticated', c.norole, 'select * from public.broadcasts', c.seed_bc)
  union all select * from pg_temp.t('bc sin rol: INSERT', 'DENIED', 'authenticated', c.norole, $q$insert into public.broadcasts(kind,message) values ('mensaje','hola')$q$)
  union all select * from pg_temp.t('bc user_metadata falso: INSERT', 'DENIED', 'authenticated', c.usermeta, $q$insert into public.broadcasts(kind,message) values ('mensaje','hola')$q$)
  union all select * from pg_temp.t('bc viewer: INSERT evacuacion a todos', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.broadcasts(kind,message) values ('evacuacion','')$q$)
  union all select * from pg_temp.t('bc admin: INSERT mensaje', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.broadcasts(kind,message,repeat) values ('mensaje','Vuelvan a la base',1)$q$)
  union all select * from pg_temp.t('bc viewer: INSERT dirigido a un casco', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.broadcasts(kind,message,device_ids) values ('mensaje','hola','{4132}')$q$)
  union all select * from pg_temp.t('bc viewer: message 200 caracteres', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.broadcasts(kind,message) values ('mensaje',repeat('a',200))$q$)
  union all select * from pg_temp.t('bc viewer: message 201 caracteres', 'DENIED', 'authenticated', c.viewer, $q$insert into public.broadcasts(kind,message) values ('mensaje',repeat('a',201))$q$)
  union all select * from pg_temp.t('bc viewer: mensaje en blanco', 'DENIED', 'authenticated', c.viewer, $q$insert into public.broadcasts(kind,message) values ('mensaje','   ')$q$)
  union all select * from pg_temp.t('bc viewer: message con salto de linea', 'DENIED', 'authenticated', c.viewer, $q$insert into public.broadcasts(kind,message) values ('mensaje', 'a' || chr(10) || 'b')$q$)
  union all select * from pg_temp.t('bc viewer: kind invalido', 'DENIED', 'authenticated', c.viewer, $q$insert into public.broadcasts(kind,message) values ('reboot','x')$q$)
  union all select * from pg_temp.t('bc viewer: repeat 5', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.broadcasts(kind,message,repeat) values ('mensaje','x',5)$q$)
  union all select * from pg_temp.t('bc viewer: repeat 6', 'DENIED', 'authenticated', c.viewer, $q$insert into public.broadcasts(kind,message,repeat) values ('mensaje','x',6)$q$)
  union all select * from pg_temp.t('bc viewer: repeat 0', 'DENIED', 'authenticated', c.viewer, $q$insert into public.broadcasts(kind,message,repeat) values ('mensaje','x',0)$q$)
  union all select * from pg_temp.t('bc viewer: device_ids vacio', 'DENIED', 'authenticated', c.viewer, $q$insert into public.broadcasts(kind,message,device_ids) values ('mensaje','x','{}')$q$)
  union all select * from pg_temp.t('bc viewer: device_ids con HTML', 'DENIED', 'authenticated', c.viewer, $q$insert into public.broadcasts(kind,message,device_ids) values ('mensaje','x', array['<b>'])$q$)
  union all select * from pg_temp.t('bc viewer: device_ids con null', 'DENIED', 'authenticated', c.viewer, $q$insert into public.broadcasts(kind,message,device_ids) values ('mensaje','x', array['4132', null])$q$)
  union all select * from pg_temp.t('bc viewer: device_ids con coma', 'DENIED', 'authenticated', c.viewer, $q$insert into public.broadcasts(kind,message,device_ids) values ('mensaje','x', array['4132,9999'])$q$)
  union all select * from pg_temp.t('bc viewer: falsear created_by', 'DENIED', 'authenticated', c.viewer, $q$insert into public.broadcasts(kind,message,created_by) values ('mensaje','x','00000000-0000-0000-0000-0000000000aa')$q$)
  union all select * from pg_temp.t('bc viewer: falsear created_by_email', 'DENIED', 'authenticated', c.viewer, $q$insert into public.broadcasts(kind,message,created_by_email) values ('mensaje','x','otro@x.com')$q$)
  union all select * from pg_temp.t('bc viewer: falsear created_at', 'DENIED', 'authenticated', c.viewer, $q$insert into public.broadcasts(kind,message,created_at) values ('mensaje','x', now() + interval '1 day')$q$)
  union all select * from pg_temp.t('bc viewer: falsear id', 'DENIED', 'authenticated', c.viewer, $q$insert into public.broadcasts(id,kind,message) values (gen_random_uuid(),'mensaje','x')$q$)
  union all select * from pg_temp.t('bc trigger: created_by/email/created_at se pisan', 'ALLOWED', 'postgres', '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000005","email":"sup@test.local","app_metadata":{"role":"viewer"}}',
            $q$do $b$ declare u uuid; e text; t timestamptz; begin
                 insert into public.broadcasts(kind,message,created_by,created_by_email,created_at)
                   values ('mensaje','x','00000000-0000-0000-0000-0000000000aa','falso@x.com', now() + interval '1 day')
                   returning created_by, created_by_email, created_at into u, e, t;
                 if u <> '00000000-0000-0000-0000-000000000005'::uuid or e <> 'sup@test.local' or t > now() + interval '1 second' then
                   raise exception 'no pisado: % % %', u, e, t;
                 end if;
               end $b$$q$)
  union all select * from pg_temp.t('bc trigger: JWT sin rol se rechaza (aun como postgres)', 'DENIED', 'postgres', c.norole, $q$insert into public.broadcasts(kind,message) values ('mensaje','x')$q$)
  union all select * from pg_temp.t('bc device: INSERT', 'DENIED', 'authenticated', c.dev, $q$insert into public.broadcasts(kind,message) values ('mensaje','x')$q$)
  union all select * from pg_temp.t('bc viewer: SELECT todo', 'ALLOWED', 'authenticated', c.viewer, $q$select * from public.broadcasts where id = 'cccccccc-0000-0000-0000-000000000003'$q$, c.seed_bc)
  union all select * from pg_temp.t('bc admin: SELECT todo', 'ALLOWED', 'authenticated', c.admin, $q$select * from public.broadcasts where id = 'cccccccc-0000-0000-0000-000000000003'$q$, c.seed_bc)
  union all select * from pg_temp.t('bc device: SELECT orden a todos', 'ALLOWED', 'authenticated', c.dev, $q$select * from public.broadcasts where id = 'cccccccc-0000-0000-0000-000000000001'$q$, c.seed_bc)
  union all select * from pg_temp.t('bc device: SELECT orden dirigida a el', 'ALLOWED', 'authenticated', c.dev, $q$select * from public.broadcasts where id = 'cccccccc-0000-0000-0000-000000000002'$q$, c.seed_bc)
  union all select * from pg_temp.t('bc device: SELECT orden dirigida a otro casco', 'DENIED', 'authenticated', c.dev, $q$select * from public.broadcasts where id = 'cccccccc-0000-0000-0000-000000000003'$q$, c.seed_bc)
  union all select * from pg_temp.t('bc device: SELECT orden vencida (>2 min)', 'DENIED', 'authenticated', c.dev, $q$select * from public.broadcasts where id = 'cccccccc-0000-0000-0000-000000000004'$q$, c.seed_bc_old)
  union all select * from pg_temp.t('bc device sin claim device_id: SELECT', 'DENIED', 'authenticated', c.dev_noid, $q$select * from public.broadcasts where id = 'cccccccc-0000-0000-0000-000000000001'$q$, c.seed_bc)
  union all select * from pg_temp.t('bc viewer: UPDATE', 'DENIED', 'authenticated', c.viewer, $q$update public.broadcasts set message = 'otro'$q$, c.seed_bc)
  union all select * from pg_temp.t('bc admin: UPDATE', 'DENIED', 'authenticated', c.admin, $q$update public.broadcasts set message = 'otro'$q$, c.seed_bc)
  union all select * from pg_temp.t('bc device: UPDATE', 'DENIED', 'authenticated', c.dev, $q$update public.broadcasts set message = 'otro'$q$, c.seed_bc)
  union all select * from pg_temp.t('bc viewer: DELETE', 'DENIED', 'authenticated', c.viewer, 'delete from public.broadcasts', c.seed_bc)
  union all select * from pg_temp.t('bc admin: DELETE', 'DENIED', 'authenticated', c.admin, 'delete from public.broadcasts', c.seed_bc)
  union all select * from pg_temp.t('bc device: DELETE', 'DENIED', 'authenticated', c.dev, 'delete from public.broadcasts', c.seed_bc)
  union all select * from pg_temp.t('bc viewer: 6 ordenes/min', 'ALLOWED', 'authenticated', c.viewer, $q$do $b$ begin for i in 1..6 loop insert into public.broadcasts(kind,message) values ('mensaje','x'); end loop; end $b$$q$)
  union all select * from pg_temp.t('bc viewer: 7 ordenes/min', 'DENIED', 'authenticated', c.viewer, $q$do $b$ begin for i in 1..7 loop insert into public.broadcasts(kind,message) values ('mensaje','x'); end loop; end $b$$q$)
  -- ---- broadcast_acks ----
  union all select * from pg_temp.t('ack anon: INSERT', 'DENIED', 'anon', c.anon, $q$insert into public.broadcast_acks(broadcast_id,device_id) values ('cccccccc-0000-0000-0000-000000000001','4132')$q$, c.seed_bc)
  union all select * from pg_temp.t('ack anon: SELECT', 'DENIED', 'anon', c.anon, 'select * from public.broadcast_acks', c.seed_ack)
  union all select * from pg_temp.t('ack sin rol: INSERT', 'DENIED', 'authenticated', c.norole, $q$insert into public.broadcast_acks(broadcast_id,device_id) values ('cccccccc-0000-0000-0000-000000000001','4132')$q$, c.seed_bc)
  union all select * from pg_temp.t('ack device: INSERT propio, orden a todos', 'ALLOWED', 'authenticated', c.dev, $q$insert into public.broadcast_acks(broadcast_id,device_id) values ('cccccccc-0000-0000-0000-000000000001','4132')$q$, c.seed_bc)
  union all select * from pg_temp.t('ack device: INSERT propio, orden dirigida a el', 'ALLOWED', 'authenticated', c.dev, $q$insert into public.broadcast_acks(broadcast_id,device_id) values ('cccccccc-0000-0000-0000-000000000002','4132')$q$, c.seed_bc)
  union all select * from pg_temp.t('ack device: orden dirigida a otro casco', 'DENIED', 'authenticated', c.dev, $q$insert into public.broadcast_acks(broadcast_id,device_id) values ('cccccccc-0000-0000-0000-000000000003','4132')$q$, c.seed_bc)
  union all select * from pg_temp.t('ack device: orden vencida', 'DENIED', 'authenticated', c.dev, $q$insert into public.broadcast_acks(broadcast_id,device_id) values ('cccccccc-0000-0000-0000-000000000004','4132')$q$, c.seed_bc_old)
  union all select * from pg_temp.t('ack device: device_id ajeno', 'DENIED', 'authenticated', c.dev, $q$insert into public.broadcast_acks(broadcast_id,device_id) values ('cccccccc-0000-0000-0000-000000000001','9999')$q$, c.seed_bc)
  union all select * from pg_temp.t('ack device: orden inexistente', 'DENIED', 'authenticated', c.dev, $q$insert into public.broadcast_acks(broadcast_id,device_id) values ('cccccccc-0000-0000-0000-0000000000ff','4132')$q$)
  union all select * from pg_temp.t('ack device sin claim device_id: INSERT', 'DENIED', 'authenticated', c.dev_noid, $q$insert into public.broadcast_acks(broadcast_id,device_id) values ('cccccccc-0000-0000-0000-000000000001','4132')$q$, c.seed_bc)
  union all select * from pg_temp.t('ack device: duplicado (ya registrado)', 'DENIED', 'authenticated', c.dev, $q$insert into public.broadcast_acks(broadcast_id,device_id) values ('cccccccc-0000-0000-0000-000000000001','4132')$q$, c.seed_ack)
  union all select * from pg_temp.t('ack device: falsear played_at (sin grant de columna)', 'DENIED', 'authenticated', c.dev, $q$insert into public.broadcast_acks(broadcast_id,device_id,played_at) values ('cccccccc-0000-0000-0000-000000000001','4132', now() + interval '1 day')$q$, c.seed_bc)
  union all select * from pg_temp.t('ack viewer: INSERT (solo el casco)', 'DENIED', 'authenticated', c.viewer, $q$insert into public.broadcast_acks(broadcast_id,device_id) values ('cccccccc-0000-0000-0000-000000000001','4132')$q$, c.seed_bc)
  union all select * from pg_temp.t('ack admin: INSERT (solo el casco)', 'DENIED', 'authenticated', c.admin, $q$insert into public.broadcast_acks(broadcast_id,device_id) values ('cccccccc-0000-0000-0000-000000000001','4132')$q$, c.seed_bc)
  union all select * from pg_temp.t('ack device: SELECT (no lee)', 'DENIED', 'authenticated', c.dev, 'select * from public.broadcast_acks', c.seed_ack)
  union all select * from pg_temp.t('ack viewer: SELECT', 'ALLOWED', 'authenticated', c.viewer, 'select * from public.broadcast_acks', c.seed_ack)
  union all select * from pg_temp.t('ack admin: SELECT', 'ALLOWED', 'authenticated', c.admin, 'select * from public.broadcast_acks', c.seed_ack)
  union all select * from pg_temp.t('ack device: UPDATE', 'DENIED', 'authenticated', c.dev, $q$update public.broadcast_acks set device_id = '9999'$q$, c.seed_ack)
  union all select * from pg_temp.t('ack device: DELETE', 'DENIED', 'authenticated', c.dev, 'delete from public.broadcast_acks', c.seed_ack)
  union all select * from pg_temp.t('ack viewer: UPDATE', 'DENIED', 'authenticated', c.viewer, $q$update public.broadcast_acks set device_id = '9999'$q$, c.seed_ack)
  union all select * from pg_temp.t('ack viewer: DELETE', 'DENIED', 'authenticated', c.viewer, 'delete from public.broadcast_acks', c.seed_ack)
  union all select * from pg_temp.t('ack trigger: played_at se pisa a now()', 'ALLOWED', 'postgres', c.dev,
            $q$do $b$ declare t timestamptz; begin
                 insert into public.broadcast_acks(broadcast_id,device_id,played_at)
                   values ('cccccccc-0000-0000-0000-000000000001','4132', now() + interval '1 day') returning played_at into t;
                 if t > now() + interval '1 second' then raise exception 'played_at no pisado'; end if;
               end $b$$q$, c.seed_bc)
  union all select 'RLS activo en escalation_rules', 'OK',
            (select case when relrowsecurity then 'OK' else 'BAD' end from pg_class where oid = 'public.escalation_rules'::regclass),
            (select relrowsecurity from pg_class where oid = 'public.escalation_rules'::regclass)
  union all select 'RLS activo en escalations', 'OK',
            (select case when relrowsecurity then 'OK' else 'BAD' end from pg_class where oid = 'public.escalations'::regclass),
            (select relrowsecurity from pg_class where oid = 'public.escalations'::regclass)
  union all select 'RLS activo en broadcasts', 'OK',
            (select case when relrowsecurity then 'OK' else 'BAD' end from pg_class where oid = 'public.broadcasts'::regclass),
            (select relrowsecurity from pg_class where oid = 'public.broadcasts'::regclass)
  union all select 'RLS activo en broadcast_acks', 'OK',
            (select case when relrowsecurity then 'OK' else 'BAD' end from pg_class where oid = 'public.broadcast_acks'::regclass),
            (select relrowsecurity from pg_class where oid = 'public.broadcast_acks'::regclass)
  union all select 'centro: sin policy de DELETE/ALL en tablas nuevas', 'OK',
            case when not exists (select 1 from pg_policies where schemaname='public'
                    and tablename in ('escalation_rules','escalations','broadcasts','broadcast_acks') and cmd in ('DELETE','ALL')) then 'OK' else 'BAD' end,
            not exists (select 1 from pg_policies where schemaname='public'
                    and tablename in ('escalation_rules','escalations','broadcasts','broadcast_acks') and cmd in ('DELETE','ALL'))
  union all select 'centro: solo escalation_rules tiene policy de UPDATE', 'OK',
            case when not exists (select 1 from pg_policies where schemaname='public'
                    and tablename in ('escalations','broadcasts','broadcast_acks') and cmd = 'UPDATE') then 'OK' else 'BAD' end,
            not exists (select 1 from pg_policies where schemaname='public'
                    and tablename in ('escalations','broadcasts','broadcast_acks') and cmd = 'UPDATE')
  union all select 'broadcasts y broadcast_acks en publicacion realtime', 'OK',
            case when (select count(*) from pg_publication_tables where pubname='supabase_realtime'
                         and schemaname='public' and tablename in ('broadcasts','broadcast_acks')) = 2 then 'OK' else 'BAD' end,
            (select count(*) from pg_publication_tables where pubname='supabase_realtime'
               and schemaname='public' and tablename in ('broadcasts','broadcast_acks')) = 2
  -- ======================= Mapa: geofences / geo_points (migracion 006) =======================
  -- ---- geofences: acceso ----
  union all select * from pg_temp.t('gf anon: SELECT', 'DENIED', 'anon', c.anon, $q$select * from public.geofences$q$, c.seed_gf)
  union all select * from pg_temp.t('gf anon: INSERT', 'DENIED', 'anon', c.anon, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf sin rol: SELECT', 'DENIED', 'authenticated', c.norole, $q$select * from public.geofences$q$, c.seed_gf)
  union all select * from pg_temp.t('gf sin rol: INSERT', 'DENIED', 'authenticated', c.norole, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf user_metadata falso: SELECT', 'DENIED', 'authenticated', c.usermeta, $q$select * from public.geofences$q$, c.seed_gf)
  union all select * from pg_temp.t('gf user_metadata falso: INSERT', 'DENIED', 'authenticated', c.usermeta, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}')$q$)
  -- ---- geofences: device (solo activas, no borradas, globales o propias) ----
  union all select * from pg_temp.t('gf device: SELECT global activa', 'ALLOWED', 'authenticated', c.dev, $q$select * from public.geofences where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf device: SELECT dirigida a el', 'ALLOWED', 'authenticated', c.dev, $q$select * from public.geofences where id = '99999999-0000-0000-0000-000000000002'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf device: SELECT dirigida a otro casco', 'DENIED', 'authenticated', c.dev, $q$select * from public.geofences where id = '99999999-0000-0000-0000-000000000003'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf device: SELECT inactiva', 'DENIED', 'authenticated', c.dev, $q$select * from public.geofences where id = '99999999-0000-0000-0000-000000000004'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf device: SELECT dada de baja', 'DENIED', 'authenticated', c.dev, $q$select * from public.geofences where id = '99999999-0000-0000-0000-000000000005'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf device: ve exactamente 2 (global + propia)', 'ALLOWED', 'authenticated', c.dev, $q$do $b$ declare n int; begin select count(*) into n from public.geofences; if n <> 2 then raise exception 've %', n; end if; end $b$$q$, c.seed_gf)
  union all select * from pg_temp.t('gf device sin claim device_id: SELECT', 'DENIED', 'authenticated', c.dev_noid, $q$select * from public.geofences$q$, c.seed_gf)
  union all select * from pg_temp.t('gf device: INSERT', 'DENIED', 'authenticated', c.dev, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf device: UPDATE', 'DENIED', 'authenticated', c.dev, $q$update public.geofences set active = false$q$, c.seed_gf)
  union all select * from pg_temp.t('gf device: DELETE', 'DENIED', 'authenticated', c.dev, $q$delete from public.geofences$q$, c.seed_gf)
  -- ---- geofences: viewer/admin ----
  union all select * from pg_temp.t('gf viewer: SELECT todo (incluye bajas)', 'ALLOWED', 'authenticated', c.viewer, $q$select * from public.geofences where id = '99999999-0000-0000-0000-000000000005'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf admin: SELECT', 'ALLOWED', 'authenticated', c.admin, $q$select * from public.geofences$q$, c.seed_gf)
  union all select * from pg_temp.t('gf viewer: INSERT circulo', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf viewer: INSERT poligono', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','permitida','polygon','{"points":[[-34.60,-58.40],[-34.61,-58.40],[-34.61,-58.41]]}')$q$)
  union all select * from pg_temp.t('gf admin: INSERT', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf viewer: INSERT con device_ids, mensaje y alarma', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry,device_ids,message,alarm) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}','{4132,9999}','Cuidado con el pozo','voz')$q$)
  union all select * from pg_temp.t('gf viewer: message en blanco se guarda como null', 'ALLOWED', 'postgres', c.viewer, $q$do $b$ declare m text; begin insert into public.geofences(name,kind,shape,geometry,message) values ('z','informativa','circle','{"center":[-34.6,-58.4],"radius_m":100}','   ') returning message into m; if m is not null then raise exception 'message=%', m; end if; end $b$$q$)
  union all select * from pg_temp.t('gf viewer: UPDATE name', 'ALLOWED', 'authenticated', c.viewer, $q$update public.geofences set name = 'nuevo' where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf viewer: UPDATE kind', 'ALLOWED', 'authenticated', c.viewer, $q$update public.geofences set kind = 'permitida' where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf viewer: UPDATE geometry', 'ALLOWED', 'authenticated', c.viewer, $q$update public.geofences set geometry = '{"center":[-34.7,-58.5],"radius_m":250}' where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf viewer: UPDATE device_ids', 'ALLOWED', 'authenticated', c.viewer, $q$update public.geofences set device_ids = '{4132}' where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf viewer: UPDATE message/alarm', 'ALLOWED', 'authenticated', c.viewer, $q$update public.geofences set message = 'hola', alarm = 'sirena' where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf viewer: UPDATE active', 'ALLOWED', 'authenticated', c.viewer, $q$update public.geofences set active = false where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf admin: UPDATE name', 'ALLOWED', 'authenticated', c.admin, $q$update public.geofences set name = 'nuevo' where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf viewer: baja logica (deleted_at)', 'ALLOWED', 'authenticated', c.viewer, $q$update public.geofences set deleted_at = now() where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf viewer: UPDATE zona dada de baja (congelada)', 'DENIED', 'authenticated', c.viewer, $q$update public.geofences set name = 'x' where id = '99999999-0000-0000-0000-000000000005'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf viewer: reactivar baja (deleted_at = null)', 'DENIED', 'authenticated', c.viewer, $q$update public.geofences set deleted_at = null where id = '99999999-0000-0000-0000-000000000005'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf viewer: DELETE (sin grant)', 'DENIED', 'authenticated', c.viewer, $q$delete from public.geofences$q$, c.seed_gf)
  union all select * from pg_temp.t('gf admin: DELETE (sin grant)', 'DENIED', 'authenticated', c.admin, $q$delete from public.geofences$q$, c.seed_gf)
  -- ---- geofences: campos del servidor y columnas sin grant ----
  union all select * from pg_temp.t('gf viewer: falsear created_by', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry,created_by) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}','00000000-0000-0000-0000-0000000000aa')$q$)
  union all select * from pg_temp.t('gf viewer: falsear created_at', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry,created_at) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}',now() + interval '1 day')$q$)
  union all select * from pg_temp.t('gf viewer: falsear updated_at', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry,updated_at) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}',now() + interval '1 day')$q$)
  union all select * from pg_temp.t('gf viewer: falsear id', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry,id) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}',gen_random_uuid())$q$)
  union all select * from pg_temp.t('gf viewer: INSERT con deleted_at (sin grant de insert)', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry,deleted_at) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}',now())$q$)
  union all select * from pg_temp.t('gf viewer: UPDATE shape (sin grant)', 'DENIED', 'authenticated', c.viewer, $q$update public.geofences set shape = 'polygon' where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf viewer: UPDATE created_by (sin grant)', 'DENIED', 'authenticated', c.viewer, $q$update public.geofences set created_by = '00000000-0000-0000-0000-0000000000aa' where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf viewer: UPDATE created_at (sin grant)', 'DENIED', 'authenticated', c.viewer, $q$update public.geofences set created_at = now() - interval '1 year' where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf viewer: UPDATE updated_at (sin grant)', 'DENIED', 'authenticated', c.viewer, $q$update public.geofences set updated_at = now() - interval '1 year' where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf viewer: UPDATE id (sin grant)', 'DENIED', 'authenticated', c.viewer, $q$update public.geofences set id = gen_random_uuid() where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf trigger: created_by/created_at/updated_at se pisan', 'ALLOWED', 'postgres', '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000005","app_metadata":{"role":"viewer"}}', $q$do $b$ declare u uuid; c timestamptz; m timestamptz; begin insert into public.geofences(name,kind,shape,geometry,created_by,created_at,updated_at) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}','00000000-0000-0000-0000-0000000000aa', now() - interval '1 year', now() + interval '1 day') returning created_by, created_at, updated_at into u, c, m; if u <> '00000000-0000-0000-0000-000000000005'::uuid or c > now() + interval '1 second' or c < now() - interval '1 second' or m > now() + interval '1 second' then raise exception 'no pisado: % % %', u, c, m; end if; end $b$$q$)
  union all select * from pg_temp.t('gf trigger: deleted_at falsificado se pisa a now()', 'ALLOWED', 'postgres', c.viewer, $q$do $b$ declare d timestamptz; begin update public.geofences set deleted_at = '2000-01-01' where id = '99999999-0000-0000-0000-000000000001' returning deleted_at into d; if d is null or d < now() - interval '1 second' then raise exception 'deleted_at=%', d; end if; end $b$$q$, c.seed_gf)
  union all select * from pg_temp.t('gf trigger: shape inmutable aun como postgres', 'ALLOWED', 'postgres', c.viewer, $q$do $b$ declare s text; begin update public.geofences set shape = 'polygon' where id = '99999999-0000-0000-0000-000000000001' returning shape into s; if s <> 'circle' then raise exception 'shape=%', s; end if; end $b$$q$, c.seed_gf)
  union all select * from pg_temp.t('gf trigger: JWT sin rol se rechaza (aun como postgres)', 'DENIED', 'postgres', c.norole, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf trigger: UPDATE con JWT device se rechaza (aun como postgres)', 'DENIED', 'postgres', c.dev, $q$update public.geofences set active = false$q$, c.seed_gf)
  union all select * from pg_temp.t('gf trigger: UPDATE sin JWT (SQL Editor) permitido', 'ALLOWED', 'postgres', c.anon, $q$update public.geofences set name = 'mantenimiento' where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  -- ---- geofences: validacion de campos y geometria ----
  union all select * from pg_temp.t('gf viewer: name vacio', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf viewer: name en blanco', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('   ','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf viewer: name 80 caracteres', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values (repeat('a',80),'restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf viewer: name 81 caracteres', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values (repeat('a',81),'restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf viewer: name con salto de linea', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('a' || chr(10) || 'b','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf viewer: kind invalido', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','prohibida','circle','{"center":[-34.6,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf viewer: shape invalido', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','rectangle','{"center":[-34.6,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf viewer: alarm invalida', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry,alarm) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}','bomba')$q$)
  union all select * from pg_temp.t('gf viewer: message 140', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry,message) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}',repeat('a',140))$q$)
  union all select * from pg_temp.t('gf viewer: message 141', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry,message) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}',repeat('a',141))$q$)
  union all select * from pg_temp.t('gf viewer: message con salto de linea', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry,message) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}','a' || chr(10) || 'b')$q$)
  union all select * from pg_temp.t('gf viewer: device_ids vacio', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry,device_ids) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}','{}')$q$)
  union all select * from pg_temp.t('gf viewer: device_ids con HTML', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry,device_ids) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}',array['<b>'])$q$)
  union all select * from pg_temp.t('gf viewer: device_ids con null', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry,device_ids) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}',array['4132', null])$q$)
  union all select * from pg_temp.t('gf viewer: device_ids con coma', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry,device_ids) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}',array['4132,9999'])$q$)
  union all select * from pg_temp.t('gf viewer: geometria radio 10 (limite)', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":10}')$q$)
  union all select * from pg_temp.t('gf viewer: geometria radio 50000 (limite)', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":50000}')$q$)
  union all select * from pg_temp.t('gf viewer: geometria radio 9', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":9}')$q$)
  union all select * from pg_temp.t('gf viewer: geometria radio 50001', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":50001}')$q$)
  union all select * from pg_temp.t('gf viewer: geometria radio negativo', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":-5}')$q$)
  union all select * from pg_temp.t('gf viewer: geometria radio como texto', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":"100"}')$q$)
  union all select * from pg_temp.t('gf viewer: geometria sin radio', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4]}')$q$)
  union all select * from pg_temp.t('gf viewer: geometria sin centro', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf viewer: geometria lat 91', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[91,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf viewer: geometria lat -91', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-91,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf viewer: geometria lng 181', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,181],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf viewer: geometria lng -181', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-181],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf viewer: geometria centro con 3 valores', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4,5],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf viewer: geometria centro con texto', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":["a","b"],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf viewer: geometria clave extra', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100,"x":1}')$q$)
  union all select * from pg_temp.t('gf viewer: geometria no objeto', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','[1,2]')$q$)
  union all select * from pg_temp.t('gf viewer: geometria circulo con forma poligono', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"points":[[-34.60,-58.40],[-34.61,-58.40],[-34.61,-58.41]]}')$q$)
  union all select * from pg_temp.t('gf viewer: geometria poligono con forma circulo', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','polygon','{"center":[-34.6,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf viewer: geometria poligono 3 puntos', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','polygon','{"points":[[-34.60,-58.40],[-34.61,-58.40],[-34.61,-58.41]]}')$q$)
  union all select * from pg_temp.t('gf viewer: geometria poligono 2 puntos', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','polygon','{"points":[[-34.60,-58.40],[-34.61,-58.40]]}')$q$)
  union all select * from pg_temp.t('gf viewer: geometria poligono 3 puntos iguales', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','polygon','{"points":[[-34.6,-58.4],[-34.6,-58.4],[-34.6,-58.4]]}')$q$)
  union all select * from pg_temp.t('gf viewer: geometria poligono con punto fuera de rango', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','polygon','{"points":[[-34.60,-58.40],[-34.61,-58.40],[95,-58.41]]}')$q$)
  union all select * from pg_temp.t('gf viewer: geometria poligono con punto malformado', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','polygon','{"points":[[-34.60,-58.40],[-34.61],[-34.61,-58.41]]}')$q$)
  union all select * from pg_temp.t('gf viewer: geometria poligono points no es array', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','polygon','{"points":"x"}')$q$)
  union all select * from pg_temp.t('gf viewer: geometria poligono clave extra', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','polygon','{"points":[[-34.60,-58.40],[-34.61,-58.40],[-34.61,-58.41]],"x":1}')$q$)
  union all select * from pg_temp.t('gf viewer: poligono 100 puntos', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) select 'z','restringida','polygon', jsonb_build_object('points', (select jsonb_agg(jsonb_build_array(-34 - i/1000.0, -58 - i/1000.0)) from generate_series(1,100) i))$q$)
  union all select * from pg_temp.t('gf viewer: poligono 101 puntos', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) select 'z','restringida','polygon', jsonb_build_object('points', (select jsonb_agg(jsonb_build_array(-34 - i/1000.0, -58 - i/1000.0)) from generate_series(1,101) i))$q$)
  union all select * from pg_temp.t('gf viewer: UPDATE geometry invalida', 'DENIED', 'authenticated', c.viewer, $q$update public.geofences set geometry = '{"center":[-34.7,-58.5],"radius_m":5}' where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf viewer: UPDATE geometry de otra forma', 'DENIED', 'authenticated', c.viewer, $q$update public.geofences set geometry = '{"points":[[-34.60,-58.40],[-34.61,-58.40],[-34.61,-58.41]]}' where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  -- ---- geofences: rate limit 30 filas/min por usuario ----
  union all select * from pg_temp.t('gf viewer: 30 zonas/min', 'ALLOWED', 'authenticated', c.viewer, $q$do $b$ begin for i in 1..30 loop insert into public.geofences(name,kind,shape,geometry) values ('z' || i,'restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}'); end loop; end $b$$q$)
  union all select * from pg_temp.t('gf viewer: 31 zonas/min', 'DENIED', 'authenticated', c.viewer, $q$do $b$ begin for i in 1..31 loop insert into public.geofences(name,kind,shape,geometry) values ('z' || i,'restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}'); end loop; end $b$$q$)
  -- ---- geo_points: acceso ----
  union all select * from pg_temp.t('gp anon: SELECT', 'DENIED', 'anon', c.anon, $q$select * from public.geo_points$q$, c.seed_gp)
  union all select * from pg_temp.t('gp anon: INSERT', 'DENIED', 'anon', c.anon, $q$insert into public.geo_points(name,category,lat,lng) values ('p','extintor',-34.6,-58.4)$q$)
  union all select * from pg_temp.t('gp sin rol: SELECT', 'DENIED', 'authenticated', c.norole, $q$select * from public.geo_points$q$, c.seed_gp)
  union all select * from pg_temp.t('gp sin rol: INSERT', 'DENIED', 'authenticated', c.norole, $q$insert into public.geo_points(name,category,lat,lng) values ('p','extintor',-34.6,-58.4)$q$)
  union all select * from pg_temp.t('gp user_metadata falso: INSERT', 'DENIED', 'authenticated', c.usermeta, $q$insert into public.geo_points(name,category,lat,lng) values ('p','extintor',-34.6,-58.4)$q$)
  -- ---- geo_points: device (solo 'peligro' activos y no borrados) ----
  union all select * from pg_temp.t('gp device: SELECT peligro activo', 'ALLOWED', 'authenticated', c.dev, $q$select * from public.geo_points where id = 'dddddddd-0000-0000-0000-000000000001'$q$, c.seed_gp)
  union all select * from pg_temp.t('gp device: SELECT otra categoria (extintor)', 'DENIED', 'authenticated', c.dev, $q$select * from public.geo_points where id = 'dddddddd-0000-0000-0000-000000000002'$q$, c.seed_gp)
  union all select * from pg_temp.t('gp device: SELECT peligro inactivo', 'DENIED', 'authenticated', c.dev, $q$select * from public.geo_points where id = 'dddddddd-0000-0000-0000-000000000003'$q$, c.seed_gp)
  union all select * from pg_temp.t('gp device: SELECT peligro dado de baja', 'DENIED', 'authenticated', c.dev, $q$select * from public.geo_points where id = 'dddddddd-0000-0000-0000-000000000004'$q$, c.seed_gp)
  union all select * from pg_temp.t('gp device: ve exactamente 1 (el peligro activo)', 'ALLOWED', 'authenticated', c.dev, $q$do $b$ declare n int; begin select count(*) into n from public.geo_points; if n <> 1 then raise exception 've %', n; end if; end $b$$q$, c.seed_gp)
  union all select * from pg_temp.t('gp device sin claim device_id: SELECT', 'DENIED', 'authenticated', c.dev_noid, $q$select * from public.geo_points$q$, c.seed_gp)
  union all select * from pg_temp.t('gp device: INSERT', 'DENIED', 'authenticated', c.dev, $q$insert into public.geo_points(name,category,lat,lng) values ('p','peligro',-34.6,-58.4)$q$)
  union all select * from pg_temp.t('gp device: UPDATE', 'DENIED', 'authenticated', c.dev, $q$update public.geo_points set active = false$q$, c.seed_gp)
  union all select * from pg_temp.t('gp device: DELETE', 'DENIED', 'authenticated', c.dev, $q$delete from public.geo_points$q$, c.seed_gp)
  -- ---- geo_points: viewer/admin ----
  union all select * from pg_temp.t('gp viewer: SELECT todo (incluye bajas)', 'ALLOWED', 'authenticated', c.viewer, $q$select * from public.geo_points where id = 'dddddddd-0000-0000-0000-000000000004'$q$, c.seed_gp)
  union all select * from pg_temp.t('gp admin: SELECT', 'ALLOWED', 'authenticated', c.admin, $q$select * from public.geo_points$q$, c.seed_gp)
  union all select * from pg_temp.t('gp viewer: INSERT punto_reunion', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.geo_points(name,category,lat,lng) values ('p','punto_reunion',-34.6,-58.4)$q$)
  union all select * from pg_temp.t('gp viewer: INSERT extintor', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.geo_points(name,category,lat,lng) values ('p','extintor',-34.6,-58.4)$q$)
  union all select * from pg_temp.t('gp viewer: INSERT botiquin', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.geo_points(name,category,lat,lng) values ('p','botiquin',-34.6,-58.4)$q$)
  union all select * from pg_temp.t('gp viewer: INSERT acceso', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.geo_points(name,category,lat,lng) values ('p','acceso',-34.6,-58.4)$q$)
  union all select * from pg_temp.t('gp viewer: INSERT otro', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.geo_points(name,category,lat,lng) values ('p','otro',-34.6,-58.4)$q$)
  union all select * from pg_temp.t('gp admin: INSERT', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng) values ('p','extintor',-34.6,-58.4)$q$)
  union all select * from pg_temp.t('gp viewer: INSERT peligro con radio', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.geo_points(name,category,lat,lng,alert_radius_m) values ('p','peligro',-34.6,-58.4,50)$q$)
  union all select * from pg_temp.t('gp viewer: INSERT con notas, mensaje y alarma', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.geo_points(name,category,lat,lng,notes,message,alarm) values ('p','peligro',-34.6,-58.4,'Valvula con fuga' || chr(10) || 'Zona norte','Peligro, valvula con fuga','sirena')$q$)
  union all select * from pg_temp.t('gp viewer: peligro sin radio => 30 por defecto', 'ALLOWED', 'postgres', c.viewer, $q$do $b$ declare r int; begin insert into public.geo_points(name,category,lat,lng) values ('p','peligro',-34.6,-58.4) returning alert_radius_m into r; if r <> 30 then raise exception 'radio=%', r; end if; end $b$$q$)
  union all select * from pg_temp.t('gp viewer: radio en categoria no peligro se normaliza a null', 'ALLOWED', 'postgres', c.viewer, $q$do $b$ declare r int; begin insert into public.geo_points(name,category,lat,lng,alert_radius_m) values ('p','extintor',-34.6,-58.4,50) returning alert_radius_m into r; if r is not null then raise exception 'radio=%', r; end if; end $b$$q$)
  union all select * from pg_temp.t('gp viewer: UPDATE name/notes/lat/lng', 'ALLOWED', 'authenticated', c.viewer, $q$update public.geo_points set name='n', notes='x', lat=-34.7, lng=-58.5 where id = 'dddddddd-0000-0000-0000-000000000001'$q$, c.seed_gp)
  union all select * from pg_temp.t('gp viewer: UPDATE alert_radius_m/message/alarm', 'ALLOWED', 'authenticated', c.viewer, $q$update public.geo_points set alert_radius_m = 100, message = 'm', alarm = 'voz' where id = 'dddddddd-0000-0000-0000-000000000001'$q$, c.seed_gp)
  union all select * from pg_temp.t('gp viewer: UPDATE category + active', 'ALLOWED', 'authenticated', c.viewer, $q$update public.geo_points set category = 'otro', active = false where id = 'dddddddd-0000-0000-0000-000000000001'$q$, c.seed_gp)
  union all select * from pg_temp.t('gp viewer: baja logica', 'ALLOWED', 'authenticated', c.viewer, $q$update public.geo_points set deleted_at = now() where id = 'dddddddd-0000-0000-0000-000000000001'$q$, c.seed_gp)
  union all select * from pg_temp.t('gp viewer: UPDATE punto dado de baja (congelado)', 'DENIED', 'authenticated', c.viewer, $q$update public.geo_points set name = 'x' where id = 'dddddddd-0000-0000-0000-000000000004'$q$, c.seed_gp)
  union all select * from pg_temp.t('gp viewer: reactivar baja', 'DENIED', 'authenticated', c.viewer, $q$update public.geo_points set deleted_at = null where id = 'dddddddd-0000-0000-0000-000000000004'$q$, c.seed_gp)
  union all select * from pg_temp.t('gp viewer: DELETE (sin grant)', 'DENIED', 'authenticated', c.viewer, $q$delete from public.geo_points$q$, c.seed_gp)
  union all select * from pg_temp.t('gp admin: DELETE (sin grant)', 'DENIED', 'authenticated', c.admin, $q$delete from public.geo_points$q$, c.seed_gp)
  -- ---- geo_points: campos del servidor, columnas sin grant y validacion ----
  union all select * from pg_temp.t('gp viewer: falsear created_by', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geo_points(name,category,lat,lng,created_by) values ('p','extintor',-34.6,-58.4,'00000000-0000-0000-0000-0000000000aa')$q$)
  union all select * from pg_temp.t('gp viewer: falsear created_at', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geo_points(name,category,lat,lng,created_at) values ('p','extintor',-34.6,-58.4,now() + interval '1 day')$q$)
  union all select * from pg_temp.t('gp viewer: falsear updated_at', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geo_points(name,category,lat,lng,updated_at) values ('p','extintor',-34.6,-58.4,now() + interval '1 day')$q$)
  union all select * from pg_temp.t('gp viewer: falsear id', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geo_points(name,category,lat,lng,id) values ('p','extintor',-34.6,-58.4,gen_random_uuid())$q$)
  union all select * from pg_temp.t('gp viewer: INSERT con deleted_at (sin grant de insert)', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geo_points(name,category,lat,lng,deleted_at) values ('p','extintor',-34.6,-58.4,now())$q$)
  union all select * from pg_temp.t('gp viewer: UPDATE created_by (sin grant)', 'DENIED', 'authenticated', c.viewer, $q$update public.geo_points set created_by = '00000000-0000-0000-0000-0000000000aa' where id = 'dddddddd-0000-0000-0000-000000000001'$q$, c.seed_gp)
  union all select * from pg_temp.t('gp viewer: UPDATE updated_at (sin grant)', 'DENIED', 'authenticated', c.viewer, $q$update public.geo_points set updated_at = now() - interval '1 year' where id = 'dddddddd-0000-0000-0000-000000000001'$q$, c.seed_gp)
  union all select * from pg_temp.t('gp trigger: created_by/created_at se pisan', 'ALLOWED', 'postgres', '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000005","app_metadata":{"role":"viewer"}}', $q$do $b$ declare u uuid; c timestamptz; begin insert into public.geo_points(name,category,lat,lng,created_by,created_at) values ('p','extintor',-34.6,-58.4,'00000000-0000-0000-0000-0000000000aa', now() - interval '1 year') returning created_by, created_at into u, c; if u <> '00000000-0000-0000-0000-000000000005'::uuid or c < now() - interval '1 second' then raise exception 'no pisado: % %', u, c; end if; end $b$$q$)
  union all select * from pg_temp.t('gp trigger: deleted_at falsificado se pisa a now()', 'ALLOWED', 'postgres', c.viewer, $q$do $b$ declare d timestamptz; begin update public.geo_points set deleted_at = '2000-01-01' where id = 'dddddddd-0000-0000-0000-000000000001' returning deleted_at into d; if d is null or d < now() - interval '1 second' then raise exception 'deleted_at=%', d; end if; end $b$$q$, c.seed_gp)
  union all select * from pg_temp.t('gp trigger: JWT sin rol se rechaza (aun como postgres)', 'DENIED', 'postgres', c.norole, $q$insert into public.geo_points(name,category,lat,lng) values ('p','extintor',-34.6,-58.4)$q$)
  union all select * from pg_temp.t('gp trigger: UPDATE sin JWT (SQL Editor) permitido', 'ALLOWED', 'postgres', c.anon, $q$update public.geo_points set name = 'mantenimiento'$q$, c.seed_gp)
  union all select * from pg_temp.t('gp viewer: name vacio', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geo_points(name,category,lat,lng) values ('','extintor',-34.6,-58.4)$q$)
  union all select * from pg_temp.t('gp viewer: name 81 caracteres', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geo_points(name,category,lat,lng) values (repeat('a',81),'extintor',-34.6,-58.4)$q$)
  union all select * from pg_temp.t('gp viewer: category invalida', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geo_points(name,category,lat,lng) values ('p','bomba',-34.6,-58.4)$q$)
  union all select * from pg_temp.t('gp viewer: lat 91', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geo_points(name,category,lat,lng) values ('p','extintor',91,-58.4)$q$)
  union all select * from pg_temp.t('gp viewer: lat NaN', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geo_points(name,category,lat,lng) values ('p','extintor','NaN'::float8,-58.4)$q$)
  union all select * from pg_temp.t('gp viewer: lng 181', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geo_points(name,category,lat,lng) values ('p','extintor',-34.6,181)$q$)
  union all select * from pg_temp.t('gp viewer: lng -180 (limite)', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.geo_points(name,category,lat,lng) values ('p','extintor',-34.6,-180)$q$)
  union all select * from pg_temp.t('gp viewer: notes 500', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.geo_points(name,category,lat,lng,notes) values ('p','extintor',-34.6,-58.4,repeat('a',500))$q$)
  union all select * from pg_temp.t('gp viewer: notes 501', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geo_points(name,category,lat,lng,notes) values ('p','extintor',-34.6,-58.4,repeat('a',501))$q$)
  union all select * from pg_temp.t('gp viewer: notes con caracter de control', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geo_points(name,category,lat,lng,notes) values ('p','extintor',-34.6,-58.4,'a' || chr(7))$q$)
  union all select * from pg_temp.t('gp viewer: message 141', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geo_points(name,category,lat,lng,message) values ('p','extintor',-34.6,-58.4,repeat('a',141))$q$)
  union all select * from pg_temp.t('gp viewer: alarm invalida', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geo_points(name,category,lat,lng,alarm) values ('p','extintor',-34.6,-58.4,'bomba')$q$)
  union all select * from pg_temp.t('gp viewer: radio 5 (limite)', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.geo_points(name,category,lat,lng,alert_radius_m) values ('p','peligro',-34.6,-58.4,5)$q$)
  union all select * from pg_temp.t('gp viewer: radio 500 (limite)', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.geo_points(name,category,lat,lng,alert_radius_m) values ('p','peligro',-34.6,-58.4,500)$q$)
  union all select * from pg_temp.t('gp viewer: radio 4', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geo_points(name,category,lat,lng,alert_radius_m) values ('p','peligro',-34.6,-58.4,4)$q$)
  union all select * from pg_temp.t('gp viewer: radio 501', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geo_points(name,category,lat,lng,alert_radius_m) values ('p','peligro',-34.6,-58.4,501)$q$)
  union all select * from pg_temp.t('gp viewer: UPDATE radio 501', 'DENIED', 'authenticated', c.viewer, $q$update public.geo_points set alert_radius_m = 501 where id = 'dddddddd-0000-0000-0000-000000000001'$q$, c.seed_gp)
  -- ---- geo_points: rate limit 30 filas/min por usuario ----
  union all select * from pg_temp.t('gp viewer: 30 puntos/min', 'ALLOWED', 'authenticated', c.viewer, $q$do $b$ begin for i in 1..30 loop insert into public.geo_points(name,category,lat,lng) values ('p' || i,'extintor',-34.6,-58.4); end loop; end $b$$q$)
  union all select * from pg_temp.t('gp viewer: 31 puntos/min', 'DENIED', 'authenticated', c.viewer, $q$do $b$ begin for i in 1..31 loop insert into public.geo_points(name,category,lat,lng) values ('p' || i,'extintor',-34.6,-58.4); end loop; end $b$$q$)
  -- ---- geo: configuracion estatica y eventos de ubicacion ----
  union all select 'RLS activo en geofences', 'OK', case when (select relrowsecurity from pg_class where oid = 'public.geofences'::regclass) then 'OK' else 'BAD' end, ((select relrowsecurity from pg_class where oid = 'public.geofences'::regclass))
  union all select 'geofences: sin policy de DELETE/ALL', 'OK', case when not exists (select 1 from pg_policies where schemaname='public' and tablename='geofences' and cmd in ('DELETE','ALL')) then 'OK' else 'BAD' end, (not exists (select 1 from pg_policies where schemaname='public' and tablename='geofences' and cmd in ('DELETE','ALL')))
  union all select 'geofences: anon sin ningun privilegio', 'OK', case when not exists (select 1 from information_schema.role_table_grants where table_schema='public' and table_name='geofences' and grantee='anon') then 'OK' else 'BAD' end, (not exists (select 1 from information_schema.role_table_grants where table_schema='public' and table_name='geofences' and grantee='anon'))
  union all select 'geofences: authenticated sin DELETE ni TRUNCATE', 'OK', case when not has_table_privilege('authenticated','public.geofences','DELETE') and not has_table_privilege('authenticated','public.geofences','TRUNCATE') then 'OK' else 'BAD' end, (not has_table_privilege('authenticated','public.geofences','DELETE') and not has_table_privilege('authenticated','public.geofences','TRUNCATE'))
  union all select 'geofences: id/created_by/created_at/updated_at sin grant de escritura', 'OK', case when not (has_column_privilege('authenticated','public.geofences','id','INSERT') or has_column_privilege('authenticated','public.geofences','id','UPDATE') or has_column_privilege('authenticated','public.geofences','created_by','INSERT') or has_column_privilege('authenticated','public.geofences','created_by','UPDATE') or has_column_privilege('authenticated','public.geofences','created_at','INSERT') or has_column_privilege('authenticated','public.geofences','created_at','UPDATE') or has_column_privilege('authenticated','public.geofences','updated_at','INSERT') or has_column_privilege('authenticated','public.geofences','updated_at','UPDATE')) then 'OK' else 'BAD' end, (not (has_column_privilege('authenticated','public.geofences','id','INSERT') or has_column_privilege('authenticated','public.geofences','id','UPDATE') or has_column_privilege('authenticated','public.geofences','created_by','INSERT') or has_column_privilege('authenticated','public.geofences','created_by','UPDATE') or has_column_privilege('authenticated','public.geofences','created_at','INSERT') or has_column_privilege('authenticated','public.geofences','created_at','UPDATE') or has_column_privilege('authenticated','public.geofences','updated_at','INSERT') or has_column_privilege('authenticated','public.geofences','updated_at','UPDATE')))
  union all select 'geofences: en publicacion realtime', 'OK', case when exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='geofences') then 'OK' else 'BAD' end, (exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='geofences'))
  union all select 'RLS activo en geo_points', 'OK', case when (select relrowsecurity from pg_class where oid = 'public.geo_points'::regclass) then 'OK' else 'BAD' end, ((select relrowsecurity from pg_class where oid = 'public.geo_points'::regclass))
  union all select 'geo_points: sin policy de DELETE/ALL', 'OK', case when not exists (select 1 from pg_policies where schemaname='public' and tablename='geo_points' and cmd in ('DELETE','ALL')) then 'OK' else 'BAD' end, (not exists (select 1 from pg_policies where schemaname='public' and tablename='geo_points' and cmd in ('DELETE','ALL')))
  union all select 'geo_points: anon sin ningun privilegio', 'OK', case when not exists (select 1 from information_schema.role_table_grants where table_schema='public' and table_name='geo_points' and grantee='anon') then 'OK' else 'BAD' end, (not exists (select 1 from information_schema.role_table_grants where table_schema='public' and table_name='geo_points' and grantee='anon'))
  union all select 'geo_points: authenticated sin DELETE ni TRUNCATE', 'OK', case when not has_table_privilege('authenticated','public.geo_points','DELETE') and not has_table_privilege('authenticated','public.geo_points','TRUNCATE') then 'OK' else 'BAD' end, (not has_table_privilege('authenticated','public.geo_points','DELETE') and not has_table_privilege('authenticated','public.geo_points','TRUNCATE'))
  union all select 'geo_points: id/created_by/created_at/updated_at sin grant de escritura', 'OK', case when not (has_column_privilege('authenticated','public.geo_points','id','INSERT') or has_column_privilege('authenticated','public.geo_points','id','UPDATE') or has_column_privilege('authenticated','public.geo_points','created_by','INSERT') or has_column_privilege('authenticated','public.geo_points','created_by','UPDATE') or has_column_privilege('authenticated','public.geo_points','created_at','INSERT') or has_column_privilege('authenticated','public.geo_points','created_at','UPDATE') or has_column_privilege('authenticated','public.geo_points','updated_at','INSERT') or has_column_privilege('authenticated','public.geo_points','updated_at','UPDATE')) then 'OK' else 'BAD' end, (not (has_column_privilege('authenticated','public.geo_points','id','INSERT') or has_column_privilege('authenticated','public.geo_points','id','UPDATE') or has_column_privilege('authenticated','public.geo_points','created_by','INSERT') or has_column_privilege('authenticated','public.geo_points','created_by','UPDATE') or has_column_privilege('authenticated','public.geo_points','created_at','INSERT') or has_column_privilege('authenticated','public.geo_points','created_at','UPDATE') or has_column_privilege('authenticated','public.geo_points','updated_at','INSERT') or has_column_privilege('authenticated','public.geo_points','updated_at','UPDATE')))
  union all select 'geo_points: en publicacion realtime', 'OK', case when exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='geo_points') then 'OK' else 'BAD' end, (exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='geo_points'))
  union all select 'geofences: shape sin grant de UPDATE', 'OK', case when not has_column_privilege('authenticated','public.geofences','shape','UPDATE') and has_column_privilege('authenticated','public.geofences','shape','INSERT') then 'OK' else 'BAD' end, (not has_column_privilege('authenticated','public.geofences','shape','UPDATE') and has_column_privilege('authenticated','public.geofences','shape','INSERT'))
  union all select 'geofences y geo_points: deleted_at sin grant de INSERT', 'OK', case when not has_column_privilege('authenticated','public.geofences','deleted_at','INSERT') and not has_column_privilege('authenticated','public.geo_points','deleted_at','INSERT') then 'OK' else 'BAD' end, (not has_column_privilege('authenticated','public.geofences','deleted_at','INSERT') and not has_column_privilege('authenticated','public.geo_points','deleted_at','INSERT'))
  union all select 'events.type acepta location y geofence', 'OK', case when (select count(*) from regexp_matches((select pg_get_constraintdef(oid) from pg_constraint where conname='events_type_check' and conrelid='public.events'::regclass), '(location|geofence)', 'g')) = 2 then 'OK' else 'BAD' end, ((select count(*) from regexp_matches((select pg_get_constraintdef(oid) from pg_constraint where conname='events_type_check' and conrelid='public.events'::regclass), '(location|geofence)', 'g')) = 2)
  union all select 'events: indice (device_id,type,created_at) para recorridos', 'OK', case when exists (select 1 from pg_indexes where schemaname='public' and tablename='events' and indexdef ~ '\(device_id, type, created_at DESC\)') then 'OK' else 'BAD' end, (exists (select 1 from pg_indexes where schemaname='public' and tablename='events' and indexdef ~ '\(device_id, type, created_at DESC\)'))
  union all select * from pg_temp.t('events device: INSERT location con payload de recorrido', 'ALLOWED', 'authenticated', c.dev, $q$insert into public.events(device_id,type,lat,lng,battery,payload) values ('4132','location',-34.6,-58.4,80,'{"acc":8,"spd":1.2,"brg":90,"alt":12,"src":"gps","n":9}')$q$)
  union all select * from pg_temp.t('events device: INSERT location con lat fuera de rango', 'DENIED', 'authenticated', c.dev, $q$insert into public.events(device_id,type,lat,lng) values ('4132','location',95,-58.4)$q$)
  union all select * from pg_temp.t('events viewer: SELECT recorrido (location)', 'ALLOWED', 'authenticated', c.viewer, $q$select * from public.events where device_id='4132' and type='location' order by created_at desc$q$, $s$insert into public.events(device_id,type,lat,lng) values ('4132','location',-34.6,-58.4)$s$)
  -- ======================= Equipos (migracion 007) =======================
  -- ---- anon / sin rol ----
  union all select * from pg_temp.t('eq anon: SELECT groups', 'DENIED', 'anon', c.anon, $q$select * from public.groups$q$, c.seed_eq)
  union all select * from pg_temp.t('eq anon: SELECT people', 'DENIED', 'anon', c.anon, $q$select * from public.people$q$, c.seed_eq)
  union all select * from pg_temp.t('eq anon: SELECT assignments', 'DENIED', 'anon', c.anon, $q$select * from public.assignments$q$, c.seed_eq)
  union all select * from pg_temp.t('eq anon: SELECT group_members', 'DENIED', 'anon', c.anon, $q$select * from public.group_members$q$, c.seed_eq)
  union all select * from pg_temp.t('eq anon: SELECT devices_full', 'DENIED', 'anon', c.anon, $q$select * from public.devices_full$q$, c.seed_eq)
  union all select * from pg_temp.t('eq anon: SELECT people_full', 'DENIED', 'anon', c.anon, $q$select * from public.people_full$q$, c.seed_eq)
  union all select * from pg_temp.t('eq anon: SELECT devices', 'DENIED', 'anon', c.anon, $q$select device_id,name from public.devices$q$, c.seed_eq)
  union all select * from pg_temp.t('eq anon: INSERT devices', 'DENIED', 'anon', c.anon, $q$insert into public.devices(device_id,name) values ('5555','x')$q$)
  union all select * from pg_temp.t('eq sin rol: SELECT devices', 'DENIED', 'authenticated', c.norole, $q$select device_id,name from public.devices$q$, c.seed_eq)
  union all select * from pg_temp.t('eq sin rol: SELECT groups', 'DENIED', 'authenticated', c.norole, $q$select * from public.groups$q$, c.seed_eq)
  union all select * from pg_temp.t('eq sin rol: SELECT people', 'DENIED', 'authenticated', c.norole, $q$select id,full_name from public.people$q$, c.seed_eq)
  union all select * from pg_temp.t('eq sin rol: SELECT devices_full (0 filas)', 'DENIED', 'authenticated', c.norole, $q$select * from public.devices_full$q$, c.seed_eq)
  union all select * from pg_temp.t('eq sin rol: INSERT devices', 'DENIED', 'authenticated', c.norole, $q$insert into public.devices(device_id,name) values ('5555','x')$q$)
  union all select * from pg_temp.t('eq user_metadata falso: INSERT devices', 'DENIED', 'authenticated', c.usermeta, $q$insert into public.devices(device_id,name) values ('5555','x')$q$)
  -- ---- device: solo su fila de devices, sin imei ni SIM ----
  union all select * from pg_temp.t('eq device: SELECT su fila (columnas permitidas)', 'ALLOWED', 'authenticated', c.dev, $q$select device_id,name,model,group_id,sector,status from public.devices where device_id = '4132'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq device: SELECT fila ajena', 'DENIED', 'authenticated', c.dev, $q$select device_id,name from public.devices where device_id = '9999'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq device: ve exactamente 1 fila', 'ALLOWED', 'authenticated', c.dev, $q$do $b$ declare n int; begin select count(*) into n from public.devices; if n <> 1 then raise exception 've %', n; end if; end $b$$q$, c.seed_eq)
  union all select * from pg_temp.t('eq device: SELECT imei (sin grant)', 'DENIED', 'authenticated', c.dev, $q$select imei from public.devices where device_id = '4132'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq device: SELECT sim1_iccid (sin grant)', 'DENIED', 'authenticated', c.dev, $q$select sim1_iccid from public.devices where device_id = '4132'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq device: SELECT sim_line (sin grant)', 'DENIED', 'authenticated', c.dev, $q$select sim_line from public.devices where device_id = '4132'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq device: SELECT bt_headset_mac (sin grant)', 'DENIED', 'authenticated', c.dev, $q$select bt_headset_mac from public.devices where device_id = '4132'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq device: SELECT * (incluye columnas sin grant)', 'DENIED', 'authenticated', c.dev, $q$select * from public.devices$q$, c.seed_eq)
  union all select * from pg_temp.t('eq device sin claim device_id: SELECT', 'DENIED', 'authenticated', c.dev_noid, $q$select device_id,name from public.devices$q$, c.seed_eq)
  union all select * from pg_temp.t('eq device: SELECT devices_full', 'DENIED', 'authenticated', c.dev, $q$select * from public.devices_full$q$, c.seed_eq)
  union all select * from pg_temp.t('eq device: SELECT people_full', 'DENIED', 'authenticated', c.dev, $q$select * from public.people_full$q$, c.seed_eq)
  union all select * from pg_temp.t('eq device: SELECT groups', 'DENIED', 'authenticated', c.dev, $q$select * from public.groups$q$, c.seed_eq)
  union all select * from pg_temp.t('eq device: SELECT people', 'DENIED', 'authenticated', c.dev, $q$select id,full_name from public.people$q$, c.seed_eq)
  union all select * from pg_temp.t('eq device: SELECT assignments', 'DENIED', 'authenticated', c.dev, $q$select * from public.assignments$q$, c.seed_eq)
  union all select * from pg_temp.t('eq device: SELECT group_members', 'DENIED', 'authenticated', c.dev, $q$select * from public.group_members$q$, c.seed_eq)
  union all select * from pg_temp.t('eq device: INSERT devices', 'DENIED', 'authenticated', c.dev, $q$insert into public.devices(device_id,name) values ('5555','x')$q$)
  union all select * from pg_temp.t('eq device: UPDATE devices', 'DENIED', 'authenticated', c.dev, $q$update public.devices set name = 'x' where device_id = '4132'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq device: INSERT assignments', 'DENIED', 'authenticated', c.dev, $q$insert into public.assignments(device_id,person_id) values ('9999','b2b2b2b2-0000-0000-0000-000000000002')$q$, c.seed_eq)
  -- ---- viewer/admin: lectura y privacidad (dni / telefono / imei / SIM) ----
  union all select * from pg_temp.t('eq viewer: SELECT devices (columnas base)', 'ALLOWED', 'authenticated', c.viewer, $q$select device_id,name,model,group_id,sector,status,deleted_at from public.devices$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: SELECT imei de la tabla (sin grant)', 'DENIED', 'authenticated', c.viewer, $q$select imei from public.devices$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: SELECT sim de la tabla (sin grant)', 'DENIED', 'authenticated', c.viewer, $q$select sim1_iccid from public.devices$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: filtrar por imei (sin grant)', 'DENIED', 'authenticated', c.viewer, $q$select device_id from public.devices where imei = '866652020000001'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: SELECT devices_full', 'ALLOWED', 'authenticated', c.viewer, $q$select * from public.devices_full$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: SELECT devices_full', 'ALLOWED', 'authenticated', c.admin, $q$select * from public.devices_full$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: devices_full incluye imei', 'ALLOWED', 'authenticated', c.viewer, $q$do $b$ declare i text; begin select imei into i from public.devices_full where device_id='4132'; if i is distinct from '866652020000001' then raise exception 'imei=%', i; end if; end $b$$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: SELECT groups', 'ALLOWED', 'authenticated', c.viewer, $q$select * from public.groups$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: SELECT assignments', 'ALLOWED', 'authenticated', c.viewer, $q$select * from public.assignments$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: SELECT people (nombre, puesto, sector, grupo)', 'ALLOWED', 'authenticated', c.viewer, $q$select id,full_name,legajo,job_title,sector,group_id,active from public.people$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: SELECT dni (sin grant)', 'DENIED', 'authenticated', c.viewer, $q$select dni from public.people$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: SELECT contact_phone (sin grant)', 'DENIED', 'authenticated', c.viewer, $q$select contact_phone from public.people$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: filtrar por dni (sin grant)', 'DENIED', 'authenticated', c.viewer, $q$select id from public.people where dni = '12345678'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: SELECT * people (incluye dni)', 'DENIED', 'authenticated', c.viewer, $q$select * from public.people$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: people_full (0 filas, no es admin)', 'DENIED', 'authenticated', c.viewer, $q$select * from public.people_full$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: SELECT dni de la tabla (sin grant, va por la vista)', 'DENIED', 'authenticated', c.admin, $q$select dni from public.people$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: people_full', 'ALLOWED', 'authenticated', c.admin, $q$select * from public.people_full$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: people_full trae dni y telefono', 'ALLOWED', 'authenticated', c.admin, $q$do $b$ declare d text; t text; begin select dni, contact_phone into d, t from public.people_full where legajo='L001'; if d is distinct from '12345678' or t is distinct from '+5491100000000' then raise exception 'dni=% tel=%', d, t; end if; end $b$$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: group_members propios/ajenos (vacio)', 'DENIED', 'authenticated', c.viewer, $q$select * from public.group_members$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: INSERT group_members (sin grant)', 'DENIED', 'authenticated', c.viewer, $q$insert into public.group_members(user_id,group_id) values ('00000000-0000-0000-0000-000000000005','a1a1a1a1-0000-0000-0000-000000000001')$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: INSERT group_members (sin grant)', 'DENIED', 'authenticated', c.admin, $q$insert into public.group_members(user_id,group_id) values ('00000000-0000-0000-0000-000000000006','a1a1a1a1-0000-0000-0000-000000000001')$q$, c.seed_eq)
  union all select * from pg_temp.t('eq user_in_group: false si no es miembro', 'ALLOWED', 'authenticated', c.viewer, $q$do $b$ begin if public.user_in_group('a1a1a1a1-0000-0000-0000-000000000001') then raise exception 'miembro?'; end if; end $b$$q$, c.seed_eq)
  union all select * from pg_temp.t('eq user_in_group: anon sin EXECUTE', 'DENIED', 'anon', c.anon, $q$select public.user_in_group('a1a1a1a1-0000-0000-0000-000000000001')$q$)
  -- ---- altas y ediciones ----
  union all select * from pg_temp.t('eq viewer: INSERT grupo', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.groups(name,site,notes) values ('G nuevo','Locacion','n')$q$)
  union all select * from pg_temp.t('eq viewer: INSERT casco', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.devices(device_id,imei,name,model,status) values ('5555','866652020000099','Casco 5555','rd_aqm6816','activo')$q$)
  union all select * from pg_temp.t('eq viewer: INSERT casco con group_id', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.devices(device_id,name,group_id) values ('5555','Casco 5555','a1a1a1a1-0000-0000-0000-000000000001')$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: INSERT casco', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.devices(device_id,name) values ('5555','Casco 5555')$q$)
  union all select * from pg_temp.t('eq viewer: INSERT persona sin dni', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.people(full_name,legajo,job_title,sector) values ('Persona Nueva','L100','Operador','S1')$q$)
  union all select * from pg_temp.t('eq viewer: INSERT persona con dni (solo admin)', 'DENIED', 'authenticated', c.viewer, $q$insert into public.people(full_name,dni) values ('Persona Nueva','11111111')$q$)
  union all select * from pg_temp.t('eq viewer: INSERT persona con telefono (solo admin)', 'DENIED', 'authenticated', c.viewer, $q$insert into public.people(full_name,contact_phone) values ('Persona Nueva','+5491100000000')$q$)
  union all select * from pg_temp.t('eq admin: INSERT persona con dni y telefono', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.people(full_name,dni,contact_phone) values ('Persona Nueva','11111111','+5491100000000')$q$)
  union all select * from pg_temp.t('eq viewer: UPDATE dni (solo admin)', 'DENIED', 'authenticated', c.viewer, $q$update public.people set dni = '99999999' where id = 'b2b2b2b2-0000-0000-0000-000000000001'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: UPDATE contact_phone (solo admin)', 'DENIED', 'authenticated', c.viewer, $q$update public.people set contact_phone = '+541100000000' where id = 'b2b2b2b2-0000-0000-0000-000000000001'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: UPDATE dni', 'ALLOWED', 'authenticated', c.admin, $q$update public.people set dni = '99999999' where id = 'b2b2b2b2-0000-0000-0000-000000000001'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: UPDATE nombre/puesto/sector/grupo', 'ALLOWED', 'authenticated', c.viewer, $q$update public.people set full_name='Otro', job_title='Jefe', sector='S2', group_id='a1a1a1a1-0000-0000-0000-000000000001' where id = 'b2b2b2b2-0000-0000-0000-000000000002'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: UPDATE persona con dni sin tocarlo', 'ALLOWED', 'authenticated', c.viewer, $q$update public.people set job_title='Jefe' where id = 'b2b2b2b2-0000-0000-0000-000000000001'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: UPDATE casco (name, sector, SIM, estado)', 'ALLOWED', 'authenticated', c.viewer, $q$update public.devices set name='Nuevo', sector='S9', sim2_iccid='8954000000000000002', status='mantenimiento' where device_id = '4132'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: UPDATE imei', 'ALLOWED', 'authenticated', c.viewer, $q$update public.devices set imei = '866652020000050' where device_id = '4132'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: UPDATE device_id (sin grant)', 'DENIED', 'authenticated', c.viewer, $q$update public.devices set device_id = '1111' where device_id = '4132'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: UPDATE group name', 'ALLOWED', 'authenticated', c.viewer, $q$update public.groups set name = 'Renombrado' where id = 'a1a1a1a1-0000-0000-0000-000000000001'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq trigger: device_id inmutable aun como postgres con JWT', 'DENIED', 'postgres', c.viewer, $q$update public.devices set device_id = '1111' where device_id = '4132'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: baja logica de casco', 'ALLOWED', 'authenticated', c.viewer, $q$update public.devices set deleted_at = now() where device_id = '9999'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: baja logica de persona', 'ALLOWED', 'authenticated', c.viewer, $q$update public.people set deleted_at = now() where id = 'b2b2b2b2-0000-0000-0000-000000000002'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: baja logica de grupo', 'ALLOWED', 'authenticated', c.viewer, $q$update public.groups set deleted_at = now() where id = 'a1a1a1a1-0000-0000-0000-000000000001'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: UPDATE casco dado de baja (congelado)', 'DENIED', 'authenticated', c.viewer, $q$update public.devices set deleted_at = now() where device_id = '9999'$q$, $s$do $d$ begin perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000009","app_metadata":{"role":"viewer"}}',true); insert into public.devices(device_id,name) values ('9999','x'); update public.devices set deleted_at = now(); end $d$$s$)
  union all select * from pg_temp.t('eq viewer: DELETE devices (sin grant)', 'DENIED', 'authenticated', c.viewer, $q$delete from public.devices$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: DELETE people (sin grant)', 'DENIED', 'authenticated', c.admin, $q$delete from public.people$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: DELETE groups (sin grant)', 'DENIED', 'authenticated', c.admin, $q$delete from public.groups$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: DELETE assignments (sin grant)', 'DENIED', 'authenticated', c.admin, $q$delete from public.assignments$q$, c.seed_eq)
  -- ---- campos del servidor y validacion ----
  union all select * from pg_temp.t('eq viewer: falsear created_by (casco)', 'DENIED', 'authenticated', c.viewer, $q$insert into public.devices(device_id,name,created_by) values ('5555','x','00000000-0000-0000-0000-0000000000aa')$q$)
  union all select * from pg_temp.t('eq viewer: falsear created_at (persona)', 'DENIED', 'authenticated', c.viewer, $q$insert into public.people(full_name,created_at) values ('x', now() + interval '1 day')$q$)
  union all select * from pg_temp.t('eq viewer: falsear updated_at (grupo)', 'DENIED', 'authenticated', c.viewer, $q$insert into public.groups(name,updated_at) values ('x', now() + interval '1 day')$q$)
  union all select * from pg_temp.t('eq viewer: INSERT con deleted_at (sin grant de insert)', 'DENIED', 'authenticated', c.viewer, $q$insert into public.devices(device_id,name,deleted_at) values ('5555','x',now())$q$)
  union all select * from pg_temp.t('eq trigger: created_by/created_at se pisan (casco)', 'ALLOWED', 'postgres', '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000005","app_metadata":{"role":"viewer"}}', $q$do $b$ declare u uuid; c timestamptz; begin insert into public.devices(device_id,name,created_by,created_at) values ('5555','x','00000000-0000-0000-0000-0000000000aa', now() - interval '1 year') returning created_by, created_at into u, c; if u <> '00000000-0000-0000-0000-000000000005'::uuid or c < now() - interval '1 second' then raise exception 'no pisado: % %', u, c; end if; end $b$$q$)
  union all select * from pg_temp.t('eq trigger: JWT sin rol se rechaza (aun como postgres)', 'DENIED', 'postgres', c.norole, $q$insert into public.devices(device_id,name) values ('5555','x')$q$)
  union all select * from pg_temp.t('eq trigger: UPDATE sin JWT (SQL Editor) permitido', 'ALLOWED', 'postgres', c.anon, $q$update public.devices set name = 'mantenimiento' where device_id = '4132'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: device_id con HTML', 'DENIED', 'authenticated', c.viewer, $q$insert into public.devices(device_id,name) values ('<b>','x')$q$)
  union all select * from pg_temp.t('eq viewer: device_id vacio', 'DENIED', 'authenticated', c.viewer, $q$insert into public.devices(device_id,name) values ('','x')$q$)
  union all select * from pg_temp.t('eq viewer: device_id duplicado', 'DENIED', 'authenticated', c.viewer, $q$insert into public.devices(device_id,name) values ('4132','x')$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: imei 14 digitos', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.devices(device_id,name,imei) values ('5555','x','86665202000009')$q$)
  union all select * from pg_temp.t('eq viewer: imei 13 digitos', 'DENIED', 'authenticated', c.viewer, $q$insert into public.devices(device_id,name,imei) values ('5555','x','8666520200000')$q$)
  union all select * from pg_temp.t('eq viewer: imei con letras', 'DENIED', 'authenticated', c.viewer, $q$insert into public.devices(device_id,name,imei) values ('5555','x','86665202XXXXXXX')$q$)
  union all select * from pg_temp.t('eq viewer: imei duplicado', 'DENIED', 'authenticated', c.viewer, $q$insert into public.devices(device_id,name,imei) values ('5555','x','866652020000001')$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: iccid invalido', 'DENIED', 'authenticated', c.viewer, $q$insert into public.devices(device_id,name,sim1_iccid) values ('5555','x','12345')$q$)
  union all select * from pg_temp.t('eq viewer: sim_line invalida', 'DENIED', 'authenticated', c.viewer, $q$insert into public.devices(device_id,name,sim_line) values ('5555','x','abc')$q$)
  union all select * from pg_temp.t('eq viewer: bt_headset_mac valida', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.devices(device_id,name,bt_headset_mac) values ('5555','x','AA:BB:CC:DD:EE:FF')$q$)
  union all select * from pg_temp.t('eq viewer: bt_headset_mac invalida', 'DENIED', 'authenticated', c.viewer, $q$insert into public.devices(device_id,name,bt_headset_mac) values ('5555','x','AABBCCDDEEFF')$q$)
  union all select * from pg_temp.t('eq viewer: status invalido', 'DENIED', 'authenticated', c.viewer, $q$insert into public.devices(device_id,name,status) values ('5555','x','roto')$q$)
  union all select * from pg_temp.t('eq viewer: name vacio', 'DENIED', 'authenticated', c.viewer, $q$insert into public.devices(device_id,name) values ('5555','')$q$)
  union all select * from pg_temp.t('eq viewer: name > 80', 'DENIED', 'authenticated', c.viewer, $q$insert into public.devices(device_id,name) values ('5555',repeat('a',81))$q$)
  union all select * from pg_temp.t('eq viewer: group_id inexistente', 'DENIED', 'authenticated', c.viewer, $q$insert into public.devices(device_id,name,group_id) values ('5555','x','a1a1a1a1-0000-0000-0000-0000000000ff')$q$)
  union all select * from pg_temp.t('eq viewer: notes 501', 'DENIED', 'authenticated', c.viewer, $q$insert into public.devices(device_id,name,notes) values ('5555','x',repeat('a',501))$q$)
  union all select * from pg_temp.t('eq viewer: modelo por defecto rd_aqm6816', 'ALLOWED', 'postgres', c.viewer, $q$do $b$ declare m text; begin insert into public.devices(device_id,name) values ('5555','x') returning model into m; if m <> 'rd_aqm6816' then raise exception 'model=%', m; end if; end $b$$q$)
  union all select * from pg_temp.t('eq viewer: full_name vacio', 'DENIED', 'authenticated', c.viewer, $q$insert into public.people(full_name) values ('')$q$)
  union all select * from pg_temp.t('eq viewer: full_name 121', 'DENIED', 'authenticated', c.viewer, $q$insert into public.people(full_name) values (repeat('a',121))$q$)
  union all select * from pg_temp.t('eq viewer: legajo duplicado', 'DENIED', 'authenticated', c.viewer, $q$insert into public.people(full_name,legajo) values ('x','L001')$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: legajo con espacios', 'DENIED', 'authenticated', c.viewer, $q$insert into public.people(full_name,legajo) values ('x','L 1')$q$)
  union all select * from pg_temp.t('eq admin: dni invalido', 'DENIED', 'authenticated', c.admin, $q$insert into public.people(full_name,dni) values ('x','12 34')$q$)
  union all select * from pg_temp.t('eq admin: telefono invalido', 'DENIED', 'authenticated', c.admin, $q$insert into public.people(full_name,contact_phone) values ('x','abc')$q$)
  union all select * from pg_temp.t('eq viewer: nombre de grupo duplicado (sin distinguir mayusculas)', 'DENIED', 'authenticated', c.viewer, $q$insert into public.groups(name) values ('grupo a')$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: nombre de grupo vacio', 'DENIED', 'authenticated', c.viewer, $q$insert into public.groups(name) values ('  ')$q$)
  -- ---- assignments ----
  union all select * from pg_temp.t('as viewer: asignar casco libre a persona libre', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.assignments(device_id,person_id) values ('9999','b2b2b2b2-0000-0000-0000-000000000002')$q$, c.seed_eq)
  union all select * from pg_temp.t('as admin: asignar', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.assignments(device_id,person_id) values ('9999','b2b2b2b2-0000-0000-0000-000000000002')$q$, c.seed_eq)
  union all select * from pg_temp.t('as viewer: nueva asignacion cierra la anterior del casco', 'ALLOWED', 'authenticated', c.viewer, $q$do $b$ declare n int; c int; begin insert into public.assignments(device_id,person_id) values ('4132','b2b2b2b2-0000-0000-0000-000000000002'); select count(*) into n from public.assignments where device_id='4132' and ends_at is null; select count(*) into c from public.assignments where device_id='4132' and ends_at is not null; if n <> 1 or c <> 1 then raise exception 'abiertas=% cerradas=%', n, c; end if; end $b$$q$, c.seed_eq)
  union all select * from pg_temp.t('as viewer: nueva asignacion cierra la anterior de la persona', 'ALLOWED', 'authenticated', c.viewer, $q$do $b$ declare n int; begin insert into public.assignments(device_id,person_id) values ('9999','b2b2b2b2-0000-0000-0000-000000000001'); select count(*) into n from public.assignments where person_id='b2b2b2b2-0000-0000-0000-000000000001' and ends_at is null; if n <> 1 then raise exception 'abiertas=%', n; end if; if exists (select 1 from public.assignments where device_id='4132' and ends_at is null) then raise exception '4132 sigue abierta'; end if; end $b$$q$, c.seed_eq)
  union all select * from pg_temp.t('as viewer: casco dado de baja (status baja)', 'DENIED', 'authenticated', c.viewer, $q$insert into public.assignments(device_id,person_id) values ('7777','b2b2b2b2-0000-0000-0000-000000000002')$q$, c.seed_eq)
  union all select * from pg_temp.t('as viewer: persona inactiva', 'DENIED', 'authenticated', c.viewer, $q$insert into public.assignments(device_id,person_id) values ('9999','b2b2b2b2-0000-0000-0000-000000000003')$q$, c.seed_eq)
  union all select * from pg_temp.t('as viewer: casco inexistente', 'DENIED', 'authenticated', c.viewer, $q$insert into public.assignments(device_id,person_id) values ('0000','b2b2b2b2-0000-0000-0000-000000000002')$q$, c.seed_eq)
  union all select * from pg_temp.t('as viewer: persona inexistente', 'DENIED', 'authenticated', c.viewer, $q$insert into public.assignments(device_id,person_id) values ('9999','b2b2b2b2-0000-0000-0000-0000000000ff')$q$, c.seed_eq)
  union all select * from pg_temp.t('as viewer: falsear starts_at (sin grant)', 'DENIED', 'authenticated', c.viewer, $q$insert into public.assignments(device_id,person_id,starts_at) values ('9999','b2b2b2b2-0000-0000-0000-000000000002', now() - interval '1 year')$q$, c.seed_eq)
  union all select * from pg_temp.t('as viewer: falsear created_by (sin grant)', 'DENIED', 'authenticated', c.viewer, $q$insert into public.assignments(device_id,person_id,created_by) values ('9999','b2b2b2b2-0000-0000-0000-000000000002','00000000-0000-0000-0000-0000000000aa')$q$, c.seed_eq)
  union all select * from pg_temp.t('as viewer: cerrar asignacion (ends_at)', 'ALLOWED', 'authenticated', c.viewer, $q$update public.assignments set ends_at = now()$q$, c.seed_eq)
  union all select * from pg_temp.t('as viewer: ends_at lo fija el servidor', 'ALLOWED', 'postgres', c.viewer, $q$do $b$ declare e timestamptz; begin update public.assignments set ends_at = '2000-01-01' returning ends_at into e; if e < now() - interval '1 second' then raise exception 'ends_at=%', e; end if; end $b$$q$, c.seed_eq)
  union all select * from pg_temp.t('as viewer: reabrir asignacion cerrada', 'DENIED', 'authenticated', c.viewer, $q$update public.assignments set ends_at = null$q$, c.seed_eq_closed)
  union all select * from pg_temp.t('as viewer: UPDATE de asignacion cerrada', 'DENIED', 'authenticated', c.viewer, $q$update public.assignments set ends_at = now()$q$, c.seed_eq_closed)
  union all select * from pg_temp.t('as viewer: UPDATE device_id (sin grant)', 'DENIED', 'authenticated', c.viewer, $q$update public.assignments set device_id = '9999'$q$, c.seed_eq)
  union all select * from pg_temp.t('as trigger: JWT sin rol se rechaza (aun como postgres)', 'DENIED', 'postgres', c.norole, $q$insert into public.assignments(device_id,person_id) values ('9999','b2b2b2b2-0000-0000-0000-000000000002')$q$, c.seed_eq)
  union all select * from pg_temp.t('as indice unico: dos abiertas del mismo casco (insercion directa sin trigger)', 'DENIED', 'postgres', c.anon, $q$do $b$ begin alter table public.assignments disable trigger assignments_guard_trg; insert into public.assignments(device_id,person_id,created_by) values ('4132','b2b2b2b2-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000009'); end $b$$q$, c.seed_eq)
  -- ---- rate limit 30 filas/min por usuario ----
  union all select * from pg_temp.t('eq viewer: 30 cascos/min', 'ALLOWED', 'authenticated', c.viewer, $q$do $b$ begin for i in 1..30 loop insert into public.devices(device_id,name) values ('d' || i,'x'); end loop; end $b$$q$)
  union all select * from pg_temp.t('eq viewer: 31 cascos/min', 'DENIED', 'authenticated', c.viewer, $q$do $b$ begin for i in 1..31 loop insert into public.devices(device_id,name) values ('d' || i,'x'); end loop; end $b$$q$)
  union all select * from pg_temp.t('eq viewer: 31 personas/min', 'DENIED', 'authenticated', c.viewer, $q$do $b$ begin for i in 1..31 loop insert into public.people(full_name) values ('p' || i); end loop; end $b$$q$)
  union all select * from pg_temp.t('eq viewer: 31 grupos/min', 'DENIED', 'authenticated', c.viewer, $q$do $b$ begin for i in 1..31 loop insert into public.groups(name) values ('g' || i); end loop; end $b$$q$)
  -- ---- configuracion estatica ----
  union all select 'RLS activo en groups', 'OK', case when (select relrowsecurity from pg_class where oid = 'public.groups'::regclass) then 'OK' else 'BAD' end, ((select relrowsecurity from pg_class where oid = 'public.groups'::regclass))
  union all select 'groups: sin policy de DELETE/ALL', 'OK', case when not exists (select 1 from pg_policies where schemaname='public' and tablename='groups' and cmd in ('DELETE','ALL')) then 'OK' else 'BAD' end, (not exists (select 1 from pg_policies where schemaname='public' and tablename='groups' and cmd in ('DELETE','ALL')))
  union all select 'groups: anon sin privilegios', 'OK', case when not exists (select 1 from information_schema.role_table_grants where table_schema='public' and table_name='groups' and grantee='anon') then 'OK' else 'BAD' end, (not exists (select 1 from information_schema.role_table_grants where table_schema='public' and table_name='groups' and grantee='anon'))
  union all select 'groups: authenticated sin DELETE/TRUNCATE', 'OK', case when not has_table_privilege('authenticated','public.groups','DELETE') and not has_table_privilege('authenticated','public.groups','TRUNCATE') then 'OK' else 'BAD' end, (not has_table_privilege('authenticated','public.groups','DELETE') and not has_table_privilege('authenticated','public.groups','TRUNCATE'))
  union all select 'RLS activo en devices', 'OK', case when (select relrowsecurity from pg_class where oid = 'public.devices'::regclass) then 'OK' else 'BAD' end, ((select relrowsecurity from pg_class where oid = 'public.devices'::regclass))
  union all select 'devices: sin policy de DELETE/ALL', 'OK', case when not exists (select 1 from pg_policies where schemaname='public' and tablename='devices' and cmd in ('DELETE','ALL')) then 'OK' else 'BAD' end, (not exists (select 1 from pg_policies where schemaname='public' and tablename='devices' and cmd in ('DELETE','ALL')))
  union all select 'devices: anon sin privilegios', 'OK', case when not exists (select 1 from information_schema.role_table_grants where table_schema='public' and table_name='devices' and grantee='anon') then 'OK' else 'BAD' end, (not exists (select 1 from information_schema.role_table_grants where table_schema='public' and table_name='devices' and grantee='anon'))
  union all select 'devices: authenticated sin DELETE/TRUNCATE', 'OK', case when not has_table_privilege('authenticated','public.devices','DELETE') and not has_table_privilege('authenticated','public.devices','TRUNCATE') then 'OK' else 'BAD' end, (not has_table_privilege('authenticated','public.devices','DELETE') and not has_table_privilege('authenticated','public.devices','TRUNCATE'))
  union all select 'RLS activo en people', 'OK', case when (select relrowsecurity from pg_class where oid = 'public.people'::regclass) then 'OK' else 'BAD' end, ((select relrowsecurity from pg_class where oid = 'public.people'::regclass))
  union all select 'people: sin policy de DELETE/ALL', 'OK', case when not exists (select 1 from pg_policies where schemaname='public' and tablename='people' and cmd in ('DELETE','ALL')) then 'OK' else 'BAD' end, (not exists (select 1 from pg_policies where schemaname='public' and tablename='people' and cmd in ('DELETE','ALL')))
  union all select 'people: anon sin privilegios', 'OK', case when not exists (select 1 from information_schema.role_table_grants where table_schema='public' and table_name='people' and grantee='anon') then 'OK' else 'BAD' end, (not exists (select 1 from information_schema.role_table_grants where table_schema='public' and table_name='people' and grantee='anon'))
  union all select 'people: authenticated sin DELETE/TRUNCATE', 'OK', case when not has_table_privilege('authenticated','public.people','DELETE') and not has_table_privilege('authenticated','public.people','TRUNCATE') then 'OK' else 'BAD' end, (not has_table_privilege('authenticated','public.people','DELETE') and not has_table_privilege('authenticated','public.people','TRUNCATE'))
  union all select 'RLS activo en assignments', 'OK', case when (select relrowsecurity from pg_class where oid = 'public.assignments'::regclass) then 'OK' else 'BAD' end, ((select relrowsecurity from pg_class where oid = 'public.assignments'::regclass))
  union all select 'assignments: sin policy de DELETE/ALL', 'OK', case when not exists (select 1 from pg_policies where schemaname='public' and tablename='assignments' and cmd in ('DELETE','ALL')) then 'OK' else 'BAD' end, (not exists (select 1 from pg_policies where schemaname='public' and tablename='assignments' and cmd in ('DELETE','ALL')))
  union all select 'assignments: anon sin privilegios', 'OK', case when not exists (select 1 from information_schema.role_table_grants where table_schema='public' and table_name='assignments' and grantee='anon') then 'OK' else 'BAD' end, (not exists (select 1 from information_schema.role_table_grants where table_schema='public' and table_name='assignments' and grantee='anon'))
  union all select 'assignments: authenticated sin DELETE/TRUNCATE', 'OK', case when not has_table_privilege('authenticated','public.assignments','DELETE') and not has_table_privilege('authenticated','public.assignments','TRUNCATE') then 'OK' else 'BAD' end, (not has_table_privilege('authenticated','public.assignments','DELETE') and not has_table_privilege('authenticated','public.assignments','TRUNCATE'))
  union all select 'RLS activo en group_members', 'OK', case when (select relrowsecurity from pg_class where oid = 'public.group_members'::regclass) then 'OK' else 'BAD' end, ((select relrowsecurity from pg_class where oid = 'public.group_members'::regclass))
  union all select 'group_members: sin policy de DELETE/ALL', 'OK', case when not exists (select 1 from pg_policies where schemaname='public' and tablename='group_members' and cmd in ('DELETE','ALL')) then 'OK' else 'BAD' end, (not exists (select 1 from pg_policies where schemaname='public' and tablename='group_members' and cmd in ('DELETE','ALL')))
  union all select 'group_members: anon sin privilegios', 'OK', case when not exists (select 1 from information_schema.role_table_grants where table_schema='public' and table_name='group_members' and grantee='anon') then 'OK' else 'BAD' end, (not exists (select 1 from information_schema.role_table_grants where table_schema='public' and table_name='group_members' and grantee='anon'))
  union all select 'group_members: authenticated sin DELETE/TRUNCATE', 'OK', case when not has_table_privilege('authenticated','public.group_members','DELETE') and not has_table_privilege('authenticated','public.group_members','TRUNCATE') then 'OK' else 'BAD' end, (not has_table_privilege('authenticated','public.group_members','DELETE') and not has_table_privilege('authenticated','public.group_members','TRUNCATE'))
  union all select 'devices_full: anon sin privilegios', 'OK', case when not has_table_privilege('anon','public.devices_full','SELECT') then 'OK' else 'BAD' end, (not has_table_privilege('anon','public.devices_full','SELECT'))
  union all select 'people_full: anon sin privilegios', 'OK', case when not has_table_privilege('anon','public.people_full','SELECT') then 'OK' else 'BAD' end, (not has_table_privilege('anon','public.people_full','SELECT'))
  union all select 'devices: columnas sensibles sin SELECT para authenticated', 'OK', case when not (has_column_privilege('authenticated','public.devices','imei','SELECT') or has_column_privilege('authenticated','public.devices','sim1_iccid','SELECT') or has_column_privilege('authenticated','public.devices','sim2_iccid','SELECT') or has_column_privilege('authenticated','public.devices','sim_line','SELECT') or has_column_privilege('authenticated','public.devices','bt_headset_mac','SELECT') or has_column_privilege('authenticated','public.devices','notes','SELECT') or has_column_privilege('authenticated','public.devices','created_by','SELECT')) then 'OK' else 'BAD' end, (not (has_column_privilege('authenticated','public.devices','imei','SELECT') or has_column_privilege('authenticated','public.devices','sim1_iccid','SELECT') or has_column_privilege('authenticated','public.devices','sim2_iccid','SELECT') or has_column_privilege('authenticated','public.devices','sim_line','SELECT') or has_column_privilege('authenticated','public.devices','bt_headset_mac','SELECT') or has_column_privilege('authenticated','public.devices','notes','SELECT') or has_column_privilege('authenticated','public.devices','created_by','SELECT')))
  union all select 'people: dni y contact_phone sin SELECT para authenticated', 'OK', case when not has_column_privilege('authenticated','public.people','dni','SELECT') and not has_column_privilege('authenticated','public.people','contact_phone','SELECT') then 'OK' else 'BAD' end, (not has_column_privilege('authenticated','public.people','dni','SELECT') and not has_column_privilege('authenticated','public.people','contact_phone','SELECT'))
  union all select 'devices: device_id sin grant de UPDATE', 'OK', case when not has_column_privilege('authenticated','public.devices','device_id','UPDATE') and has_column_privilege('authenticated','public.devices','device_id','INSERT') then 'OK' else 'BAD' end, (not has_column_privilege('authenticated','public.devices','device_id','UPDATE') and has_column_privilege('authenticated','public.devices','device_id','INSERT'))
  union all select 'assignments: solo ends_at es actualizable', 'OK', case when has_column_privilege('authenticated','public.assignments','ends_at','UPDATE') and not has_column_privilege('authenticated','public.assignments','device_id','UPDATE') and not has_column_privilege('authenticated','public.assignments','starts_at','UPDATE') and not has_column_privilege('authenticated','public.assignments','starts_at','INSERT') then 'OK' else 'BAD' end, (has_column_privilege('authenticated','public.assignments','ends_at','UPDATE') and not has_column_privilege('authenticated','public.assignments','device_id','UPDATE') and not has_column_privilege('authenticated','public.assignments','starts_at','UPDATE') and not has_column_privilege('authenticated','public.assignments','starts_at','INSERT'))
  union all select 'devices y assignments en publicacion realtime', 'OK', case when (select count(*) from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename in ('devices','assignments')) = 2 then 'OK' else 'BAD' end, ((select count(*) from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename in ('devices','assignments')) = 2)
  union all select 'assignments: indices unicos de asignacion abierta', 'OK', case when (select count(*) from pg_indexes where schemaname='public' and indexname in ('assignments_open_device_uq','assignments_open_person_uq')) = 2 then 'OK' else 'BAD' end, ((select count(*) from pg_indexes where schemaname='public' and indexname in ('assignments_open_device_uq','assignments_open_person_uq')) = 2)
  union all select 'user_in_group: SECURITY DEFINER y sin EXECUTE para anon', 'OK', case when (select prosecdef from pg_proc where oid = 'public.user_in_group(uuid)'::regprocedure) and not has_function_privilege('anon','public.user_in_group(uuid)','EXECUTE') then 'OK' else 'BAD' end, ((select prosecdef from pg_proc where oid = 'public.user_in_group(uuid)'::regprocedure) and not has_function_privilege('anon','public.user_in_group(uuid)','EXECUTE'))
  -- ============================ configuracion ============================
  union all select 'bucket privado, con limite de tamano y mime', 'OK',
            (select case when not public and file_size_limit is not null and allowed_mime_types is not null
                         then 'OK' else 'BAD' end from storage.buckets where id = 'casco-media'),
            coalesce((select (not public and file_size_limit is not null and allowed_mime_types is not null)
                      from storage.buckets where id = 'casco-media'), false)
  union all select 'RLS activo en events', 'OK',
            (select case when relrowsecurity then 'OK' else 'BAD' end from pg_class where oid = 'public.events'::regclass),
            (select relrowsecurity from pg_class where oid = 'public.events'::regclass)
  union all select 'events en publicacion realtime', 'OK',
            case when exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='events') then 'OK' else 'BAD' end,
            exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='events')
) r
order by r.ok, r.test;  -- los fallos (ok=false) aparecen primero

-- Para depurar un caso puntual, repetirlo a mano:
--   begin;
--   select set_config('request.jwt.claims',
--     '{"role":"authenticated","app_metadata":{"role":"device","device_id":"4132"}}', true);
--   set local role authenticated;
--   insert into public.events(device_id,type) values ('9999','sos');  -- debe fallar (RLS)
--   rollback;
