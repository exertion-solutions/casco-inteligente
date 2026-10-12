-- Pruebas de RLS / Storage para Casco Inteligente.
-- USO: Supabase > SQL Editor > pegar TODO > Run. Es solo lectura neta: cada caso corre
-- en una subtransaccion que se revierte (no deja filas ni objetos).
-- Resultado: una tabla con columnas test | expected | got | ok. TODAS deben ser ok = true.
-- Requiere haber ejecutado antes supabase/schema.sql.
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
  $s$insert into storage.objects(bucket_id,name) values ('casco-media','4132/photo/seed.jpg')$s$ as seed_obj
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
