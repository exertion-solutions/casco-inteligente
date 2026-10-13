// Valida la migracion 014 (avisos por correo) y rls_test.sql contra Postgres real en WASM (PGlite), sin tocar Supabase.
// Uso:   npm i @electric-sql/pglite   (en una carpeta temporal; o PGLITE=<ruta al index.js>)   y despues
//        node supabase/tests/pglite-014.mjs
// Carga: stubs minimos de Supabase (roles, auth.jwt/uid, storage, cron, net.http_post) + ejecutar-todo.sql (incluye 001-014)
//        + 014 dos veces (idempotencia) + casos de comportamiento del trigger y de los recordatorios + rls_test.sql.
// No prueba: pg_net/pg_cron reales, GoTrue/PostgREST, Realtime. net.http_post y cron.schedule son stubs que registran las llamadas.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sb = p => fs.readFileSync(path.join(here, '..', p), 'utf8');
const { PGlite } = await import(process.env.PGLITE ? pathToFileURL(process.env.PGLITE).href : '@electric-sql/pglite');
const db = new PGlite();

const STUBS = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
-- (usage en auth se concede mas abajo)
create schema auth; create schema extensions; create schema storage; create schema net; create schema cron;
create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
create table auth.users(id uuid primary key default gen_random_uuid(), email text, raw_app_meta_data jsonb default '{}'::jsonb);
create table storage.buckets(id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, created_at timestamptz default now());
create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
grant usage on schema auth to anon, authenticated, service_role;
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.objects, storage.buckets to authenticated, service_role;
create publication supabase_realtime;
-- net: stub que registra las llamadas (la real es asincrona)
create table net.calls(id bigserial primary key, url text, headers jsonb, body jsonb, at timestamptz default now());
create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
  headers jsonb default '{"Content-Type":"application/json"}', timeout_milliseconds integer default 5000) returns bigint
language plpgsql as $$ declare i bigint; begin insert into net.calls(url, headers, body) values (url, headers, body) returning id into i; return i; end $$;
-- cron: stub que registra los jobs
create table cron.job(jobid bigserial primary key, jobname text, schedule text, command text, active boolean default true);
create function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job(jobname, schedule, command) values (n, s, c) returning jobid $$;
create function cron.unschedule(j bigint) returns boolean language sql as $$ delete from cron.job where jobid = j returning true $$;
create function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname = n returning true $$;
`;
// Extensiones que PGlite no trae: se quitan de ejecutar-todo (gen_random_uuid() es nativo; net y cron son los stubs de arriba).
const strip = s => s.replace(/^create extension if not exists (pgcrypto|pg_cron|pg_net).*$/gim, '');

let fails = 0;
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fails++; };
const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => Object.values((await q(sql, params))[0] || {})[0];
const err = async sql => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };

process.on('unhandledRejection', e => { console.log('ERROR: ' + (e && e.message || e)); process.exit(2); });
await db.exec(STUBS);
const ET = strip(sb('ejecutar-todo.sql'));
await db.exec(ET);
ok(true, 'ejecutar-todo.sql (001-014) carga sin errores');
await db.exec(sb('migrations/014_avisos_correo.sql'));
await db.exec(sb('migrations/014_avisos_correo.sql'));
await db.exec(sb('migrations/015_push_y_proveedor_correo.sql'));
await db.exec(sb('migrations/015_push_y_proveedor_correo.sql'));
ok(true, '015 (aditiva) re-ejecutada 2 veces sin errores');
ok((await one(`select count(*) from cron.job where jobname = 'casco-notify-reminders'`)) == 1, '014 re-ejecutada: sigue 1 solo job de cron');
ok((await one(`select schedule from cron.job where jobname = 'casco-notify-reminders'`)) === '* * * * *', 'job de recordatorios cada minuto');
ok((await one(`select count(*) from public.notify_config`)) == 1 && (await one(`select enabled from public.notify_config`)) === false, 'notify_config: 1 fila, enabled = false por defecto');

// ---- severidad (misma tabla que sevOf de web/app.js) ----
const sev = async (t, p) => Number(await one(`select public.notify_severity($1, $2::jsonb)`, [t, p ? JSON.stringify(p) : null]));
ok(await sev('sos') === 3 && await sev('fall') === 3 && await sev('inactive') === 2 && await sev('not_worn') === 1, 'severidad: sos/fall 3, inactive 2, not_worn 1');
ok(await sev('geofence', { kind: 'peligro', action: 'enter' }) === 2 && await sev('geofence', { kind: 'restringida', action: 'enter' }) === 1
  && await sev('geofence', { kind: 'permitida', action: 'exit' }) === 1, 'severidad: geocerca peligro 2, restringida/permitida 1');
ok(await sev('geofence', { kind: 'peligro', action: 'exit' }) === 0 && await sev('geofence', null) === 0 && await sev('photo') === 0 && await sev('heartbeat') === 0, 'severidad: salir de peligro, geocerca sin payload, foto y heartbeat = 0');

// ---- trigger: deshabilitado no llama; habilitado llama una vez por evento critico/alto/medio ----
const calls = async () => q(`select body, headers, url from net.calls order by id`);
await db.exec(`insert into public.events(device_id,type) values ('4132','sos')`);
ok((await calls()).length === 0, 'trigger: con enabled = false no llama a la funcion');
await db.exec(`update public.notify_config set enabled = true where id = 1`);
await db.exec(`insert into public.events(device_id,type) values ('4132','sos')`);
ok((await calls()).length === 0, 'trigger: enabled pero sin webhook_secret no llama');
await db.exec(`update public.notify_config set webhook_secret = 'secreto-de-prueba-123' where id = 1`);
await db.exec(`insert into public.events(id,device_id,type) values ('11111111-1111-1111-1111-111111111111','4132','sos')`);
let c = await calls();
ok(c.length === 1 && c[0].body.event_id === '11111111-1111-1111-1111-111111111111' && c[0].body.kind === 'inmediato'
  && c[0].headers['x-notify-secret'] === 'secreto-de-prueba-123' && /\/functions\/v1\/notify$/.test(c[0].url), 'trigger: sos -> POST {event_id, kind: inmediato} con x-notify-secret');
await db.exec(`insert into public.events(device_id,type) values ('4132','heartbeat'),('4132','location'),('4132','photo')`);
ok((await calls()).length === 1, 'trigger: heartbeat/location/photo no disparan');
await db.exec(`insert into public.events(device_id,type,payload) values ('4132','geofence','{"kind":"peligro","action":"enter"}'),
  ('4132','geofence','{"kind":"peligro","action":"exit"}'), ('4132','fall','{}'), ('4133','inactive','{}')`);
ok((await calls()).length === 4, 'trigger: peligro/enter, fall e inactive disparan; peligro/exit no (' + (await calls()).length + ')');

// ---- el trigger nunca bloquea el insert (falla de net.http_post) ----
await db.exec(`alter function net.http_post(text, jsonb, jsonb, jsonb, integer) rename to http_post_ok;
  create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 5000)
  returns bigint language plpgsql as $$ begin raise exception 'pg_net caido'; end $$;`);
const before = Number(await one(`select count(*) from public.events`));
ok(await err(`insert into public.events(device_id,type) values ('4132','sos')`) === null && Number(await one(`select count(*) from public.events`)) === before + 1,
  'trigger: si pg_net falla el evento se guarda igual');
await db.exec(`drop function net.http_post(text, jsonb, jsonb, jsonb, integer); alter function net.http_post_ok(text, jsonb, jsonb, jsonb, integer) rename to http_post;`);

// ---- recordatorios ----
await db.exec(`delete from net.calls; delete from public.event_acks; delete from public.notify_log; delete from public.events;`);
await db.exec(`
  insert into public.events(id,device_id,type) values
    ('a0000000-0000-0000-0000-000000000001','4132','sos'),   -- sin atender, vieja: recordatorio
    ('a0000000-0000-0000-0000-000000000002','4132','sos'),   -- atendida: no
    ('a0000000-0000-0000-0000-000000000003','4132','sos'),  -- reciente: no
    ('a0000000-0000-0000-0000-000000000004','4133','not_worn'),   -- media: sin recordatorio
    ('a0000000-0000-0000-0000-000000000005','4133','inactive'),   -- alta, sin atender: si
    ('a0000000-0000-0000-0000-000000000006','4133','sos'),     -- fuera de ventana: no
    ('a0000000-0000-0000-0000-000000000007','4134','geofence');   -- sin payload: no
  update public.events set created_at = now() - interval '5 minutes' where id::text like 'a0000000%' and right(id::text, 1) in ('1','2','4','5','7');
  update public.events set created_at = now() - interval '30 seconds' where id = 'a0000000-0000-0000-0000-000000000003';
  update public.events set created_at = now() - interval '3 hours' where id = 'a0000000-0000-0000-0000-000000000006';
  insert into public.event_acks(event_id, acked_by) values ('a0000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000009');
  delete from net.calls;`);   // el trigger de los inserts anteriores no cuenta
let n = Number(await one(`select public.notify_reminders()`));
c = await calls();
const ids = c.map(x => x.body.event_id).sort();
ok(n === 2 && JSON.stringify(ids) === JSON.stringify(['a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000005']) && c.every(x => x.body.kind === 'recordatorio'),
  'recordatorios: solo criticas/altas sin atender, vencidas y dentro de la ventana (' + n + ')');
// sin fila en notify_log (la escribe la funcion): el cron volveria a llamar; la funcion es la que garantiza "una sola vez"
await db.exec(`delete from net.calls; insert into public.notify_log(event_id,kind,status,sent_at) values
  ('a0000000-0000-0000-0000-000000000001','recordatorio','ok', now() - interval '1 minute'),
  ('a0000000-0000-0000-0000-000000000005','recordatorio','error', now() - interval '2 minutes')`);
n = Number(await one(`select public.notify_reminders()`));
c = await calls();
ok(n === 1 && c[0].body.event_id === 'a0000000-0000-0000-0000-000000000005' && c[0].body.kind === 'recordatorio',
  'recordatorios: un evento con recordatorio ok no se repite; uno en error se reintenta (' + n + ')');
await db.exec(`update public.notify_log set attempts = 5 where status = 'error'; delete from net.calls`);
ok(Number(await one(`select public.notify_reminders()`)) === 0, 'recordatorios: tope de 5 intentos');
await db.exec(`update public.notify_config set enabled = false; delete from net.calls`);
ok(Number(await one(`select public.notify_reminders()`)) === 0 && (await calls()).length === 0, 'recordatorios: con enabled = false no llama');
await db.exec(`update public.notify_config set enabled = true`);

// ---- notify_claim: idempotencia ----
await db.exec(`delete from public.notify_log`);
const E = 'a0000000-0000-0000-0000-000000000001';
ok(await one(`select public.notify_claim('${E}','inmediato')`) === true, 'claim: primera vez true');
ok(await one(`select public.notify_claim('${E}','inmediato')`) === false, 'claim: segunda vez (en curso) false');
ok(await one(`select public.notify_claim('${E}','recordatorio')`) === true, 'claim: otro kind es independiente');
await db.exec(`update public.notify_log set status = 'ok'`);
await db.exec(`update public.notify_log set sent_at = now() - interval '5 minutes'`);
ok(await one(`select public.notify_claim('${E}','inmediato')`) === false, 'claim: lo que ya salio ok no se reenvia');
await db.exec(`update public.notify_log set status = 'error', sent_at = now() - interval '2 minutes' where kind = 'inmediato'`);
ok(await one(`select public.notify_claim('${E}','inmediato')`) === true && Number(await one(`select attempts from public.notify_log where kind = 'inmediato'`)) === 2, 'claim: un error viejo se retoma (intento 2)');
ok(await err(`select public.notify_claim('ffffffff-ffff-ffff-ffff-ffffffffffff','inmediato')`) !== null, 'claim: evento inexistente falla (FK)');

// ---- notify_status ----
const asRole = async (claims, sql) => {
  await db.exec(`begin; select set_config('request.jwt.claims', '${claims}', true); set local role authenticated;`);
  try { return await one(sql); } finally { await db.exec(`rollback`); }
};
await db.exec(`insert into public.notify_recipients(email, min_severity) values ('nombre@ejemplo.com','alta'), ('otro@ejemplo.com','critica')`);
const vw = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000005","app_metadata":{"role":"viewer"}}';
const ad = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000006","app_metadata":{"role":"admin"}}';
const dv = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000003","app_metadata":{"role":"device","device_id":"4132"}}';
const sv = await asRole(vw, `select public.notify_status()`);
ok(sv.ready === true && !('recipients' in sv) && !('enabled' in sv), 'notify_status viewer: solo ready (sin detalle)');
const sa = await asRole(ad, `select public.notify_status()`);
ok(sa.ready === true && Number(sa.recipients) === 2 && sa.remind_after_s === 180 && sa.secret_ok === true, 'notify_status admin: detalle con 2 destinatarios');
let dn = null; try { await asRole(dv, `select public.notify_status()`); } catch (e) { dn = e.message; }
ok(dn !== null, 'notify_status device: rechazado');

// ---- notify_bootstrap / notify_set_channel (solo admin; nunca devuelven la clave ni la URL) ----
const commitAs = async (claims, sql) => {
  await db.exec(`begin; select set_config('request.jwt.claims', '${claims}', true); set local role authenticated;`);
  try { return await one(sql); } finally { await db.exec(`commit`); }
};
const failAs = async (claims, sql) => { try { await commitAs(claims, sql); return null; } catch (e) { await db.exec('rollback').catch(() => {}); return e.message; } };
await db.exec(`update public.notify_config set webhook_secret = null, webhook_url = null where id = 1`);
ok(await failAs(vw, `select public.notify_bootstrap()`) !== null, 'bootstrap: viewer rechazado');
ok(await commitAs(ad, `select public.notify_bootstrap()`) === true, 'bootstrap: admin genera la clave y devuelve solo true');
const sec1 = await one(`select webhook_secret from public.notify_config`);
ok(/^[0-9a-f]{64}$/.test(sec1), 'bootstrap: clave de 64 hex');
ok(await commitAs(ad, `select public.notify_bootstrap()`) === true && (await one(`select webhook_secret from public.notify_config`)) === sec1, 'bootstrap: idempotente (no cambia una clave existente)');
ok(await failAs(vw, `select public.notify_set_channel('https://hooks.example.test/x')`) !== null, 'set_channel: viewer rechazado');
ok(await failAs(ad, `select public.notify_set_channel('http://hooks.example.test/x')`) !== null, 'set_channel: http rechazado');
ok(await failAs(ad, `select public.notify_set_channel('https://a b')`) !== null, 'set_channel: con espacios rechazado');
ok(await failAs(ad, `select public.notify_set_channel('https://x.test/' || repeat('a', 500))`) !== null, 'set_channel: > 500 rechazado');
ok(await commitAs(ad, `select public.notify_set_channel('  https://hooks.example.test/flujo?sig=abc  ')`) === true
  && (await one(`select webhook_url from public.notify_config`)) === 'https://hooks.example.test/flujo?sig=abc', 'set_channel: guarda https (recortada)');
const st = await commitAs(ad, `select public.notify_status()`);
ok(st.channel_ok === true && st.secret_ok === true && !JSON.stringify(st).includes('hooks.example') && !JSON.stringify(st).includes(sec1), 'notify_status: channel_ok sin exponer URL ni clave');
ok(await commitAs(ad, `select public.notify_set_channel('')`) === false && (await one(`select webhook_url from public.notify_config`)) === null, 'set_channel: vacio quita el canal');
ok(await err(`update public.notify_config set webhook_url = 'ftp://x'`) !== null, 'webhook_url: check https');

// ---- 015: push_subscribe / visibilidad / notify_push_key / notify_set_email ----
const v2 = '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000000b","app_metadata":{"role":"viewer"}}';
const P = `'BPpPpPpPpPpPpPpPpPpPpPpPpPpPpPp','aaaaaaaaaaaaaaaaaaaa','ua','alta'`;
ok(await commitAs(vw, `select public.push_subscribe('https://push.example.test/a1', ${P})`) === true, 'push_subscribe: viewer registra un dispositivo');
ok(await commitAs(vw, `select public.push_subscribe('https://push.example.test/a1', ${P})`) === true
  && Number(await one(`select count(*) from public.push_subscriptions where endpoint = 'https://push.example.test/a1'`)) === 1, 'push_subscribe: idempotente (upsert)');
ok(await failAs(vw, `select public.push_subscribe('http://push.example.test/x', ${P})`) !== null, 'push_subscribe: http rechazado');
ok(await failAs(dv, `select public.push_subscribe('https://push.example.test/d', ${P})`) !== null, 'push_subscribe: device rechazado');
await commitAs(v2, `select public.push_subscribe('https://push.example.test/b1', ${P})`);
ok(Number(await commitAs(vw, `select count(*) from public.push_subscriptions`)) === 1, 'push: el viewer ve solo sus dispositivos');
ok(Number(await commitAs(ad, `select count(*) from public.push_subscriptions`)) === 2, 'push: el admin ve todos');
await commitAs(v2, `select public.push_subscribe('https://push.example.test/a1', ${P})`);
ok(await one(`select user_id::text from public.push_subscriptions where endpoint = 'https://push.example.test/a1'`) === '00000000-0000-0000-0000-00000000000b', 'push_subscribe: el dispositivo pasa al usuario que lo activa');
for (let i = 0; i < 10; i++) await commitAs(vw, `select public.push_subscribe('https://push.example.test/m${i}', ${P})`);
ok(await failAs(vw, `select public.push_subscribe('https://push.example.test/m10', ${P})`) !== null, 'push_subscribe: maximo 10 dispositivos por usuario');
ok(await commitAs(vw, `select public.notify_push_key()`) === null, 'notify_push_key: null hasta que la funcion genere el par');
await db.exec(`update public.notify_config set vapid_public = 'BClavePublicaDePrueba', vapid_private = '{"d":"x"}' where id = 1`);
ok(await commitAs(vw, `select public.notify_push_key()`) === 'BClavePublicaDePrueba', 'notify_push_key: devuelve solo la publica');
ok(await failAs(dv, `select public.notify_push_key()`) !== null, 'notify_push_key: device rechazado');
ok(await failAs(vw, `select public.notify_set_email('brevo','xkeysib-clave-de-prueba-1234','avisos@ejemplo.com',null)`) !== null, 'notify_set_email: viewer rechazado');
ok(await failAs(ad, `select public.notify_set_email('otro','xkeysib-clave-de-prueba-1234','avisos@ejemplo.com',null)`) !== null, 'notify_set_email: proveedor invalido');
ok(await failAs(ad, `select public.notify_set_email('brevo','','avisos@ejemplo.com',null)`) !== null, 'notify_set_email: sin clave previa exige clave');
ok(await commitAs(ad, `select public.notify_set_email('Brevo','xkeysib-clave-de-prueba-1234',' Avisos@Ejemplo.com ','Avisos Casco')`) === true, 'notify_set_email: guarda y devuelve true (nunca la clave)');
ok((await one(`select email_from from public.notify_config`)) === 'avisos@ejemplo.com' && (await one(`select email_provider from public.notify_config`)) === 'brevo', 'notify_set_email: normaliza proveedor y remitente');
ok(await commitAs(ad, `select public.notify_set_email('resend','','avisos@ejemplo.com','')`) === true
  && (await one(`select email_api_key from public.notify_config`)) === 'xkeysib-clave-de-prueba-1234', 'notify_set_email: clave vacia conserva la guardada');
const st2 = await commitAs(ad, `select public.notify_status()`);
ok(st2.email_ok === true && st2.push_ok === true && Number(st2.push_devices) === 12 && st2.email_provider === 'resend'
  && !JSON.stringify(st2).includes('xkeysib') && !JSON.stringify(st2).includes('"d":"x"'), 'notify_status: email_ok / push_ok / dispositivos, sin claves');
const st3 = await commitAs(vw, `select public.notify_status()`);
ok(st3.push_ok === true && Number(st3.my_devices) === 10 && !('email_ok' in st3), 'notify_status viewer: push_ok y mis dispositivos, sin detalle de correo');
ok(await commitAs(ad, `select public.notify_set_email('', '', '', '')`) === false
  && (await one(`select email_api_key from public.notify_config`)) === null, 'notify_set_email: vacio quita proveedor y borra la clave');
ok(await err(`update public.notify_config set email_provider = 'smtp'`) !== null, 'email_provider: check brevo|resend');
await db.exec(`delete from public.push_subscriptions; update public.notify_config set vapid_public = null, vapid_private = null`);

// ---- rls_test.sql (arranca de una instalacion limpia: sin destinatarios, log ni secreto) ----
await db.exec(`delete from public.notify_recipients; delete from public.notify_log; delete from public.events;
  update public.notify_config set enabled = false, webhook_secret = null where id = 1;`);
const res = await db.exec(sb('tests/rls_test.sql'));
const rows = (res.filter(r => r.fields && r.fields.some(f => f.name === 'ok')).pop() || { rows: [] }).rows;
const bad = rows.filter(r => r.ok !== true);
console.log('rls_test: ' + rows.length + ' casos, ' + bad.length + ' fallos');
bad.forEach(r => console.log('  FALLA: ' + r.test + ' (esperado ' + r.expected + ', obtenido ' + r.got + ')'));
ok(rows.length > 0 && bad.length === 0, 'rls_test.sql sin fallos');
const mine = rows.filter(r => /^aviso/.test(r.test));
ok(mine.length >= 20, 'rls_test.sql incluye los casos de avisos (' + mine.length + ')');

console.log(fails ? '\n' + fails + ' FALLOS' : '\nTODO OK');
process.exit(fails ? 1 : 0);
