-- Pruebas de RLS / Storage para Casco Inteligente.
-- USO: Supabase > SQL Editor > pegar TODO > Run. Es solo lectura neta: cada caso corre
-- en una subtransaccion que se revierte (no deja filas ni objetos).
-- Resultado: una tabla con columnas test | expected | got | ok. TODAS deben ser ok = true.
-- Requiere haber ejecutado antes supabase/schema.sql y migrations/002 a 010 (o ejecutar-todo.sql).
-- Desde la migracion 010 solo role='admin' escribe devices/people/groups/assignments/geofences/geo_points/device_config
-- y manda evacuacion; los casos 'viewer' de esas tablas esperan DENIED.
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
       perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000009","app_metadata":{"role":"admin"}}',true);
       insert into public.geofences(id,name,kind,shape,geometry,device_ids,active) values
         ('99999999-0000-0000-0000-000000000001','global','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}',null,true),
         ('99999999-0000-0000-0000-000000000002','solo 4132','permitida','polygon','{"points":[[-34.60,-58.40],[-34.61,-58.40],[-34.61,-58.41]]}','{4132}',true),
         ('99999999-0000-0000-0000-000000000003','solo 9999','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}','{9999}',true),
         ('99999999-0000-0000-0000-000000000004','inactiva','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}',null,false),
         ('99999999-0000-0000-0000-000000000005','de baja','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}',null,true);
       update public.geofences set deleted_at = now() where id = '99999999-0000-0000-0000-000000000005';
     end $d$$s$ as seed_gf,
  $s$do $d$ begin
       perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000009","app_metadata":{"role":"admin"}}',true);
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
     end $d$s$ as seed_eq_closed
  ,
  -- Tanda 4 (migracion 010). Comandos c0c0c0c0..01 (4132, photo), ..02 (9999, ping), ..03 (4132, vencido: 15 min),
  -- ..04 (7777, casco de baja). Config: 4132 y 9999. Eventos eeeeeeee..11 sos (atendido, tta 90 s), ..12 geocerca
  -- restringida/enter, ..13 geocerca informativa, ..14 heartbeat, ..15 not_worn. dev_baja = JWT del casco 7777.
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000007","app_metadata":{"role":"device","device_id":"7777"}}'::text as dev_baja,
  $s$do $d$ begin
       perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000009","email":"seed@test.local","app_metadata":{"role":"viewer"}}',true);
       insert into public.device_commands(id,device_id,action) values
         ('c0c0c0c0-0000-0000-0000-000000000001','4132','photo'),
         ('c0c0c0c0-0000-0000-0000-000000000002','9999','ping');
     end $d$s$ as seed_dc,
  $s$do $d$ begin
       perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000009","email":"seed@test.local","app_metadata":{"role":"viewer"}}',true);
       insert into public.device_commands(id,device_id,action) values
         ('c0c0c0c0-0000-0000-0000-000000000003','4132','ping');
       update public.device_commands set created_at = now() - interval '15 minutes'
         where id = 'c0c0c0c0-0000-0000-0000-000000000003';
     end $d$s$ as seed_dc_old,
  $s$do $d$ begin
       perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000009","email":"seed@test.local","app_metadata":{"role":"viewer"}}',true);
       insert into public.device_commands(id,device_id,action) values
         ('c0c0c0c0-0000-0000-0000-000000000001','4132','photo');
       insert into public.device_command_acks(command_id,device_id,ok,detail)
         values ('c0c0c0c0-0000-0000-0000-000000000001','4132',true,'foto subida');
     end $d$s$ as seed_dack,
  $s$do $d$ begin
       perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000009","app_metadata":{"role":"admin"}}',true);
       insert into public.devices(device_id,name,status) values ('7777','Casco 7777','baja');
       perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000009","email":"seed@test.local","app_metadata":{"role":"viewer"}}',true);
       insert into public.device_commands(id,device_id,action) values
         ('c0c0c0c0-0000-0000-0000-000000000004','7777','ping');
     end $d$s$ as seed_dc_baja,
  $s$do $d$ begin
       perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000009","app_metadata":{"role":"admin"}}',true);
       insert into public.device_config(device_id,config) values
         ('4132','{"heartbeat_s":30,"torch_allowed":true}'),
         ('9999','{"torch_allowed":false}');
     end $d$s$ as seed_cfg,
  $s$do $d$ begin
       insert into public.events(id,device_id,type,payload) values
         ('eeeeeeee-0000-0000-0000-000000000011','4132','sos','{"reason":"hombre_caido"}'),
         ('eeeeeeee-0000-0000-0000-000000000012','4132','geofence','{"kind":"restringida","action":"enter","zone_name":"Zona A"}'),
         ('eeeeeeee-0000-0000-0000-000000000013','4132','geofence','{"kind":"informativa","action":"enter"}'),
         ('eeeeeeee-0000-0000-0000-000000000014','4132','heartbeat','{}'),
         ('eeeeeeee-0000-0000-0000-000000000015','4132','not_worn','{}');
       insert into public.event_acks(event_id,acked_by,acked_by_email,acked_at,note)
         values ('eeeeeeee-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000009','seed@test.local', now() + interval '90 seconds','ok');
     end $d$s$ as seed_inc
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
  union all select * from pg_temp.t('bc viewer: INSERT evacuacion a todos (solo admin)', 'DENIED', 'authenticated', c.viewer, $q$insert into public.broadcasts(kind,message) values ('evacuacion','')$q$)
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
  union all select * from pg_temp.t('gf admin: INSERT circulo', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf admin: INSERT poligono', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','permitida','polygon','{"points":[[-34.60,-58.40],[-34.61,-58.40],[-34.61,-58.41]]}')$q$)
  union all select * from pg_temp.t('gf admin: INSERT', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf admin: INSERT con device_ids, mensaje y alarma', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry,device_ids,message,alarm) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}','{4132,9999}','Cuidado con el pozo','voz')$q$)
  union all select * from pg_temp.t('gf admin: message en blanco se guarda como null', 'ALLOWED', 'postgres', c.admin, $q$do $b$ declare m text; begin insert into public.geofences(name,kind,shape,geometry,message) values ('z','informativa','circle','{"center":[-34.6,-58.4],"radius_m":100}','   ') returning message into m; if m is not null then raise exception 'message=%', m; end if; end $b$$q$)
  union all select * from pg_temp.t('gf admin: UPDATE name', 'ALLOWED', 'authenticated', c.admin, $q$update public.geofences set name = 'nuevo' where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf admin: UPDATE kind', 'ALLOWED', 'authenticated', c.admin, $q$update public.geofences set kind = 'permitida' where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf admin: UPDATE geometry', 'ALLOWED', 'authenticated', c.admin, $q$update public.geofences set geometry = '{"center":[-34.7,-58.5],"radius_m":250}' where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf admin: UPDATE device_ids', 'ALLOWED', 'authenticated', c.admin, $q$update public.geofences set device_ids = '{4132}' where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf admin: UPDATE message/alarm', 'ALLOWED', 'authenticated', c.admin, $q$update public.geofences set message = 'hola', alarm = 'sirena' where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf admin: UPDATE active', 'ALLOWED', 'authenticated', c.admin, $q$update public.geofences set active = false where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf admin: UPDATE name', 'ALLOWED', 'authenticated', c.admin, $q$update public.geofences set name = 'nuevo' where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf admin: baja logica (deleted_at)', 'ALLOWED', 'authenticated', c.admin, $q$update public.geofences set deleted_at = now() where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf admin: UPDATE zona dada de baja (congelada)', 'DENIED', 'authenticated', c.admin, $q$update public.geofences set name = 'x' where id = '99999999-0000-0000-0000-000000000005'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf admin: reactivar baja (deleted_at = null)', 'DENIED', 'authenticated', c.admin, $q$update public.geofences set deleted_at = null where id = '99999999-0000-0000-0000-000000000005'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf admin: DELETE (sin grant)', 'DENIED', 'authenticated', c.admin, $q$delete from public.geofences$q$, c.seed_gf)
  union all select * from pg_temp.t('gf admin: DELETE (sin grant)', 'DENIED', 'authenticated', c.admin, $q$delete from public.geofences$q$, c.seed_gf)
  -- ---- geofences: campos del servidor y columnas sin grant ----
  union all select * from pg_temp.t('gf admin: falsear created_by', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry,created_by) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}','00000000-0000-0000-0000-0000000000aa')$q$)
  union all select * from pg_temp.t('gf admin: falsear created_at', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry,created_at) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}',now() + interval '1 day')$q$)
  union all select * from pg_temp.t('gf admin: falsear updated_at', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry,updated_at) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}',now() + interval '1 day')$q$)
  union all select * from pg_temp.t('gf admin: falsear id', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry,id) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}',gen_random_uuid())$q$)
  union all select * from pg_temp.t('gf admin: INSERT con deleted_at (sin grant de insert)', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry,deleted_at) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}',now())$q$)
  union all select * from pg_temp.t('gf admin: UPDATE shape (sin grant)', 'DENIED', 'authenticated', c.admin, $q$update public.geofences set shape = 'polygon' where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf admin: UPDATE created_by (sin grant)', 'DENIED', 'authenticated', c.admin, $q$update public.geofences set created_by = '00000000-0000-0000-0000-0000000000aa' where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf admin: UPDATE created_at (sin grant)', 'DENIED', 'authenticated', c.admin, $q$update public.geofences set created_at = now() - interval '1 year' where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf admin: UPDATE updated_at (sin grant)', 'DENIED', 'authenticated', c.admin, $q$update public.geofences set updated_at = now() - interval '1 year' where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf admin: UPDATE id (sin grant)', 'DENIED', 'authenticated', c.admin, $q$update public.geofences set id = gen_random_uuid() where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf trigger: created_by/created_at/updated_at se pisan', 'ALLOWED', 'postgres', '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000005","app_metadata":{"role":"admin"}}', $q$do $b$ declare u uuid; c timestamptz; m timestamptz; begin insert into public.geofences(name,kind,shape,geometry,created_by,created_at,updated_at) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}','00000000-0000-0000-0000-0000000000aa', now() - interval '1 year', now() + interval '1 day') returning created_by, created_at, updated_at into u, c, m; if u <> '00000000-0000-0000-0000-000000000005'::uuid or c > now() + interval '1 second' or c < now() - interval '1 second' or m > now() + interval '1 second' then raise exception 'no pisado: % % %', u, c, m; end if; end $b$$q$)
  union all select * from pg_temp.t('gf trigger: deleted_at falsificado se pisa a now()', 'ALLOWED', 'postgres', c.admin, $q$do $b$ declare d timestamptz; begin update public.geofences set deleted_at = '2000-01-01' where id = '99999999-0000-0000-0000-000000000001' returning deleted_at into d; if d is null or d < now() - interval '1 second' then raise exception 'deleted_at=%', d; end if; end $b$$q$, c.seed_gf)
  union all select * from pg_temp.t('gf trigger: shape inmutable aun como postgres', 'ALLOWED', 'postgres', c.admin, $q$do $b$ declare s text; begin update public.geofences set shape = 'polygon' where id = '99999999-0000-0000-0000-000000000001' returning shape into s; if s <> 'circle' then raise exception 'shape=%', s; end if; end $b$$q$, c.seed_gf)
  union all select * from pg_temp.t('gf trigger: JWT sin rol se rechaza (aun como postgres)', 'DENIED', 'postgres', c.norole, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf trigger: UPDATE con JWT device se rechaza (aun como postgres)', 'DENIED', 'postgres', c.dev, $q$update public.geofences set active = false$q$, c.seed_gf)
  union all select * from pg_temp.t('gf trigger: UPDATE sin JWT (SQL Editor) permitido', 'ALLOWED', 'postgres', c.anon, $q$update public.geofences set name = 'mantenimiento' where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  -- ---- geofences: validacion de campos y geometria ----
  union all select * from pg_temp.t('gf admin: name vacio', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf admin: name en blanco', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('   ','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf admin: name 80 caracteres', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values (repeat('a',80),'restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf admin: name 81 caracteres', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values (repeat('a',81),'restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf admin: name con salto de linea', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('a' || chr(10) || 'b','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf admin: kind invalido', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','prohibida','circle','{"center":[-34.6,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf admin: shape invalido', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','rectangle','{"center":[-34.6,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf admin: alarm invalida', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry,alarm) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}','bomba')$q$)
  union all select * from pg_temp.t('gf admin: message 140', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry,message) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}',repeat('a',140))$q$)
  union all select * from pg_temp.t('gf admin: message 141', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry,message) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}',repeat('a',141))$q$)
  union all select * from pg_temp.t('gf admin: message con salto de linea', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry,message) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}','a' || chr(10) || 'b')$q$)
  union all select * from pg_temp.t('gf admin: device_ids vacio', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry,device_ids) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}','{}')$q$)
  union all select * from pg_temp.t('gf admin: device_ids con HTML', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry,device_ids) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}',array['<b>'])$q$)
  union all select * from pg_temp.t('gf admin: device_ids con null', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry,device_ids) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}',array['4132', null])$q$)
  union all select * from pg_temp.t('gf admin: device_ids con coma', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry,device_ids) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}',array['4132,9999'])$q$)
  union all select * from pg_temp.t('gf admin: geometria radio 10 (limite)', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":10}')$q$)
  union all select * from pg_temp.t('gf admin: geometria radio 50000 (limite)', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":50000}')$q$)
  union all select * from pg_temp.t('gf admin: geometria radio 9', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":9}')$q$)
  union all select * from pg_temp.t('gf admin: geometria radio 50001', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":50001}')$q$)
  union all select * from pg_temp.t('gf admin: geometria radio negativo', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":-5}')$q$)
  union all select * from pg_temp.t('gf admin: geometria radio como texto', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":"100"}')$q$)
  union all select * from pg_temp.t('gf admin: geometria sin radio', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4]}')$q$)
  union all select * from pg_temp.t('gf admin: geometria sin centro', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf admin: geometria lat 91', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[91,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf admin: geometria lat -91', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-91,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf admin: geometria lng 181', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,181],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf admin: geometria lng -181', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-181],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf admin: geometria centro con 3 valores', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4,5],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf admin: geometria centro con texto', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":["a","b"],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf admin: geometria clave extra', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100,"x":1}')$q$)
  union all select * from pg_temp.t('gf admin: geometria no objeto', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','[1,2]')$q$)
  union all select * from pg_temp.t('gf admin: geometria circulo con forma poligono', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"points":[[-34.60,-58.40],[-34.61,-58.40],[-34.61,-58.41]]}')$q$)
  union all select * from pg_temp.t('gf admin: geometria poligono con forma circulo', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','polygon','{"center":[-34.6,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('gf admin: geometria poligono 3 puntos', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','polygon','{"points":[[-34.60,-58.40],[-34.61,-58.40],[-34.61,-58.41]]}')$q$)
  union all select * from pg_temp.t('gf admin: geometria poligono 2 puntos', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','polygon','{"points":[[-34.60,-58.40],[-34.61,-58.40]]}')$q$)
  union all select * from pg_temp.t('gf admin: geometria poligono 3 puntos iguales', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','polygon','{"points":[[-34.6,-58.4],[-34.6,-58.4],[-34.6,-58.4]]}')$q$)
  union all select * from pg_temp.t('gf admin: geometria poligono con punto fuera de rango', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','polygon','{"points":[[-34.60,-58.40],[-34.61,-58.40],[95,-58.41]]}')$q$)
  union all select * from pg_temp.t('gf admin: geometria poligono con punto malformado', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','polygon','{"points":[[-34.60,-58.40],[-34.61],[-34.61,-58.41]]}')$q$)
  union all select * from pg_temp.t('gf admin: geometria poligono points no es array', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','polygon','{"points":"x"}')$q$)
  union all select * from pg_temp.t('gf admin: geometria poligono clave extra', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','polygon','{"points":[[-34.60,-58.40],[-34.61,-58.40],[-34.61,-58.41]],"x":1}')$q$)
  union all select * from pg_temp.t('gf admin: poligono 100 puntos', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) select 'z','restringida','polygon', jsonb_build_object('points', (select jsonb_agg(jsonb_build_array(-34 - i/1000.0, -58 - i/1000.0)) from generate_series(1,100) i))$q$)
  union all select * from pg_temp.t('gf admin: poligono 101 puntos', 'DENIED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) select 'z','restringida','polygon', jsonb_build_object('points', (select jsonb_agg(jsonb_build_array(-34 - i/1000.0, -58 - i/1000.0)) from generate_series(1,101) i))$q$)
  union all select * from pg_temp.t('gf admin: UPDATE geometry invalida', 'DENIED', 'authenticated', c.admin, $q$update public.geofences set geometry = '{"center":[-34.7,-58.5],"radius_m":5}' where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('gf admin: UPDATE geometry de otra forma', 'DENIED', 'authenticated', c.admin, $q$update public.geofences set geometry = '{"points":[[-34.60,-58.40],[-34.61,-58.40],[-34.61,-58.41]]}' where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  -- ---- geofences: rate limit 30 filas/min por usuario ----
  union all select * from pg_temp.t('gf admin: 30 zonas/min', 'ALLOWED', 'authenticated', c.admin, $q$do $b$ begin for i in 1..30 loop insert into public.geofences(name,kind,shape,geometry) values ('z' || i,'restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}'); end loop; end $b$$q$)
  union all select * from pg_temp.t('gf admin: 31 zonas/min', 'DENIED', 'authenticated', c.admin, $q$do $b$ begin for i in 1..31 loop insert into public.geofences(name,kind,shape,geometry) values ('z' || i,'restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}'); end loop; end $b$$q$)
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
  union all select * from pg_temp.t('gp admin: INSERT punto_reunion', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng) values ('p','punto_reunion',-34.6,-58.4)$q$)
  union all select * from pg_temp.t('gp admin: INSERT extintor', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng) values ('p','extintor',-34.6,-58.4)$q$)
  union all select * from pg_temp.t('gp admin: INSERT botiquin', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng) values ('p','botiquin',-34.6,-58.4)$q$)
  union all select * from pg_temp.t('gp admin: INSERT acceso', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng) values ('p','acceso',-34.6,-58.4)$q$)
  union all select * from pg_temp.t('gp admin: INSERT otro', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng) values ('p','otro',-34.6,-58.4)$q$)
  union all select * from pg_temp.t('gp admin: INSERT', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng) values ('p','extintor',-34.6,-58.4)$q$)
  union all select * from pg_temp.t('gp admin: INSERT peligro con radio', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng,alert_radius_m) values ('p','peligro',-34.6,-58.4,50)$q$)
  union all select * from pg_temp.t('gp admin: INSERT con notas, mensaje y alarma', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng,notes,message,alarm) values ('p','peligro',-34.6,-58.4,'Valvula con fuga' || chr(10) || 'Zona norte','Peligro, valvula con fuga','sirena')$q$)
  union all select * from pg_temp.t('gp admin: peligro sin radio => 30 por defecto', 'ALLOWED', 'postgres', c.admin, $q$do $b$ declare r int; begin insert into public.geo_points(name,category,lat,lng) values ('p','peligro',-34.6,-58.4) returning alert_radius_m into r; if r <> 30 then raise exception 'radio=%', r; end if; end $b$$q$)
  union all select * from pg_temp.t('gp admin: radio en categoria no peligro se normaliza a null', 'ALLOWED', 'postgres', c.admin, $q$do $b$ declare r int; begin insert into public.geo_points(name,category,lat,lng,alert_radius_m) values ('p','extintor',-34.6,-58.4,50) returning alert_radius_m into r; if r is not null then raise exception 'radio=%', r; end if; end $b$$q$)
  union all select * from pg_temp.t('gp admin: UPDATE name/notes/lat/lng', 'ALLOWED', 'authenticated', c.admin, $q$update public.geo_points set name='n', notes='x', lat=-34.7, lng=-58.5 where id = 'dddddddd-0000-0000-0000-000000000001'$q$, c.seed_gp)
  union all select * from pg_temp.t('gp admin: UPDATE alert_radius_m/message/alarm', 'ALLOWED', 'authenticated', c.admin, $q$update public.geo_points set alert_radius_m = 100, message = 'm', alarm = 'voz' where id = 'dddddddd-0000-0000-0000-000000000001'$q$, c.seed_gp)
  union all select * from pg_temp.t('gp admin: UPDATE category + active', 'ALLOWED', 'authenticated', c.admin, $q$update public.geo_points set category = 'otro', active = false where id = 'dddddddd-0000-0000-0000-000000000001'$q$, c.seed_gp)
  union all select * from pg_temp.t('gp admin: baja logica', 'ALLOWED', 'authenticated', c.admin, $q$update public.geo_points set deleted_at = now() where id = 'dddddddd-0000-0000-0000-000000000001'$q$, c.seed_gp)
  union all select * from pg_temp.t('gp admin: UPDATE punto dado de baja (congelado)', 'DENIED', 'authenticated', c.admin, $q$update public.geo_points set name = 'x' where id = 'dddddddd-0000-0000-0000-000000000004'$q$, c.seed_gp)
  union all select * from pg_temp.t('gp admin: reactivar baja', 'DENIED', 'authenticated', c.admin, $q$update public.geo_points set deleted_at = null where id = 'dddddddd-0000-0000-0000-000000000004'$q$, c.seed_gp)
  union all select * from pg_temp.t('gp admin: DELETE (sin grant)', 'DENIED', 'authenticated', c.admin, $q$delete from public.geo_points$q$, c.seed_gp)
  union all select * from pg_temp.t('gp admin: DELETE (sin grant)', 'DENIED', 'authenticated', c.admin, $q$delete from public.geo_points$q$, c.seed_gp)
  -- ---- geo_points: campos del servidor, columnas sin grant y validacion ----
  union all select * from pg_temp.t('gp admin: falsear created_by', 'DENIED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng,created_by) values ('p','extintor',-34.6,-58.4,'00000000-0000-0000-0000-0000000000aa')$q$)
  union all select * from pg_temp.t('gp admin: falsear created_at', 'DENIED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng,created_at) values ('p','extintor',-34.6,-58.4,now() + interval '1 day')$q$)
  union all select * from pg_temp.t('gp admin: falsear updated_at', 'DENIED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng,updated_at) values ('p','extintor',-34.6,-58.4,now() + interval '1 day')$q$)
  union all select * from pg_temp.t('gp admin: falsear id', 'DENIED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng,id) values ('p','extintor',-34.6,-58.4,gen_random_uuid())$q$)
  union all select * from pg_temp.t('gp admin: INSERT con deleted_at (sin grant de insert)', 'DENIED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng,deleted_at) values ('p','extintor',-34.6,-58.4,now())$q$)
  union all select * from pg_temp.t('gp admin: UPDATE created_by (sin grant)', 'DENIED', 'authenticated', c.admin, $q$update public.geo_points set created_by = '00000000-0000-0000-0000-0000000000aa' where id = 'dddddddd-0000-0000-0000-000000000001'$q$, c.seed_gp)
  union all select * from pg_temp.t('gp admin: UPDATE updated_at (sin grant)', 'DENIED', 'authenticated', c.admin, $q$update public.geo_points set updated_at = now() - interval '1 year' where id = 'dddddddd-0000-0000-0000-000000000001'$q$, c.seed_gp)
  union all select * from pg_temp.t('gp trigger: created_by/created_at se pisan', 'ALLOWED', 'postgres', '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000005","app_metadata":{"role":"admin"}}', $q$do $b$ declare u uuid; c timestamptz; begin insert into public.geo_points(name,category,lat,lng,created_by,created_at) values ('p','extintor',-34.6,-58.4,'00000000-0000-0000-0000-0000000000aa', now() - interval '1 year') returning created_by, created_at into u, c; if u <> '00000000-0000-0000-0000-000000000005'::uuid or c < now() - interval '1 second' then raise exception 'no pisado: % %', u, c; end if; end $b$$q$)
  union all select * from pg_temp.t('gp trigger: deleted_at falsificado se pisa a now()', 'ALLOWED', 'postgres', c.admin, $q$do $b$ declare d timestamptz; begin update public.geo_points set deleted_at = '2000-01-01' where id = 'dddddddd-0000-0000-0000-000000000001' returning deleted_at into d; if d is null or d < now() - interval '1 second' then raise exception 'deleted_at=%', d; end if; end $b$$q$, c.seed_gp)
  union all select * from pg_temp.t('gp trigger: JWT sin rol se rechaza (aun como postgres)', 'DENIED', 'postgres', c.norole, $q$insert into public.geo_points(name,category,lat,lng) values ('p','extintor',-34.6,-58.4)$q$)
  union all select * from pg_temp.t('gp trigger: UPDATE sin JWT (SQL Editor) permitido', 'ALLOWED', 'postgres', c.anon, $q$update public.geo_points set name = 'mantenimiento'$q$, c.seed_gp)
  union all select * from pg_temp.t('gp admin: name vacio', 'DENIED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng) values ('','extintor',-34.6,-58.4)$q$)
  union all select * from pg_temp.t('gp admin: name 81 caracteres', 'DENIED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng) values (repeat('a',81),'extintor',-34.6,-58.4)$q$)
  union all select * from pg_temp.t('gp admin: category invalida', 'DENIED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng) values ('p','bomba',-34.6,-58.4)$q$)
  union all select * from pg_temp.t('gp admin: lat 91', 'DENIED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng) values ('p','extintor',91,-58.4)$q$)
  union all select * from pg_temp.t('gp admin: lat NaN', 'DENIED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng) values ('p','extintor','NaN'::float8,-58.4)$q$)
  union all select * from pg_temp.t('gp admin: lng 181', 'DENIED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng) values ('p','extintor',-34.6,181)$q$)
  union all select * from pg_temp.t('gp admin: lng -180 (limite)', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng) values ('p','extintor',-34.6,-180)$q$)
  union all select * from pg_temp.t('gp admin: notes 500', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng,notes) values ('p','extintor',-34.6,-58.4,repeat('a',500))$q$)
  union all select * from pg_temp.t('gp admin: notes 501', 'DENIED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng,notes) values ('p','extintor',-34.6,-58.4,repeat('a',501))$q$)
  union all select * from pg_temp.t('gp admin: notes con caracter de control', 'DENIED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng,notes) values ('p','extintor',-34.6,-58.4,'a' || chr(7))$q$)
  union all select * from pg_temp.t('gp admin: message 141', 'DENIED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng,message) values ('p','extintor',-34.6,-58.4,repeat('a',141))$q$)
  union all select * from pg_temp.t('gp admin: alarm invalida', 'DENIED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng,alarm) values ('p','extintor',-34.6,-58.4,'bomba')$q$)
  union all select * from pg_temp.t('gp admin: radio 5 (limite)', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng,alert_radius_m) values ('p','peligro',-34.6,-58.4,5)$q$)
  union all select * from pg_temp.t('gp admin: radio 500 (limite)', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng,alert_radius_m) values ('p','peligro',-34.6,-58.4,500)$q$)
  union all select * from pg_temp.t('gp admin: radio 4', 'DENIED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng,alert_radius_m) values ('p','peligro',-34.6,-58.4,4)$q$)
  union all select * from pg_temp.t('gp admin: radio 501', 'DENIED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng,alert_radius_m) values ('p','peligro',-34.6,-58.4,501)$q$)
  union all select * from pg_temp.t('gp admin: UPDATE radio 501', 'DENIED', 'authenticated', c.admin, $q$update public.geo_points set alert_radius_m = 501 where id = 'dddddddd-0000-0000-0000-000000000001'$q$, c.seed_gp)
  -- ---- geo_points: rate limit 30 filas/min por usuario ----
  union all select * from pg_temp.t('gp admin: 30 puntos/min', 'ALLOWED', 'authenticated', c.admin, $q$do $b$ begin for i in 1..30 loop insert into public.geo_points(name,category,lat,lng) values ('p' || i,'extintor',-34.6,-58.4); end loop; end $b$$q$)
  union all select * from pg_temp.t('gp admin: 31 puntos/min', 'DENIED', 'authenticated', c.admin, $q$do $b$ begin for i in 1..31 loop insert into public.geo_points(name,category,lat,lng) values ('p' || i,'extintor',-34.6,-58.4); end loop; end $b$$q$)
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
  union all select * from pg_temp.t('eq admin: devices_full incluye imei', 'ALLOWED', 'authenticated', c.admin, $q$do $b$ declare i text; begin select imei into i from public.devices_full where device_id='4132'; if i is distinct from '866652020000001' then raise exception 'imei=%', i; end if; end $b$$q$, c.seed_eq)
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
  union all select * from pg_temp.t('eq admin: INSERT group_members (sin grant)', 'DENIED', 'authenticated', c.admin, $q$insert into public.group_members(user_id,group_id) values ('00000000-0000-0000-0000-000000000005','a1a1a1a1-0000-0000-0000-000000000001')$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: INSERT group_members (sin grant)', 'DENIED', 'authenticated', c.admin, $q$insert into public.group_members(user_id,group_id) values ('00000000-0000-0000-0000-000000000006','a1a1a1a1-0000-0000-0000-000000000001')$q$, c.seed_eq)
  union all select * from pg_temp.t('eq user_in_group: false si no es miembro', 'ALLOWED', 'authenticated', c.viewer, $q$do $b$ begin if public.user_in_group('a1a1a1a1-0000-0000-0000-000000000001') then raise exception 'miembro?'; end if; end $b$$q$, c.seed_eq)
  union all select * from pg_temp.t('eq user_in_group: anon sin EXECUTE', 'DENIED', 'anon', c.anon, $q$select public.user_in_group('a1a1a1a1-0000-0000-0000-000000000001')$q$)
  -- ---- altas y ediciones ----
  union all select * from pg_temp.t('eq admin: INSERT grupo', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.groups(name,site,notes) values ('G nuevo','Locacion','n')$q$)
  union all select * from pg_temp.t('eq admin: INSERT casco', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.devices(device_id,imei,name,model,status) values ('5555','866652020000099','Casco 5555','rd_aqm6816','activo')$q$)
  union all select * from pg_temp.t('eq admin: INSERT casco con group_id', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.devices(device_id,name,group_id) values ('5555','Casco 5555','a1a1a1a1-0000-0000-0000-000000000001')$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: INSERT casco', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.devices(device_id,name) values ('5555','Casco 5555')$q$)
  union all select * from pg_temp.t('eq admin: INSERT persona sin dni', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.people(full_name,legajo,job_title,sector) values ('Persona Nueva','L100','Operador','S1')$q$)
  union all select * from pg_temp.t('eq viewer: INSERT persona con dni (solo admin)', 'DENIED', 'authenticated', c.viewer, $q$insert into public.people(full_name,dni) values ('Persona Nueva','11111111')$q$)
  union all select * from pg_temp.t('eq viewer: INSERT persona con telefono (solo admin)', 'DENIED', 'authenticated', c.viewer, $q$insert into public.people(full_name,contact_phone) values ('Persona Nueva','+5491100000000')$q$)
  union all select * from pg_temp.t('eq admin: INSERT persona con dni y telefono', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.people(full_name,dni,contact_phone) values ('Persona Nueva','11111111','+5491100000000')$q$)
  union all select * from pg_temp.t('eq viewer: UPDATE dni (solo admin)', 'DENIED', 'authenticated', c.viewer, $q$update public.people set dni = '99999999' where id = 'b2b2b2b2-0000-0000-0000-000000000001'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq viewer: UPDATE contact_phone (solo admin)', 'DENIED', 'authenticated', c.viewer, $q$update public.people set contact_phone = '+541100000000' where id = 'b2b2b2b2-0000-0000-0000-000000000001'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: UPDATE dni', 'ALLOWED', 'authenticated', c.admin, $q$update public.people set dni = '99999999' where id = 'b2b2b2b2-0000-0000-0000-000000000001'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: UPDATE nombre/puesto/sector/grupo', 'ALLOWED', 'authenticated', c.admin, $q$update public.people set full_name='Otro', job_title='Jefe', sector='S2', group_id='a1a1a1a1-0000-0000-0000-000000000001' where id = 'b2b2b2b2-0000-0000-0000-000000000002'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: UPDATE persona con dni sin tocarlo', 'ALLOWED', 'authenticated', c.admin, $q$update public.people set job_title='Jefe' where id = 'b2b2b2b2-0000-0000-0000-000000000001'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: UPDATE casco (name, sector, SIM, estado)', 'ALLOWED', 'authenticated', c.admin, $q$update public.devices set name='Nuevo', sector='S9', sim2_iccid='8954000000000000002', status='mantenimiento' where device_id = '4132'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: UPDATE imei', 'ALLOWED', 'authenticated', c.admin, $q$update public.devices set imei = '866652020000050' where device_id = '4132'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: UPDATE device_id (sin grant)', 'DENIED', 'authenticated', c.admin, $q$update public.devices set device_id = '1111' where device_id = '4132'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: UPDATE group name', 'ALLOWED', 'authenticated', c.admin, $q$update public.groups set name = 'Renombrado' where id = 'a1a1a1a1-0000-0000-0000-000000000001'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq trigger: device_id inmutable aun como postgres con JWT', 'DENIED', 'postgres', c.admin, $q$update public.devices set device_id = '1111' where device_id = '4132'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: baja logica de casco', 'ALLOWED', 'authenticated', c.admin, $q$update public.devices set deleted_at = now() where device_id = '9999'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: baja logica de persona', 'ALLOWED', 'authenticated', c.admin, $q$update public.people set deleted_at = now() where id = 'b2b2b2b2-0000-0000-0000-000000000002'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: baja logica de grupo', 'ALLOWED', 'authenticated', c.admin, $q$update public.groups set deleted_at = now() where id = 'a1a1a1a1-0000-0000-0000-000000000001'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: UPDATE casco dado de baja (congelado)', 'DENIED', 'authenticated', c.admin, $q$update public.devices set deleted_at = now() where device_id = '9999'$q$, $s$do $d$ begin perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000009","app_metadata":{"role":"admin"}}',true); insert into public.devices(device_id,name) values ('9999','x'); update public.devices set deleted_at = now(); end $d$$s$)
  union all select * from pg_temp.t('eq admin: DELETE devices (sin grant)', 'DENIED', 'authenticated', c.admin, $q$delete from public.devices$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: DELETE people (sin grant)', 'DENIED', 'authenticated', c.admin, $q$delete from public.people$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: DELETE groups (sin grant)', 'DENIED', 'authenticated', c.admin, $q$delete from public.groups$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: DELETE assignments (sin grant)', 'DENIED', 'authenticated', c.admin, $q$delete from public.assignments$q$, c.seed_eq)
  -- ---- campos del servidor y validacion ----
  union all select * from pg_temp.t('eq admin: falsear created_by (casco)', 'DENIED', 'authenticated', c.admin, $q$insert into public.devices(device_id,name,created_by) values ('5555','x','00000000-0000-0000-0000-0000000000aa')$q$)
  union all select * from pg_temp.t('eq admin: falsear created_at (persona)', 'DENIED', 'authenticated', c.admin, $q$insert into public.people(full_name,created_at) values ('x', now() + interval '1 day')$q$)
  union all select * from pg_temp.t('eq admin: falsear updated_at (grupo)', 'DENIED', 'authenticated', c.admin, $q$insert into public.groups(name,updated_at) values ('x', now() + interval '1 day')$q$)
  union all select * from pg_temp.t('eq admin: INSERT con deleted_at (sin grant de insert)', 'DENIED', 'authenticated', c.admin, $q$insert into public.devices(device_id,name,deleted_at) values ('5555','x',now())$q$)
  union all select * from pg_temp.t('eq trigger: created_by/created_at se pisan (casco)', 'ALLOWED', 'postgres', '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000005","app_metadata":{"role":"admin"}}', $q$do $b$ declare u uuid; c timestamptz; begin insert into public.devices(device_id,name,created_by,created_at) values ('5555','x','00000000-0000-0000-0000-0000000000aa', now() - interval '1 year') returning created_by, created_at into u, c; if u <> '00000000-0000-0000-0000-000000000005'::uuid or c < now() - interval '1 second' then raise exception 'no pisado: % %', u, c; end if; end $b$$q$)
  union all select * from pg_temp.t('eq trigger: JWT sin rol se rechaza (aun como postgres)', 'DENIED', 'postgres', c.norole, $q$insert into public.devices(device_id,name) values ('5555','x')$q$)
  union all select * from pg_temp.t('eq trigger: UPDATE sin JWT (SQL Editor) permitido', 'ALLOWED', 'postgres', c.anon, $q$update public.devices set name = 'mantenimiento' where device_id = '4132'$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: device_id con HTML', 'DENIED', 'authenticated', c.admin, $q$insert into public.devices(device_id,name) values ('<b>','x')$q$)
  union all select * from pg_temp.t('eq admin: device_id vacio', 'DENIED', 'authenticated', c.admin, $q$insert into public.devices(device_id,name) values ('','x')$q$)
  union all select * from pg_temp.t('eq admin: device_id duplicado', 'DENIED', 'authenticated', c.admin, $q$insert into public.devices(device_id,name) values ('4132','x')$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: imei 14 digitos', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.devices(device_id,name,imei) values ('5555','x','86665202000009')$q$)
  union all select * from pg_temp.t('eq admin: imei 13 digitos', 'DENIED', 'authenticated', c.admin, $q$insert into public.devices(device_id,name,imei) values ('5555','x','8666520200000')$q$)
  union all select * from pg_temp.t('eq admin: imei con letras', 'DENIED', 'authenticated', c.admin, $q$insert into public.devices(device_id,name,imei) values ('5555','x','86665202XXXXXXX')$q$)
  union all select * from pg_temp.t('eq admin: imei duplicado', 'DENIED', 'authenticated', c.admin, $q$insert into public.devices(device_id,name,imei) values ('5555','x','866652020000001')$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: iccid invalido', 'DENIED', 'authenticated', c.admin, $q$insert into public.devices(device_id,name,sim1_iccid) values ('5555','x','12345')$q$)
  union all select * from pg_temp.t('eq admin: sim_line invalida', 'DENIED', 'authenticated', c.admin, $q$insert into public.devices(device_id,name,sim_line) values ('5555','x','abc')$q$)
  union all select * from pg_temp.t('eq admin: bt_headset_mac valida', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.devices(device_id,name,bt_headset_mac) values ('5555','x','AA:BB:CC:DD:EE:FF')$q$)
  union all select * from pg_temp.t('eq admin: bt_headset_mac invalida', 'DENIED', 'authenticated', c.admin, $q$insert into public.devices(device_id,name,bt_headset_mac) values ('5555','x','AABBCCDDEEFF')$q$)
  union all select * from pg_temp.t('eq admin: status invalido', 'DENIED', 'authenticated', c.admin, $q$insert into public.devices(device_id,name,status) values ('5555','x','roto')$q$)
  union all select * from pg_temp.t('eq admin: name vacio', 'DENIED', 'authenticated', c.admin, $q$insert into public.devices(device_id,name) values ('5555','')$q$)
  union all select * from pg_temp.t('eq admin: name > 80', 'DENIED', 'authenticated', c.admin, $q$insert into public.devices(device_id,name) values ('5555',repeat('a',81))$q$)
  union all select * from pg_temp.t('eq admin: group_id inexistente', 'DENIED', 'authenticated', c.admin, $q$insert into public.devices(device_id,name,group_id) values ('5555','x','a1a1a1a1-0000-0000-0000-0000000000ff')$q$)
  union all select * from pg_temp.t('eq admin: notes 501', 'DENIED', 'authenticated', c.admin, $q$insert into public.devices(device_id,name,notes) values ('5555','x',repeat('a',501))$q$)
  union all select * from pg_temp.t('eq admin: modelo por defecto rd_aqm6816', 'ALLOWED', 'postgres', c.admin, $q$do $b$ declare m text; begin insert into public.devices(device_id,name) values ('5555','x') returning model into m; if m <> 'rd_aqm6816' then raise exception 'model=%', m; end if; end $b$$q$)
  union all select * from pg_temp.t('eq admin: full_name vacio', 'DENIED', 'authenticated', c.admin, $q$insert into public.people(full_name) values ('')$q$)
  union all select * from pg_temp.t('eq admin: full_name 121', 'DENIED', 'authenticated', c.admin, $q$insert into public.people(full_name) values (repeat('a',121))$q$)
  union all select * from pg_temp.t('eq admin: legajo duplicado', 'DENIED', 'authenticated', c.admin, $q$insert into public.people(full_name,legajo) values ('x','L001')$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: legajo con espacios', 'DENIED', 'authenticated', c.admin, $q$insert into public.people(full_name,legajo) values ('x','L 1')$q$)
  union all select * from pg_temp.t('eq admin: dni invalido', 'DENIED', 'authenticated', c.admin, $q$insert into public.people(full_name,dni) values ('x','12 34')$q$)
  union all select * from pg_temp.t('eq admin: telefono invalido', 'DENIED', 'authenticated', c.admin, $q$insert into public.people(full_name,contact_phone) values ('x','abc')$q$)
  union all select * from pg_temp.t('eq admin: nombre de grupo duplicado (sin distinguir mayusculas)', 'DENIED', 'authenticated', c.admin, $q$insert into public.groups(name) values ('grupo a')$q$, c.seed_eq)
  union all select * from pg_temp.t('eq admin: nombre de grupo vacio', 'DENIED', 'authenticated', c.admin, $q$insert into public.groups(name) values ('  ')$q$)
  -- ---- assignments ----
  union all select * from pg_temp.t('as admin: asignar casco libre a persona libre', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.assignments(device_id,person_id) values ('9999','b2b2b2b2-0000-0000-0000-000000000002')$q$, c.seed_eq)
  union all select * from pg_temp.t('as admin: asignar', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.assignments(device_id,person_id) values ('9999','b2b2b2b2-0000-0000-0000-000000000002')$q$, c.seed_eq)
  union all select * from pg_temp.t('as admin: nueva asignacion cierra la anterior del casco', 'ALLOWED', 'authenticated', c.admin, $q$do $b$ declare n int; c int; begin insert into public.assignments(device_id,person_id) values ('4132','b2b2b2b2-0000-0000-0000-000000000002'); select count(*) into n from public.assignments where device_id='4132' and ends_at is null; select count(*) into c from public.assignments where device_id='4132' and ends_at is not null; if n <> 1 or c <> 1 then raise exception 'abiertas=% cerradas=%', n, c; end if; end $b$$q$, c.seed_eq)
  union all select * from pg_temp.t('as admin: nueva asignacion cierra la anterior de la persona', 'ALLOWED', 'authenticated', c.admin, $q$do $b$ declare n int; begin insert into public.assignments(device_id,person_id) values ('9999','b2b2b2b2-0000-0000-0000-000000000001'); select count(*) into n from public.assignments where person_id='b2b2b2b2-0000-0000-0000-000000000001' and ends_at is null; if n <> 1 then raise exception 'abiertas=%', n; end if; if exists (select 1 from public.assignments where device_id='4132' and ends_at is null) then raise exception '4132 sigue abierta'; end if; end $b$$q$, c.seed_eq)
  union all select * from pg_temp.t('as admin: casco dado de baja (status baja)', 'DENIED', 'authenticated', c.admin, $q$insert into public.assignments(device_id,person_id) values ('7777','b2b2b2b2-0000-0000-0000-000000000002')$q$, c.seed_eq)
  union all select * from pg_temp.t('as admin: persona inactiva', 'DENIED', 'authenticated', c.admin, $q$insert into public.assignments(device_id,person_id) values ('9999','b2b2b2b2-0000-0000-0000-000000000003')$q$, c.seed_eq)
  union all select * from pg_temp.t('as admin: casco inexistente', 'DENIED', 'authenticated', c.admin, $q$insert into public.assignments(device_id,person_id) values ('0000','b2b2b2b2-0000-0000-0000-000000000002')$q$, c.seed_eq)
  union all select * from pg_temp.t('as admin: persona inexistente', 'DENIED', 'authenticated', c.admin, $q$insert into public.assignments(device_id,person_id) values ('9999','b2b2b2b2-0000-0000-0000-0000000000ff')$q$, c.seed_eq)
  union all select * from pg_temp.t('as admin: falsear starts_at (sin grant)', 'DENIED', 'authenticated', c.admin, $q$insert into public.assignments(device_id,person_id,starts_at) values ('9999','b2b2b2b2-0000-0000-0000-000000000002', now() - interval '1 year')$q$, c.seed_eq)
  union all select * from pg_temp.t('as admin: falsear created_by (sin grant)', 'DENIED', 'authenticated', c.admin, $q$insert into public.assignments(device_id,person_id,created_by) values ('9999','b2b2b2b2-0000-0000-0000-000000000002','00000000-0000-0000-0000-0000000000aa')$q$, c.seed_eq)
  union all select * from pg_temp.t('as admin: cerrar asignacion (ends_at)', 'ALLOWED', 'authenticated', c.admin, $q$update public.assignments set ends_at = now()$q$, c.seed_eq)
  union all select * from pg_temp.t('as admin: ends_at lo fija el servidor', 'ALLOWED', 'postgres', c.admin, $q$do $b$ declare e timestamptz; begin update public.assignments set ends_at = '2000-01-01' returning ends_at into e; if e < now() - interval '1 second' then raise exception 'ends_at=%', e; end if; end $b$$q$, c.seed_eq)
  union all select * from pg_temp.t('as admin: reabrir asignacion cerrada', 'DENIED', 'authenticated', c.admin, $q$update public.assignments set ends_at = null$q$, c.seed_eq_closed)
  union all select * from pg_temp.t('as admin: UPDATE de asignacion cerrada', 'DENIED', 'authenticated', c.admin, $q$update public.assignments set ends_at = now()$q$, c.seed_eq_closed)
  union all select * from pg_temp.t('as admin: UPDATE device_id (sin grant)', 'DENIED', 'authenticated', c.admin, $q$update public.assignments set device_id = '9999'$q$, c.seed_eq)
  union all select * from pg_temp.t('as trigger: JWT sin rol se rechaza (aun como postgres)', 'DENIED', 'postgres', c.norole, $q$insert into public.assignments(device_id,person_id) values ('9999','b2b2b2b2-0000-0000-0000-000000000002')$q$, c.seed_eq)
  union all select * from pg_temp.t('as indice unico: dos abiertas del mismo casco (insercion directa sin trigger)', 'DENIED', 'postgres', c.anon, $q$do $b$ begin alter table public.assignments disable trigger assignments_guard_trg; insert into public.assignments(device_id,person_id,created_by) values ('4132','b2b2b2b2-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000009'); end $b$$q$, c.seed_eq)
  -- ---- rate limit 30 filas/min por usuario ----
  union all select * from pg_temp.t('eq admin: 30 cascos/min', 'ALLOWED', 'authenticated', c.admin, $q$do $b$ begin for i in 1..30 loop insert into public.devices(device_id,name) values ('d' || i,'x'); end loop; end $b$$q$)
  union all select * from pg_temp.t('eq admin: 31 cascos/min', 'DENIED', 'authenticated', c.admin, $q$do $b$ begin for i in 1..31 loop insert into public.devices(device_id,name) values ('d' || i,'x'); end loop; end $b$$q$)
  union all select * from pg_temp.t('eq admin: 31 personas/min', 'DENIED', 'authenticated', c.admin, $q$do $b$ begin for i in 1..31 loop insert into public.people(full_name) values ('p' || i); end loop; end $b$$q$)
  union all select * from pg_temp.t('eq admin: 31 grupos/min', 'DENIED', 'authenticated', c.admin, $q$do $b$ begin for i in 1..31 loop insert into public.groups(name) values ('g' || i); end loop; end $b$$q$)
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
  -- ======================= Tanda 4: comandos, config, roles y reporte (migracion 010) =======================
  -- ---- device_commands ----
  union all select * from pg_temp.t('dc anon: SELECT', 'DENIED', 'anon', c.anon, 'select * from public.device_commands', c.seed_dc)
  union all select * from pg_temp.t('dc anon: INSERT', 'DENIED', 'anon', c.anon, $q$insert into public.device_commands(device_id,action) values ('4132','photo')$q$)
  union all select * from pg_temp.t('dc sin rol: SELECT', 'DENIED', 'authenticated', c.norole, 'select * from public.device_commands', c.seed_dc)
  union all select * from pg_temp.t('dc sin rol: INSERT', 'DENIED', 'authenticated', c.norole, $q$insert into public.device_commands(device_id,action) values ('4132','photo')$q$)
  union all select * from pg_temp.t('dc user_metadata falso: INSERT', 'DENIED', 'authenticated', c.usermeta, $q$insert into public.device_commands(device_id,action) values ('4132','photo')$q$)
  union all select * from pg_temp.t('dc device: SELECT propio reciente', 'ALLOWED', 'authenticated', c.dev, $q$select * from public.device_commands where device_id='4132'$q$, c.seed_dc)
  union all select * from pg_temp.t('dc device: SELECT de otro casco', 'DENIED', 'authenticated', c.dev, $q$select * from public.device_commands where device_id='9999'$q$, c.seed_dc)
  union all select * from pg_temp.t('dc device: ve exactamente 1 (el suyo)', 'ALLOWED', 'authenticated', c.dev, $q$do $b$ declare n int; begin select count(*) into n from public.device_commands; if n <> 1 then raise exception 've %', n; end if; end $b$q$, c.seed_dc)
  union all select * from pg_temp.t('dc device: SELECT propio vencido (>2 min)', 'DENIED', 'authenticated', c.dev, 'select * from public.device_commands', c.seed_dc_old)
  union all select * from pg_temp.t('dc device sin claim device_id: SELECT', 'DENIED', 'authenticated', c.dev_noid, 'select * from public.device_commands', c.seed_dc)
  union all select * from pg_temp.t('dc device: INSERT', 'DENIED', 'authenticated', c.dev, $q$insert into public.device_commands(device_id,action) values ('4132','photo')$q$)
  union all select * from pg_temp.t('dc device: UPDATE', 'DENIED', 'authenticated', c.dev, $q$update public.device_commands set action='ping'$q$, c.seed_dc)
  union all select * from pg_temp.t('dc device: DELETE', 'DENIED', 'authenticated', c.dev, 'delete from public.device_commands', c.seed_dc)
  union all select * from pg_temp.t('dc viewer: INSERT photo', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.device_commands(device_id,action) values ('4132','photo')$q$)
  union all select * from pg_temp.t('dc viewer: INSERT torch_on', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.device_commands(device_id,action) values ('4132','torch_on')$q$)
  union all select * from pg_temp.t('dc viewer: INSERT torch_off', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.device_commands(device_id,action) values ('4132','torch_off')$q$)
  union all select * from pg_temp.t('dc viewer: INSERT ping', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.device_commands(device_id,action) values ('4132','ping')$q$)
  union all select * from pg_temp.t('dc viewer: INSERT restart_agent (solo admin)', 'DENIED', 'authenticated', c.viewer, $q$insert into public.device_commands(device_id,action) values ('4132','restart_agent')$q$)
  union all select * from pg_temp.t('dc admin: INSERT restart_agent', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.device_commands(device_id,action) values ('4132','restart_agent')$q$)
  union all select * from pg_temp.t('dc admin: INSERT photo', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.device_commands(device_id,action) values ('4132','photo')$q$)
  union all select * from pg_temp.t('dc viewer: action invalida', 'DENIED', 'authenticated', c.viewer, $q$insert into public.device_commands(device_id,action) values ('4132','reboot')$q$)
  union all select * from pg_temp.t('dc viewer: device_id con HTML', 'DENIED', 'authenticated', c.viewer, $q$insert into public.device_commands(device_id,action) values ('<b>','photo')$q$)
  union all select * from pg_temp.t('dc viewer: params objeto', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.device_commands(device_id,action,params) values ('4132','photo','{"quality":80}')$q$)
  union all select * from pg_temp.t('dc viewer: params no objeto', 'DENIED', 'authenticated', c.viewer, $q$insert into public.device_commands(device_id,action,params) values ('4132','photo','[1]')$q$)
  union all select * from pg_temp.t('dc viewer: params > 1 KB', 'DENIED', 'authenticated', c.viewer, $q$insert into public.device_commands(device_id,action,params) values ('4132','photo', jsonb_build_object('x', repeat('a',1100)))$q$)
  union all select * from pg_temp.t('dc viewer: falsear requested_by (sin grant)', 'DENIED', 'authenticated', c.viewer, $q$insert into public.device_commands(device_id,action,requested_by) values ('4132','photo','00000000-0000-0000-0000-0000000000aa')$q$)
  union all select * from pg_temp.t('dc viewer: falsear requested_by_email (sin grant)', 'DENIED', 'authenticated', c.viewer, $q$insert into public.device_commands(device_id,action,requested_by_email) values ('4132','photo','otro@x.com')$q$)
  union all select * from pg_temp.t('dc viewer: falsear created_at (sin grant)', 'DENIED', 'authenticated', c.viewer, $q$insert into public.device_commands(device_id,action,created_at) values ('4132','photo', now() + interval '1 day')$q$)
  union all select * from pg_temp.t('dc viewer: falsear id (sin grant)', 'DENIED', 'authenticated', c.viewer, $q$insert into public.device_commands(device_id,action,id) values ('4132','photo', gen_random_uuid())$q$)
  union all select * from pg_temp.t('dc viewer: UPDATE', 'DENIED', 'authenticated', c.viewer, $q$update public.device_commands set action='ping'$q$, c.seed_dc)
  union all select * from pg_temp.t('dc viewer: DELETE', 'DENIED', 'authenticated', c.viewer, 'delete from public.device_commands', c.seed_dc)
  union all select * from pg_temp.t('dc viewer: SELECT todo', 'ALLOWED', 'authenticated', c.viewer, 'select * from public.device_commands', c.seed_dc_old)
  union all select * from pg_temp.t('dc admin: SELECT todo', 'ALLOWED', 'authenticated', c.admin, 'select * from public.device_commands', c.seed_dc)
  union all select * from pg_temp.t('dc viewer: 10 comandos/min', 'ALLOWED', 'authenticated', c.viewer, $q$do $b$ begin for i in 1..10 loop insert into public.device_commands(device_id,action) values ('4132','ping'); end loop; end $b$q$)
  union all select * from pg_temp.t('dc viewer: 11 comandos/min', 'DENIED', 'authenticated', c.viewer, $q$do $b$ begin for i in 1..11 loop insert into public.device_commands(device_id,action) values ('4132','ping'); end loop; end $b$q$)
  union all select * from pg_temp.t('dc admin: 11 comandos/min', 'DENIED', 'authenticated', c.admin, $q$do $b$ begin for i in 1..11 loop insert into public.device_commands(device_id,action) values ('4132','ping'); end loop; end $b$q$)
  union all select * from pg_temp.t('dc trigger: requested_by/email/created_at se pisan', 'ALLOWED', 'postgres', '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000005","email":"sup@test.local","app_metadata":{"role":"viewer"}}',
            $q$do $b$ declare u uuid; e text; t timestamptz; begin
                 insert into public.device_commands(device_id,action,requested_by,requested_by_email,created_at)
                   values ('4132','ping','00000000-0000-0000-0000-0000000000aa','falso@x.com', now() + interval '1 day')
                   returning requested_by, requested_by_email, created_at into u, e, t;
                 if u <> '00000000-0000-0000-0000-000000000005'::uuid or e <> 'sup@test.local' or t > now() + interval '1 second' then
                   raise exception 'no pisado: % % %', u, e, t;
                 end if;
               end $b$q$)
  union all select * from pg_temp.t('dc trigger: restart_agent con JWT viewer se rechaza (aun como postgres)', 'DENIED', 'postgres', c.viewer, $q$insert into public.device_commands(device_id,action) values ('4132','restart_agent')$q$)
  union all select * from pg_temp.t('dc trigger: JWT sin rol se rechaza (aun como postgres)', 'DENIED', 'postgres', c.norole, $q$insert into public.device_commands(device_id,action) values ('4132','ping')$q$)
  -- ---- device_command_acks ----
  union all select * from pg_temp.t('dack anon: INSERT', 'DENIED', 'anon', c.anon, $q$insert into public.device_command_acks(command_id,device_id,ok) values ('c0c0c0c0-0000-0000-0000-000000000001','4132',true)$q$, c.seed_dc)
  union all select * from pg_temp.t('dack sin rol: INSERT', 'DENIED', 'authenticated', c.norole, $q$insert into public.device_command_acks(command_id,device_id,ok) values ('c0c0c0c0-0000-0000-0000-000000000001','4132',true)$q$, c.seed_dc)
  union all select * from pg_temp.t('dack device: INSERT propio', 'ALLOWED', 'authenticated', c.dev, $q$insert into public.device_command_acks(command_id,device_id,ok,detail) values ('c0c0c0c0-0000-0000-0000-000000000001','4132',true,'foto subida')$q$, c.seed_dc)
  union all select * from pg_temp.t('dack device: ok=false con detail', 'ALLOWED', 'authenticated', c.dev, $q$insert into public.device_command_acks(command_id,device_id,ok,detail) values ('c0c0c0c0-0000-0000-0000-000000000001','4132',false,'camara ocupada')$q$, c.seed_dc)
  union all select * from pg_temp.t('dack device: comando de otro casco (con su device_id)', 'DENIED', 'authenticated', c.dev, $q$insert into public.device_command_acks(command_id,device_id,ok) values ('c0c0c0c0-0000-0000-0000-000000000002','4132',true)$q$, c.seed_dc)
  union all select * from pg_temp.t('dack device: device_id ajeno', 'DENIED', 'authenticated', c.dev, $q$insert into public.device_command_acks(command_id,device_id,ok) values ('c0c0c0c0-0000-0000-0000-000000000002','9999',true)$q$, c.seed_dc)
  union all select * from pg_temp.t('dack device: comando inexistente', 'DENIED', 'authenticated', c.dev, $q$insert into public.device_command_acks(command_id,device_id,ok) values ('c0c0c0c0-0000-0000-0000-0000000000ff','4132',true)$q$)
  union all select * from pg_temp.t('dack device: comando de mas de 10 min', 'DENIED', 'authenticated', c.dev, $q$insert into public.device_command_acks(command_id,device_id,ok) values ('c0c0c0c0-0000-0000-0000-000000000003','4132',true)$q$, c.seed_dc_old)
  union all select * from pg_temp.t('dack device sin claim device_id: INSERT', 'DENIED', 'authenticated', c.dev_noid, $q$insert into public.device_command_acks(command_id,device_id,ok) values ('c0c0c0c0-0000-0000-0000-000000000001','4132',true)$q$, c.seed_dc)
  union all select * from pg_temp.t('dack device: detail 200', 'ALLOWED', 'authenticated', c.dev, $q$insert into public.device_command_acks(command_id,device_id,ok,detail) values ('c0c0c0c0-0000-0000-0000-000000000001','4132',true,repeat('a',200))$q$, c.seed_dc)
  union all select * from pg_temp.t('dack device: detail 201', 'DENIED', 'authenticated', c.dev, $q$insert into public.device_command_acks(command_id,device_id,ok,detail) values ('c0c0c0c0-0000-0000-0000-000000000001','4132',true,repeat('a',201))$q$, c.seed_dc)
  union all select * from pg_temp.t('dack device: duplicado (ya registrado)', 'DENIED', 'authenticated', c.dev, $q$insert into public.device_command_acks(command_id,device_id,ok) values ('c0c0c0c0-0000-0000-0000-000000000001','4132',true)$q$, c.seed_dack)
  union all select * from pg_temp.t('dack device: falsear created_at (sin grant)', 'DENIED', 'authenticated', c.dev, $q$insert into public.device_command_acks(command_id,device_id,ok,created_at) values ('c0c0c0c0-0000-0000-0000-000000000001','4132',true, now() + interval '1 day')$q$, c.seed_dc)
  union all select * from pg_temp.t('dack device de baja: INSERT (device_is_active)', 'DENIED', 'authenticated', c.dev_baja, $q$insert into public.device_command_acks(command_id,device_id,ok) values ('c0c0c0c0-0000-0000-0000-000000000004','7777',true)$q$, c.seed_dc_baja)
  union all select * from pg_temp.t('dack viewer: INSERT (solo el casco)', 'DENIED', 'authenticated', c.viewer, $q$insert into public.device_command_acks(command_id,device_id,ok) values ('c0c0c0c0-0000-0000-0000-000000000001','4132',true)$q$, c.seed_dc)
  union all select * from pg_temp.t('dack admin: INSERT (solo el casco)', 'DENIED', 'authenticated', c.admin, $q$insert into public.device_command_acks(command_id,device_id,ok) values ('c0c0c0c0-0000-0000-0000-000000000001','4132',true)$q$, c.seed_dc)
  union all select * from pg_temp.t('dack device: SELECT (no lee)', 'DENIED', 'authenticated', c.dev, 'select * from public.device_command_acks', c.seed_dack)
  union all select * from pg_temp.t('dack anon: SELECT', 'DENIED', 'anon', c.anon, 'select * from public.device_command_acks', c.seed_dack)
  union all select * from pg_temp.t('dack viewer: SELECT', 'ALLOWED', 'authenticated', c.viewer, 'select * from public.device_command_acks', c.seed_dack)
  union all select * from pg_temp.t('dack admin: SELECT', 'ALLOWED', 'authenticated', c.admin, 'select * from public.device_command_acks', c.seed_dack)
  union all select * from pg_temp.t('dack device: UPDATE', 'DENIED', 'authenticated', c.dev, $q$update public.device_command_acks set ok = false$q$, c.seed_dack)
  union all select * from pg_temp.t('dack device: DELETE', 'DENIED', 'authenticated', c.dev, 'delete from public.device_command_acks', c.seed_dack)
  union all select * from pg_temp.t('dack viewer: UPDATE', 'DENIED', 'authenticated', c.viewer, $q$update public.device_command_acks set ok = false$q$, c.seed_dack)
  union all select * from pg_temp.t('dack viewer: DELETE', 'DENIED', 'authenticated', c.viewer, 'delete from public.device_command_acks', c.seed_dack)
  union all select * from pg_temp.t('dack trigger: created_at se pisa a now()', 'ALLOWED', 'postgres', c.dev,
            $q$do $b$ declare t timestamptz; begin
                 insert into public.device_command_acks(command_id,device_id,ok,created_at)
                   values ('c0c0c0c0-0000-0000-0000-000000000001','4132',true, now() + interval '1 day') returning created_at into t;
                 if t > now() + interval '1 second' then raise exception 'created_at no pisado'; end if;
               end $b$q$, c.seed_dc)
  union all select * from pg_temp.t('dack: borrar el comando borra el ack (cascada)', 'ALLOWED', 'postgres', c.anon,
            $q$do $b$ begin
                 delete from public.device_commands where id = 'c0c0c0c0-0000-0000-0000-000000000001';
                 if exists (select 1 from public.device_command_acks where command_id = 'c0c0c0c0-0000-0000-0000-000000000001') then raise exception 'ack huerfano'; end if;
               end $b$q$, c.seed_dack)
  -- ---- events: tipos nuevos (not_worn, inactive, equip, fall_cancel) y regla de casco de baja (009) ----
  union all select * from pg_temp.t('ev device: INSERT not_worn', 'ALLOWED', 'authenticated', c.dev, $q$insert into public.events(device_id,type,payload) values ('4132','not_worn','{"s":120}')$q$)
  union all select * from pg_temp.t('ev device: INSERT inactive', 'ALLOWED', 'authenticated', c.dev, $q$insert into public.events(device_id,type,payload) values ('4132','inactive','{"s":300}')$q$)
  union all select * from pg_temp.t('ev device: INSERT equip', 'ALLOWED', 'authenticated', c.dev, $q$insert into public.events(device_id,type,payload) values ('4132','equip','{"kind":"bat_low","level":15}')$q$)
  union all select * from pg_temp.t('ev device: INSERT fall_cancel', 'ALLOWED', 'authenticated', c.dev, $q$insert into public.events(device_id,type) values ('4132','fall_cancel')$q$)
  union all select * from pg_temp.t('ev device: 31 equip/min (rate limit por casco y tipo)', 'DENIED', 'authenticated', c.dev, $q$do $b$ begin for i in 1..31 loop insert into public.events(device_id,type) values ('4132','equip'); end loop; end $b$q$)
  union all select * from pg_temp.t('ev viewer: INSERT not_worn (solo el casco)', 'DENIED', 'authenticated', c.viewer, $q$insert into public.events(device_id,type) values ('4132','not_worn')$q$)
  union all select * from pg_temp.t('ev casco de baja: INSERT sos (siempre aceptado)', 'ALLOWED', 'authenticated', c.dev_baja, $q$insert into public.events(device_id,type) values ('7777','sos')$q$, c.seed_dc_baja)
  union all select * from pg_temp.t('ev casco de baja: INSERT fall (siempre aceptado)', 'ALLOWED', 'authenticated', c.dev_baja, $q$insert into public.events(device_id,type) values ('7777','fall')$q$, c.seed_dc_baja)
  union all select * from pg_temp.t('ev casco de baja: INSERT heartbeat', 'DENIED', 'authenticated', c.dev_baja, $q$insert into public.events(device_id,type) values ('7777','heartbeat')$q$, c.seed_dc_baja)
  union all select * from pg_temp.t('ev casco de baja: INSERT not_worn', 'DENIED', 'authenticated', c.dev_baja, $q$insert into public.events(device_id,type) values ('7777','not_worn')$q$, c.seed_dc_baja)
  union all select * from pg_temp.t('ev casco de baja: INSERT inactive', 'DENIED', 'authenticated', c.dev_baja, $q$insert into public.events(device_id,type) values ('7777','inactive')$q$, c.seed_dc_baja)
  union all select * from pg_temp.t('ev casco de baja: INSERT equip', 'DENIED', 'authenticated', c.dev_baja, $q$insert into public.events(device_id,type) values ('7777','equip')$q$, c.seed_dc_baja)
  union all select * from pg_temp.t('ev casco de baja: INSERT fall_cancel', 'DENIED', 'authenticated', c.dev_baja, $q$insert into public.events(device_id,type) values ('7777','fall_cancel')$q$, c.seed_dc_baja)
  -- ---- device_config ----
  union all select * from pg_temp.t('cfg anon: SELECT', 'DENIED', 'anon', c.anon, 'select * from public.device_config', c.seed_cfg)
  union all select * from pg_temp.t('cfg sin rol: SELECT', 'DENIED', 'authenticated', c.norole, 'select * from public.device_config', c.seed_cfg)
  union all select * from pg_temp.t('cfg user_metadata falso: INSERT', 'DENIED', 'authenticated', c.usermeta, $q$insert into public.device_config(device_id,config) values ('5555','{"heartbeat_s":30}')$q$)
  union all select * from pg_temp.t('cfg device: SELECT su fila', 'ALLOWED', 'authenticated', c.dev, $q$select * from public.device_config where device_id='4132'$q$, c.seed_cfg)
  union all select * from pg_temp.t('cfg device: SELECT fila ajena', 'DENIED', 'authenticated', c.dev, $q$select * from public.device_config where device_id='9999'$q$, c.seed_cfg)
  union all select * from pg_temp.t('cfg device: ve exactamente 1 fila', 'ALLOWED', 'authenticated', c.dev, $q$do $b$ declare n int; begin select count(*) into n from public.device_config; if n <> 1 then raise exception 've %', n; end if; end $b$q$, c.seed_cfg)
  union all select * from pg_temp.t('cfg device sin claim device_id: SELECT', 'DENIED', 'authenticated', c.dev_noid, 'select * from public.device_config', c.seed_cfg)
  union all select * from pg_temp.t('cfg device: INSERT', 'DENIED', 'authenticated', c.dev, $q$insert into public.device_config(device_id,config) values ('4132','{"heartbeat_s":30}')$q$)
  union all select * from pg_temp.t('cfg device: UPDATE', 'DENIED', 'authenticated', c.dev, $q$update public.device_config set config = '{"heartbeat_s":5}' where device_id='4132'$q$, c.seed_cfg)
  union all select * from pg_temp.t('cfg viewer: SELECT todo', 'ALLOWED', 'authenticated', c.viewer, 'select * from public.device_config', c.seed_cfg)
  union all select * from pg_temp.t('cfg admin: SELECT todo', 'ALLOWED', 'authenticated', c.admin, 'select * from public.device_config', c.seed_cfg)
  union all select * from pg_temp.t('cfg viewer: INSERT (solo admin)', 'DENIED', 'authenticated', c.viewer, $q$insert into public.device_config(device_id,config) values ('5555','{"heartbeat_s":30}')$q$)
  union all select * from pg_temp.t('cfg viewer: UPDATE (solo admin)', 'DENIED', 'authenticated', c.viewer, $q$update public.device_config set config = '{"heartbeat_s":5}' where device_id='4132'$q$, c.seed_cfg)
  union all select * from pg_temp.t('cfg admin: INSERT', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.device_config(device_id,config) values ('5555','{"heartbeat_s":30}')$q$)
  union all select * from pg_temp.t('cfg admin: INSERT con todas las claves permitidas', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.device_config(device_id,config) values ('5555','{"fall_g_threshold":2.5,"inactivity_s":300,"not_worn_s":120,"heartbeat_s":30,"location_s":15,"location_s_alert":5,"stream_audio":true,"voice_commands":false,"broadcast_volume":0.8,"torch_allowed":true}')$q$)
  union all select * from pg_temp.t('cfg admin: UPDATE', 'ALLOWED', 'authenticated', c.admin, $q$update public.device_config set config = '{"heartbeat_s":60}' where device_id='4132'$q$, c.seed_cfg)
  union all select * from pg_temp.t('cfg admin: upsert (on conflict do update)', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.device_config(device_id,config) values ('4132','{"heartbeat_s":45}') on conflict (device_id) do update set config = excluded.config$q$, c.seed_cfg)
  union all select * from pg_temp.t('cfg admin: clave no permitida', 'DENIED', 'authenticated', c.admin, $q$insert into public.device_config(device_id,config) values ('5555','{"root_shell":true}')$q$)
  union all select * from pg_temp.t('cfg admin: numero como texto', 'DENIED', 'authenticated', c.admin, $q$insert into public.device_config(device_id,config) values ('5555','{"heartbeat_s":"30"}')$q$)
  union all select * from pg_temp.t('cfg admin: booleano como numero', 'DENIED', 'authenticated', c.admin, $q$insert into public.device_config(device_id,config) values ('5555','{"torch_allowed":1}')$q$)
  union all select * from pg_temp.t('cfg admin: config no objeto', 'DENIED', 'authenticated', c.admin, $q$insert into public.device_config(device_id,config) values ('5555','[1]')$q$)
  union all select * from pg_temp.t('cfg admin: device_id con HTML', 'DENIED', 'authenticated', c.admin, $q$insert into public.device_config(device_id,config) values ('<b>','{}')$q$)
  union all select * from pg_temp.t('cfg admin: UPDATE device_id (sin grant)', 'DENIED', 'authenticated', c.admin, $q$update public.device_config set device_id = '1111' where device_id='4132'$q$, c.seed_cfg)
  union all select * from pg_temp.t('cfg admin: falsear updated_by (sin grant)', 'DENIED', 'authenticated', c.admin, $q$insert into public.device_config(device_id,config,updated_by) values ('5555','{}','00000000-0000-0000-0000-0000000000aa')$q$)
  union all select * from pg_temp.t('cfg admin: falsear updated_at (sin grant)', 'DENIED', 'authenticated', c.admin, $q$update public.device_config set updated_at = now() - interval '1 year' where device_id='4132'$q$, c.seed_cfg)
  union all select * from pg_temp.t('cfg admin: DELETE (sin grant)', 'DENIED', 'authenticated', c.admin, 'delete from public.device_config', c.seed_cfg)
  union all select * from pg_temp.t('cfg trigger: updated_by/updated_at los fija el servidor', 'ALLOWED', 'authenticated', c.admin,
            $q$do $b$ declare u uuid; t timestamptz; begin
                 update public.device_config set config = '{"heartbeat_s":20}' where device_id = '4132' returning updated_by, updated_at into u, t;
                 if u is distinct from '00000000-0000-0000-0000-000000000006'::uuid or t < now() - interval '1 second' then raise exception 'updated_by=% updated_at=%', u, t; end if;
               end $b$q$, c.seed_cfg)
  union all select * from pg_temp.t('cfg trigger: JWT viewer se rechaza (aun como postgres)', 'DENIED', 'postgres', c.viewer, $q$insert into public.device_config(device_id,config) values ('5555','{}')$q$)
  union all select * from pg_temp.t('cfg trigger: sesion sin JWT (SQL Editor) permitida', 'ALLOWED', 'postgres', c.anon, $q$insert into public.device_config(device_id,config) values ('5555','{}')$q$)
  -- ---- roles: viewer solo lee / atiende / manda video, foto, linterna, ping y mensajes ----
  union all select * from pg_temp.t('rol viewer: INSERT casco', 'DENIED', 'authenticated', c.viewer, $q$insert into public.devices(device_id,name) values ('5555','x')$q$)
  union all select * from pg_temp.t('rol viewer: UPDATE casco', 'DENIED', 'authenticated', c.viewer, $q$update public.devices set name = 'x' where device_id = '4132'$q$, c.seed_eq)
  union all select * from pg_temp.t('rol viewer: baja de casco', 'DENIED', 'authenticated', c.viewer, $q$update public.devices set deleted_at = now() where device_id = '9999'$q$, c.seed_eq)
  union all select * from pg_temp.t('rol viewer: INSERT persona', 'DENIED', 'authenticated', c.viewer, $q$insert into public.people(full_name) values ('x')$q$)
  union all select * from pg_temp.t('rol viewer: UPDATE persona', 'DENIED', 'authenticated', c.viewer, $q$update public.people set job_title = 'x' where id = 'b2b2b2b2-0000-0000-0000-000000000002'$q$, c.seed_eq)
  union all select * from pg_temp.t('rol viewer: INSERT grupo', 'DENIED', 'authenticated', c.viewer, $q$insert into public.groups(name) values ('x')$q$)
  union all select * from pg_temp.t('rol viewer: UPDATE grupo', 'DENIED', 'authenticated', c.viewer, $q$update public.groups set name = 'x' where id = 'a1a1a1a1-0000-0000-0000-000000000001'$q$, c.seed_eq)
  union all select * from pg_temp.t('rol viewer: INSERT asignacion', 'DENIED', 'authenticated', c.viewer, $q$insert into public.assignments(device_id,person_id) values ('9999','b2b2b2b2-0000-0000-0000-000000000002')$q$, c.seed_eq)
  union all select * from pg_temp.t('rol viewer: cerrar asignacion', 'DENIED', 'authenticated', c.viewer, $q$update public.assignments set ends_at = now()$q$, c.seed_eq)
  union all select * from pg_temp.t('rol viewer: INSERT zona', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('rol viewer: UPDATE zona', 'DENIED', 'authenticated', c.viewer, $q$update public.geofences set name = 'x' where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('rol viewer: baja de zona', 'DENIED', 'authenticated', c.viewer, $q$update public.geofences set deleted_at = now() where id = '99999999-0000-0000-0000-000000000001'$q$, c.seed_gf)
  union all select * from pg_temp.t('rol viewer: INSERT punto', 'DENIED', 'authenticated', c.viewer, $q$insert into public.geo_points(name,category,lat,lng) values ('p','extintor',-34.6,-58.4)$q$)
  union all select * from pg_temp.t('rol viewer: UPDATE punto', 'DENIED', 'authenticated', c.viewer, $q$update public.geo_points set name = 'x' where id = 'dddddddd-0000-0000-0000-000000000001'$q$, c.seed_gp)
  union all select * from pg_temp.t('rol viewer: INSERT evacuacion', 'DENIED', 'authenticated', c.viewer, $q$insert into public.broadcasts(kind,message) values ('evacuacion','')$q$)
  union all select * from pg_temp.t('rol viewer: INSERT mensaje', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.broadcasts(kind,message) values ('mensaje','Vuelvan a la base')$q$)
  union all select * from pg_temp.t('rol admin: INSERT evacuacion', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.broadcasts(kind,message) values ('evacuacion','')$q$)
  union all select * from pg_temp.t('rol trigger: evacuacion con JWT viewer se rechaza (aun como postgres)', 'DENIED', 'postgres', c.viewer, $q$insert into public.broadcasts(kind,message) values ('evacuacion','')$q$)
  union all select * from pg_temp.t('rol trigger: viewer no escribe zonas (aun como postgres)', 'DENIED', 'postgres', c.viewer, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('rol viewer: atender alerta (event_acks)', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.event_acks(event_id,note) values ('eeeeeeee-0000-0000-0000-000000000001','ok')$q$, c.seed_esc_ev)
  union all select * from pg_temp.t('rol viewer: stream_commands start', 'ALLOWED', 'authenticated', c.viewer, $q$insert into public.stream_commands(device_id,action) values ('4132','start')$q$)
  union all select * from pg_temp.t('rol viewer: lee zonas y registro', 'ALLOWED', 'authenticated', c.viewer, $q$do $b$ begin perform 1 from public.geofences; perform 1 from public.geo_points; perform 1 from public.groups; perform 1 from public.assignments; perform 1 from public.devices_full; end $b$q$, c.seed_eq)
  union all select * from pg_temp.t('rol admin: INSERT casco', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.devices(device_id,name) values ('5555','x')$q$)
  union all select * from pg_temp.t('rol admin: INSERT grupo', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.groups(name) values ('x')$q$)
  union all select * from pg_temp.t('rol admin: INSERT zona', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.geofences(name,kind,shape,geometry) values ('z','restringida','circle','{"center":[-34.6,-58.4],"radius_m":100}')$q$)
  union all select * from pg_temp.t('rol admin: INSERT punto', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.geo_points(name,category,lat,lng) values ('p','extintor',-34.6,-58.4)$q$)
  union all select * from pg_temp.t('rol admin: INSERT asignacion', 'ALLOWED', 'authenticated', c.admin, $q$insert into public.assignments(device_id,person_id) values ('9999','b2b2b2b2-0000-0000-0000-000000000002')$q$, c.seed_eq)
  union all select * from pg_temp.t('rol device: INSERT casco', 'DENIED', 'authenticated', c.dev, $q$insert into public.devices(device_id,name) values ('5555','x')$q$)
  -- ---- incident_report ----
  union all select * from pg_temp.t('ir anon: SELECT', 'DENIED', 'anon', c.anon, 'select * from public.incident_report', c.seed_inc)
  union all select * from pg_temp.t('ir sin rol: SELECT (0 filas)', 'DENIED', 'authenticated', c.norole, 'select * from public.incident_report', c.seed_inc)
  union all select * from pg_temp.t('ir device: SELECT (0 filas)', 'DENIED', 'authenticated', c.dev, 'select * from public.incident_report', c.seed_inc)
  union all select * from pg_temp.t('ir viewer: SELECT', 'ALLOWED', 'authenticated', c.viewer, 'select * from public.incident_report', c.seed_inc)
  union all select * from pg_temp.t('ir admin: SELECT', 'ALLOWED', 'authenticated', c.admin, 'select * from public.incident_report', c.seed_inc)
  union all select * from pg_temp.t('ir viewer: solo alertas (sos, geocerca restringida, not_worn)', 'ALLOWED', 'authenticated', c.viewer, $q$do $b$ declare n int; begin select count(*) into n from public.incident_report where event_id in ('eeeeeeee-0000-0000-0000-000000000011','eeeeeeee-0000-0000-0000-000000000012','eeeeeeee-0000-0000-0000-000000000013','eeeeeeee-0000-0000-0000-000000000014','eeeeeeee-0000-0000-0000-000000000015'); if n <> 3 then raise exception 'n=%', n; end if; end $b$q$, c.seed_inc)
  union all select * from pg_temp.t('ir viewer: tta_s = 90 en la atendida y null en la pendiente', 'ALLOWED', 'authenticated', c.viewer, $q$do $b$ declare a int; p int; r text; begin select tta_s, payload ->> 'reason' into a, r from public.incident_report where event_id = 'eeeeeeee-0000-0000-0000-000000000011'; select tta_s into p from public.incident_report where event_id = 'eeeeeeee-0000-0000-0000-000000000015'; if a is distinct from 90 or p is not null or r is distinct from 'hombre_caido' then raise exception 'tta=% pend=% reason=%', a, p, r; end if; end $b$q$, c.seed_inc)
  -- ---- Tanda 4: configuracion estatica ----
  union all select 'RLS activo en device_commands', 'OK', case when (select relrowsecurity from pg_class where oid = 'public.device_commands'::regclass) then 'OK' else 'BAD' end, ((select relrowsecurity from pg_class where oid = 'public.device_commands'::regclass))
  union all select 'RLS activo en device_command_acks', 'OK', case when (select relrowsecurity from pg_class where oid = 'public.device_command_acks'::regclass) then 'OK' else 'BAD' end, ((select relrowsecurity from pg_class where oid = 'public.device_command_acks'::regclass))
  union all select 'RLS activo en device_config', 'OK', case when (select relrowsecurity from pg_class where oid = 'public.device_config'::regclass) then 'OK' else 'BAD' end, ((select relrowsecurity from pg_class where oid = 'public.device_config'::regclass))
  union all select 'tanda4: sin policy de DELETE/ALL', 'OK', case when not exists (select 1 from pg_policies where schemaname='public' and tablename in ('device_commands','device_command_acks','device_config') and cmd in ('DELETE','ALL')) then 'OK' else 'BAD' end, (not exists (select 1 from pg_policies where schemaname='public' and tablename in ('device_commands','device_command_acks','device_config') and cmd in ('DELETE','ALL')))
  union all select 'tanda4: sin policy de UPDATE en commands y acks', 'OK', case when not exists (select 1 from pg_policies where schemaname='public' and tablename in ('device_commands','device_command_acks') and cmd = 'UPDATE') then 'OK' else 'BAD' end, (not exists (select 1 from pg_policies where schemaname='public' and tablename in ('device_commands','device_command_acks') and cmd = 'UPDATE'))
  union all select 'tanda4: anon sin privilegios', 'OK', case when not exists (select 1 from information_schema.role_table_grants where table_schema='public' and table_name in ('device_commands','device_command_acks','device_config','incident_report') and grantee='anon') then 'OK' else 'BAD' end, (not exists (select 1 from information_schema.role_table_grants where table_schema='public' and table_name in ('device_commands','device_command_acks','device_config','incident_report') and grantee='anon'))
  union all select 'tanda4: authenticated sin DELETE/TRUNCATE', 'OK', case when not (has_table_privilege('authenticated','public.device_commands','DELETE') or has_table_privilege('authenticated','public.device_command_acks','DELETE') or has_table_privilege('authenticated','public.device_config','DELETE') or has_table_privilege('authenticated','public.device_commands','TRUNCATE') or has_table_privilege('authenticated','public.device_command_acks','TRUNCATE') or has_table_privilege('authenticated','public.device_config','TRUNCATE')) then 'OK' else 'BAD' end, (not (has_table_privilege('authenticated','public.device_commands','DELETE') or has_table_privilege('authenticated','public.device_command_acks','DELETE') or has_table_privilege('authenticated','public.device_config','DELETE') or has_table_privilege('authenticated','public.device_commands','TRUNCATE') or has_table_privilege('authenticated','public.device_command_acks','TRUNCATE') or has_table_privilege('authenticated','public.device_config','TRUNCATE')))
  union all select 'device_commands: solo device_id/action/params son insertables', 'OK', case when has_column_privilege('authenticated','public.device_commands','device_id','INSERT') and has_column_privilege('authenticated','public.device_commands','action','INSERT') and has_column_privilege('authenticated','public.device_commands','params','INSERT') and not (has_column_privilege('authenticated','public.device_commands','id','INSERT') or has_column_privilege('authenticated','public.device_commands','requested_by','INSERT') or has_column_privilege('authenticated','public.device_commands','requested_by_email','INSERT') or has_column_privilege('authenticated','public.device_commands','created_at','INSERT')) then 'OK' else 'BAD' end, (has_column_privilege('authenticated','public.device_commands','device_id','INSERT') and has_column_privilege('authenticated','public.device_commands','action','INSERT') and has_column_privilege('authenticated','public.device_commands','params','INSERT') and not (has_column_privilege('authenticated','public.device_commands','id','INSERT') or has_column_privilege('authenticated','public.device_commands','requested_by','INSERT') or has_column_privilege('authenticated','public.device_commands','requested_by_email','INSERT') or has_column_privilege('authenticated','public.device_commands','created_at','INSERT')))
  union all select 'device_config: solo config es actualizable', 'OK', case when has_column_privilege('authenticated','public.device_config','config','UPDATE') and not (has_column_privilege('authenticated','public.device_config','device_id','UPDATE') or has_column_privilege('authenticated','public.device_config','updated_by','UPDATE') or has_column_privilege('authenticated','public.device_config','updated_at','UPDATE')) then 'OK' else 'BAD' end, (has_column_privilege('authenticated','public.device_config','config','UPDATE') and not (has_column_privilege('authenticated','public.device_config','device_id','UPDATE') or has_column_privilege('authenticated','public.device_config','updated_by','UPDATE') or has_column_privilege('authenticated','public.device_config','updated_at','UPDATE')))
  union all select 'tanda4: 3 tablas en publicacion realtime', 'OK', case when (select count(*) from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename in ('device_commands','device_command_acks','device_config')) = 3 then 'OK' else 'BAD' end, ((select count(*) from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename in ('device_commands','device_command_acks','device_config')) = 3)
  union all select 'events.type acepta los 11 tipos', 'OK', case when coalesce((select bool_and(d ~ ('''' || t || '''')) from (select pg_get_constraintdef(oid) as d from pg_constraint where conname='events_type_check' and conrelid='public.events'::regclass) x, unnest(array['sos','photo','video','heartbeat','fall','location','geofence','not_worn','inactive','equip','fall_cancel']) t), false) then 'OK' else 'BAD' end, coalesce((select bool_and(d ~ ('''' || t || '''')) from (select pg_get_constraintdef(oid) as d from pg_constraint where conname='events_type_check' and conrelid='public.events'::regclass) x, unnest(array['sos','photo','video','heartbeat','fall','location','geofence','not_worn','inactive','equip','fall_cancel']) t), false)
  union all select 'incident_report: security_invoker', 'OK', case when exists (select 1 from pg_class where oid = 'public.incident_report'::regclass and 'security_invoker=true' = any (reloptions)) then 'OK' else 'BAD' end, (exists (select 1 from pg_class where oid = 'public.incident_report'::regclass and 'security_invoker=true' = any (reloptions)))
  union all select 'roles: trigger admin-only en las 7 tablas', 'OK', case when (select count(distinct tgrelid) from pg_trigger where tgname = 'aa_admin_only_trg' and not tgisinternal and tgrelid in ('public.groups'::regclass,'public.devices'::regclass,'public.people'::regclass,'public.assignments'::regclass,'public.geofences'::regclass,'public.geo_points'::regclass,'public.device_config'::regclass)) = 7 then 'OK' else 'BAD' end, ((select count(distinct tgrelid) from pg_trigger where tgname = 'aa_admin_only_trg' and not tgisinternal and tgrelid in ('public.groups'::regclass,'public.devices'::regclass,'public.people'::regclass,'public.assignments'::regclass,'public.geofences'::regclass,'public.geo_points'::regclass,'public.device_config'::regclass)) = 7)
  union all select 'roles: ninguna policy de escritura nombra a viewer en las tablas admin (si falla: volver a correr 010)', 'OK', case when not exists (select 1 from pg_policies where schemaname='public' and tablename in ('groups','devices','people','assignments','geofences','geo_points','device_config') and cmd in ('INSERT','UPDATE') and (coalesce(qual,'') || coalesce(with_check,'')) ~ 'viewer') then 'OK' else 'BAD' end, (not exists (select 1 from pg_policies where schemaname='public' and tablename in ('groups','devices','people','assignments','geofences','geo_points','device_config') and cmd in ('INSERT','UPDATE') and (coalesce(qual,'') || coalesce(with_check,'')) ~ 'viewer'))
  union all select 'device_command_ack_ok: SECURITY DEFINER y sin EXECUTE para anon', 'OK', case when (select prosecdef from pg_proc where oid = 'public.device_command_ack_ok(uuid,text)'::regprocedure) and not has_function_privilege('anon','public.device_command_ack_ok(uuid,text)','EXECUTE') then 'OK' else 'BAD' end, ((select prosecdef from pg_proc where oid = 'public.device_command_ack_ok(uuid,text)'::regprocedure) and not has_function_privilege('anon','public.device_command_ack_ok(uuid,text)','EXECUTE'))
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
