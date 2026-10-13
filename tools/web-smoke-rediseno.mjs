// Smoke visual del visor (mocks de Supabase, PNG en out/). Uso: node tools/web-smoke-rediseno.mjs [tag]
// Env: WEBDIR (carpeta web). Requiere playwright o playwright-core instalado (npm i -D playwright-core) y Chrome.
let chromium;
for (const m of ['playwright', 'playwright-core', 'file:///C:/Users/jcastro/eia-app/node_modules/.pnpm/playwright-core@1.63.0/node_modules/playwright-core/index.mjs']) {
  try { ({ chromium } = await import(m)); break; } catch {}
}
if (!chromium) throw new Error('Falta playwright/playwright-core: npm i -D playwright-core');
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const WEB = process.env.WEBDIR || 'C:/CASCO INTELIGENTE/web';
const OUT = 'C:/CASCO INTELIGENTE/out';
const TAG = process.argv[2] || 'a';
const SB = 'https://zgfvhjpdzkohouktakvt.supabase.co';
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(WEB, p);
  if (!f.startsWith(path.normalize(WEB)) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:' + server.address().port + '/';

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwtOf = role => b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: 'u1', role: 'authenticated', exp: 4102444800, app_metadata: { role } }) + '.sig';
const iso = ms => new Date(Date.now() - ms).toISOString();
const events = [
  { id: 'e-sos', device_id: '4132', type: 'sos', created_at: iso(192000), lat: -34.6, lng: -58.4, battery: 15, payload: null, media_path: null },
  { id: 'e-md', device_id: '4133', type: 'fall', created_at: iso(41000), lat: -34.601, lng: -58.402, battery: 70, payload: { reason: 'hombre_caido', still_s: 20 } },
  { id: 'e-geo', device_id: '4133', type: 'geofence', created_at: iso(75000), lat: null, lng: null, battery: 70, payload: { kind: 'peligro', action: 'enter', zone_name: 'Pileta de ácido' } },
  { id: 'e-done', device_id: '4140', type: 'sos', created_at: iso(900000), lat: null, lng: null, battery: 50, payload: null },
  { id: 'e-photo', device_id: '4132', type: 'photo', created_at: iso(600000), lat: null, lng: null, battery: 15, payload: null },
];
const acks = [{ event_id: 'e-done', acked_by_email: 'sup@demo.test', acked_at: iso(900000 - 101000), note: 'Falsa alarma, el operario ya está bien' }];
const hbs = [
  { device_id: '4132', created_at: iso(30000), battery: 15, type: 'heartbeat', payload: { bat: 15, lvl: 3, sig: -85, net: 'LTE', temp_c: 38, free_mb: 8000, app: '1.4.2', up_s: 7300, rot: 90 } },
  { device_id: '4133', created_at: iso(20000), battery: 70, type: 'heartbeat', payload: { bat: 70, lvl: 4, net: '4G', temp_c: 47, free_mb: 800, rot: 270 } },
  { device_id: '4140', created_at: iso(30 * 60000), battery: 50, type: 'heartbeat', payload: { bat: 50 } },
];
const locs = [
  { device_id: '4132', created_at: iso(300000), lat: -34.6, lng: -58.4, battery: 15 },
  { device_id: '4132', created_at: iso(60000), lat: -34.603, lng: -58.398, battery: 15 },
  { device_id: '4133', created_at: iso(50000), lat: -34.601, lng: -58.402, battery: 70 },
  { device_id: '4133', created_at: iso(10000), lat: 0, lng: 0, battery: 70 },
];
const T4_EVENTS = [
  { id: 'e-nw', device_id: '4140', type: 'not_worn', created_at: iso(50000), lat: null, lng: null, battery: 50, payload: null, media_path: null },
  { id: 'e-in', device_id: '4133', type: 'inactive', created_at: iso(45000), lat: null, lng: null, battery: 70, payload: { still_s: 310 }, media_path: null },
  { id: 'e-eq', device_id: '4132', type: 'equip', created_at: iso(120000), lat: null, lng: null, battery: 15, payload: { kind: 'bat_low', level: 18 }, media_path: null },
  { id: 'e-fc', device_id: '4133', type: 'fall_cancel', created_at: iso(130000), lat: null, lng: null, battery: 70, payload: {}, media_path: null },
  { id: 'e-ph2', device_id: '4132', type: 'photo', created_at: iso(5000), lat: null, lng: null, battery: 15, payload: { cmd: 'cmd-1' }, media_path: '4132/1.jpg' },
  { id: 'e-ph3', device_id: '4132', type: 'photo', created_at: iso(6000), lat: null, lng: null, battery: 15, payload: {}, media_path: '4132/2.jpg' },
  { id: 'e-ph4', device_id: '4132', type: 'photo', created_at: iso(7000), lat: null, lng: null, battery: 15, payload: {}, media_path: '4132/3.jpg' },
];
const T4_HB = { device_id: '4160', created_at: iso(15000), battery: 80, type: 'heartbeat', payload: { bat: 80 } };
const REP = Array.from({ length: 120 }, (_, i) => ({ event_id: 'r' + String(i).padStart(3, '0'), created_at: iso((i + 1) * 3600000), device_id: i % 2 ? '4132' : '4133',
  type: ['sos', 'fall', 'geofence', 'not_worn', 'inactive'][i % 5], payload: i % 5 === 1 ? { reason: 'hombre_caido', still_s: 20 } : null,
  lat: -34.6 - i / 10000, lng: -58.4, acked_at: i % 3 === 0 ? iso((i + 1) * 3600000 - 95000) : null, acked_by_email: i % 3 === 0 ? 'sup@demo.test' : null,
  note: i % 3 === 0 ? 'Nota; con punto y coma' : null, tta_s: i % 3 === 0 ? 95 : null }));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const NEWT = ['device_commands', 'device_command_acks', 'device_config', 'incident_report', 'event_archive'];
const devicesT = [
  { device_id: '4132', name: 'Casco Perforación', model: 'rd_aqm6816', group_id: 'g1', sector: 'Pozo 12', status: 'activo', imei: '860000000000001' },
  { device_id: '4133', name: 'Casco Mantenimiento', model: 'rd_aqm6816', group_id: 'g1', sector: 'Planta', status: 'activo' },
  { device_id: '4140', name: 'Casco Reserva', model: 'rd_aqm6816', group_id: null, sector: '', status: 'mantenimiento' },
];
const people = [{ id: 'p1', full_name: 'Marcos Peralta', legajo: '1042', job_title: 'Operario', sector: 'Pozo 12', group_id: 'g1', active: true, dni: '30111222', contact_phone: '+54 11 5555-1234' },
  { id: 'p2', full_name: 'Lucía Ferreyra', legajo: '1077', job_title: 'Técnica', sector: 'Planta', group_id: 'g1', active: true }];
const groups = [{ id: 'g1', name: 'Cuadrilla Norte', site: 'Yacimiento Sur', notes: '', active: true }];
const assigns = [{ id: 'a1', device_id: '4132', person_id: 'p1', starts_at: iso(86400000), ends_at: null }];
// ---- Tanda C: tablas de la migracion 013 ----
const NEW013 = ['assist_sessions', 'epp_deliveries', 'training_records', 'training_attendees', 'training_attendees_audit', 'access_log', 'org_settings', 'rpc/log_access', 'rpc/create_training'];
const PNG_SHA = crypto.createHash('sha256').update(PNG).digest('hex');
const P1 = { full_name: 'Marcos Peralta', legajo: '1042', job_title: 'Operario', sector: 'Pozo 12' };
const SEED_ASSIST = { id: 'as-seed', device_id: '4132', started_at: iso(7200000), ended_at: iso(7200000 - 600000), topic: 'Calibrar la bomba', outcome: 'derivado', note: 'Pasa a mantenimiento', photos: 2,
  opened_by: 'u1', opened_by_email: 'sup@demo.test', closed_by_email: 'sup@demo.test' };
const SEED_EPP = { id: 'epp-seed', person_id: 'p1', device_id: null, item: 'Guantes dieléctricos', quantity: 1, model: 'GD-20', brand: 'Marca X', certified: true, cert_ref: 'IRAM 3604',
  delivered_at: '2026-10-01', worker_ack: 'conforme', observation: null, supersedes: null, created_by_email: 'sup@demo.test', created_at: iso(86400000 * 10), person: P1 };
const SEED_TRN = { id: 'trn-seed', held_at: iso(86400000 * 3), topic: 'Trabajo en altura', trainer: 'Ing. Ríos', modality_place: 'presencial', modality_sync: 'sincronica', assisted: true,
  duration_min: 90, supersedes: null, created_by_email: 'sup@demo.test', created_at: iso(86400000 * 3) };
const SEED_ATT = [{ training_id: 'trn-seed', person_id: 'p1', ack: 'conforme', observation: null, person: { full_name: 'Marcos Peralta', legajo: '1042' } },
  { training_id: 'trn-seed', person_id: 'p2', ack: 'con_observaciones', observation: 'Falta el arnés talle M', person: { full_name: 'Lucía Ferreyra', legajo: '1077' } }];
const ACT = ['view_live', 'export_csv', 'command', 'photo', 'assist_open', 'login'];
const ACCESS = Array.from({ length: 120 }, (_, i) => ({ id: 120 - i, at: iso((i + 1) * 60000), user_email: i % 2 ? 'sup@demo.test' : 'adm@demo.test', role: i % 2 ? 'viewer' : 'admin',
  action: ACT[i % ACT.length], target: '4132', detail: { n: i } }));
const geofences = [{ id: 'z1', name: 'Pileta de ácido', kind: 'restringida', shape: 'circle', geometry: { center: [-34.602, -58.399], radius_m: 120 }, message: 'Zona restringida', alarm: 'voz_y_sirena', device_ids: null, active: true }];
const points = [{ id: 'pt1', name: 'Punto de reunión A', category: 'punto_reunion', lat: -34.605, lng: -58.395, notes: '', alert_radius_m: null, active: true }];

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
async function mock(ctx, opts = {}) {
  const H = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
  await ctx.route('https://216-238-110-97.sslip.io/**', r => {
    if (!opts.whep) return r.fulfill({ status: 503, headers: H, body: 'no' });
    const m = r.request().method();
    if (m === 'OPTIONS') return r.fulfill({ status: 204, headers: H });
    if (m === 'POST' && opts.whepFailMs) {
      const SS = opts.state || (opts.state = {});
      SS.whepT0 = SS.whepT0 || Date.now(); SS.whepHits = (SS.whepHits || 0) + 1;
      if (Date.now() - SS.whepT0 < opts.whepFailMs) return r.fulfill({ status: 404, headers: H, body: 'no stream' });
    }
    if (m === 'POST') return r.fulfill({ status: 201, headers: { ...H, location: '/live/4132/whep/s1', 'content-type': 'application/sdp' }, body: 'v=0\r\n' });
    return r.fulfill({ status: 200, headers: H, body: '' });
  });
  await ctx.route(SB + '/**', async route => {
    const req = route.request(), u = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const json = (o, status = 200) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(o) });
    const role = opts.role || 'admin', S = opts.state || (opts.state = {});
    if (u.pathname.includes('/auth/v1/token')) return json({ access_token: jwtOf(role), token_type: 'bearer', expires_in: 3600, refresh_token: 'r', user: { id: 'u1', email: 'supervisor@demo.test', app_metadata: { role }, aud: 'authenticated', created_at: iso(0) } });
    if (u.pathname.includes('/auth/v1/user')) return json({ id: 'u1', email: 'supervisor@demo.test', app_metadata: { role } });
    if (u.pathname.includes('/storage/')) {
      if (req.method() === 'DELETE') {
        let b = {}; try { b = JSON.parse(req.postData() || '{}'); } catch {}
        (S.deleted = S.deleted || []);
        if (S.delMode === 'err') return json({ statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' }, 403);
        if (S.delMode === 'rls') return json([]);
        S.deleted.push(...(b.prefixes || []));
        return json((b.prefixes || []).map(n => ({ name: n })));
      }
      if (req.method() === 'GET') return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'image/png' }, body: PNG });
      return json({ signedURL: '/object/sign/casco-media/x.jpg?token=t' });
    }
    const t = u.pathname.split('/rest/v1/')[1] || '';
    if (opts.noNew && NEWT.includes(t)) { S.hits = (S.hits || []).concat(t); return json({ code: 'PGRST205', message: "Could not find the table 'public." + t + "' in the schema cache" }, 404); }
    if (opts.noNew && NEW013.includes(t)) { S.hits013 = (S.hits013 || []).concat(t); return json({ code: t.startsWith('rpc/') ? 'PGRST202' : 'PGRST205', message: t.startsWith('rpc/') ? 'Could not find the function public.' + t.slice(4) + ' in the schema cache' : "Could not find the table 'public." + t + "' in the schema cache" }, 404); }
    if (req.method() !== 'GET' && req.method() !== 'HEAD') {
      let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch {}
      (S.posts = S.posts || []).push({ t, method: req.method(), body });
      if (t === 'rpc/log_access') {
        if (S.logFail > 0) { S.logFail--; return json({ code: 'XX000', message: 'boom' }, 500); }
        (S.logs = S.logs || []).push(body);
        return route.fulfill({ status: 204, headers: CORS });
      }
      if (t === 'assist_sessions') {
        const A = (S.assist = S.assist || [SEED_ASSIST]);
        if (req.method() === 'POST') {
          const row = { id: 'as-' + (A.length + 1), device_id: body.device_id, started_at: new Date().toISOString(), ended_at: null, topic: body.topic || null, outcome: null, note: null, photos: 0,
            opened_by: 'u1', opened_by_email: 'supervisor@demo.test', closed_by_email: null };
          A.push(row); return json(row, 201);
        }
        const id = (u.searchParams.get('id') || '').replace('eq.', ''), row = A.find(x => x.id === id && !x.ended_at);
        if (!row) return json({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: 'The result contains 0 rows' }, 406);
        Object.assign(row, body, { closed_by_email: 'supervisor@demo.test' });
        return json(row);
      }
      if (t === 'epp_deliveries') {
        const E = (S.epp = S.epp || [SEED_EPP]);
        const row = { id: 'epp-' + (E.length + 1), ...body, created_by_email: 'supervisor@demo.test', created_at: new Date().toISOString(), person: people.find(p => p.id === body.person_id) };
        E.push(row); return json({ id: row.id }, 201);
      }
      if (t === 'rpc/create_training') {
        const T = (S.trn = S.trn || [SEED_TRN]), A = (S.att = S.att || SEED_ATT.slice());
        const id = 'trn-' + (T.length + 1);
        T.push({ id, held_at: body.held_at, topic: body.topic, trainer: body.trainer, modality_place: body.modality_place, modality_sync: body.modality_sync, assisted: body.assisted,
          duration_min: body.duration_min, supersedes: body.supersedes || null, created_by_email: 'supervisor@demo.test', created_at: new Date().toISOString() });
        for (const a of body.attendees) A.push({ training_id: id, person_id: a.person_id, ack: a.ack, observation: a.observation || null, person: people.find(p => p.id === a.person_id) });
        return json(id, 200);
      }
      if (t === 'org_settings') {
        if (req.method() === 'PATCH') { if (!S.org) return json([]); Object.assign(S.org, body); return json([S.org]); }
        S.org = { ...body }; return json([S.org], 201);
      }
      if (t === 'event_archive') {
        S.arch = S.arch || [];
        if (req.method() === 'DELETE') { const id = (u.searchParams.get('event_id') || '').replace('eq.', ''); S.arch = S.arch.filter(x => x.event_id !== id); return route.fulfill({ status: 204, headers: CORS }); }
        const dup = (Array.isArray(body) ? body : []).some(b => S.arch.some(x => x.event_id === b.event_id));
        if (dup && !/resolution=/.test(req.headers()['prefer'] || '')) return json({ code: '23505', message: 'duplicate key' }, 409);
        for (const b of (Array.isArray(body) ? body : [])) if (!S.arch.some(x => x.event_id === b.event_id)) S.arch.push({ event_id: b.event_id, archived_by_email: 'supervisor@demo.test', archived_at: new Date().toISOString(), reason: b.reason });
        return route.fulfill({ status: 201, headers: CORS });
      }
      if (t === 'device_commands') { const n = (S.cmdSeq = (S.cmdSeq || 0) + 1); return json({ id: 'cmd-' + n, created_at: new Date().toISOString() }, 201); }
      if (t === 'broadcasts') return json({ id: 'bc-' + Date.now(), kind: body.kind, message: body.message, device_ids: body.device_ids, repeat: body.repeat, created_at: new Date().toISOString(), created_by_email: 'supervisor@demo.test' }, 201);
      return json(req.method() === 'POST' ? [{ id: 'new' }] : [], 201);
    }
    const q = u.search;
    if (t === 'event_archive') return json((S.arch || []).slice());
    if (t === 'assist_sessions') {
      let A = (S.assist = S.assist || [SEED_ASSIST]).slice();
      if (u.searchParams.get('ended_at') === 'is.null') A = A.filter(x => !x.ended_at);
      for (const c of u.searchParams.getAll('started_at')) { const m = c.match(/^(gte|lt)\.(.+)$/); if (m) A = A.filter(x => (m[1] === 'gte' ? x.started_at >= m[2] : x.started_at < m[2])); }
      return json(A.sort((a, b) => b.started_at.localeCompare(a.started_at)));
    }
    if (t === 'epp_deliveries') return json((S.epp = S.epp || [SEED_EPP]).slice().reverse());
    if (t === 'training_records') return json((S.trn = S.trn || [SEED_TRN]).slice().reverse());
    if (t === 'training_attendees' || t === 'training_attendees_audit') {
      const rows = (S.att = S.att || SEED_ATT.slice());
      S.attTable = (S.attTable || []).concat(t);
      return json(t === 'training_attendees' ? rows : rows.map(a => ({ training_id: a.training_id, person_id: a.observation ? null : a.person_id, ack: a.ack, observation: a.observation })));
    }
    if (t === 'org_settings') return json(S.org ? [S.org] : []);
    if (t === 'access_log') {
      let rows = ACCESS.slice();
      const g = k => u.searchParams.get(k);
      if (g('action')) rows = rows.filter(r => 'eq.' + r.action === g('action'));
      if (g('id') && /^lt\./.test(g('id'))) rows = rows.filter(r => r.id < Number(g('id').slice(3)));
      return json(rows.slice(0, Number(g('limit')) || 1000));
    }
    if (t === 'device_command_acks') {
      const ids = ((u.searchParams.get('command_id') || '').match(/[\w-]+/g) || []).slice(1);
      return json((S.acks || []).filter(a => ids.includes(a.command_id)));
    }
    if (t === 'device_config') return json(S.cfg ? [{ config: S.cfg, updated_at: iso(1000) }] : []);
    if (t === 'incident_report') {
      let rows = REP.slice();
      const g = k => u.searchParams.get(k);
      if (g('type')) rows = rows.filter(r => 'eq.' + r.type === g('type'));
      if (g('device_id')) rows = rows.filter(r => 'eq.' + r.device_id === g('device_id'));
      if (g('acked_at') === 'is.null') rows = rows.filter(r => !r.acked_at);
      if (g('acked_at') === 'not.is.null') rows = rows.filter(r => r.acked_at);
      const m = (g('or') || '').match(/created_at\.lt\.([^,]+),and\(created_at\.eq\.[^,]+,event_id\.lt\.([^)]+)\)/);
      if (m) rows = rows.filter(r => r.created_at < m[1] || (r.created_at === m[1] && r.event_id < m[2]));
      return json(rows.slice(0, Number(g('limit')) || 1000));
    }
    if (t === 'broadcasts' && opts.t4) return json([{ id: 'b1', kind: 'mensaje', message: 'Revisar EPP', device_ids: ['4132', '4133'], repeat: 1, created_at: iso(300000), created_by_email: 'sup@demo.test' }]);
    if (t === 'broadcast_acks' && opts.t4) return json([{ broadcast_id: 'b1', device_id: '4132', played_at: iso(290000) }]);
    if (t === 'events') {
      if (opts.failEvents === 'srv') return json({ code: 'XX000', message: 'Error de servidor' }, 500);
      if (opts.failEvents) return json({ code: 'PGRST301', message: 'JWT expired' }, 401);
      if (q.includes('type=eq.heartbeat')) return json(opts.t4 ? [...hbs, T4_HB] : hbs);
      if (q.includes('type=eq.location')) return json(locs);
      const ex = opts.t4 ? T4_EVENTS : [];
      if (q.includes('type=in.')) return json([...(opts.evs || events), ...ex, ...(opts.old || [])]);
      return json([...((opts.state && opts.state.extra) || []), ...(opts.evs || events), ...ex]);
    }
    if (t === 'event_acks') {
      const one = (q.match(/event_id=eq\.([^&]+)/) || [])[1];   // maybeSingle() tras Atender
      if (one) return json([{ event_id: decodeURIComponent(one), acked_by_email: 'supervisor@demo.test', acked_at: new Date().toISOString(), note: null }]);
      return json(acks);
    }
    if (t === 'devices_full' || t === 'devices') return json(devicesT);
    if (t === 'people_full' || t === 'people') return json(people);
    if (t === 'groups') return json(groups);
    if (t === 'assignments') return json(assigns);
    if (t === 'geofences') return json(geofences);
    if (t === 'geo_points') return json(points);
    if (t === 'escalation_rules') return json([{ after_seconds: 120, enabled: true }]);
    return json([]);
  });
  await ctx.routeWebSocket(/realtime\/v1\/websocket/, ws => {
    if (opts.state) (opts.state.sockets || (opts.state.sockets = [])).push(ws);
    ws.onMessage(m => {
      let j; try { j = JSON.parse(m); } catch { return; }
      const rep = (payload) => ws.send(JSON.stringify({ ref: j.ref, join_ref: j.join_ref, topic: j.topic, event: 'phx_reply', payload }));
      if (j.event === 'phx_join') {
        const pc = (j.payload && j.payload.config && j.payload.config.postgres_changes) || [];
        rep({ status: 'ok', response: { postgres_changes: pc.map((c, i) => ({ ...c, id: i + 1 })) } });
      } else if (j.event === 'heartbeat') rep({ status: 'ok', response: {} });
      else if (j.event === 'phx_leave') rep({ status: 'ok', response: {} });
    });
  });
}

const browser = await chromium.launch({ channel: 'chrome', args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--disable-features=AudioServiceOutOfProcess', '--disable-gpu'] });
const errors = [];
const report = [];
const SIZES = [['1440', 1440, 900], ['1920', 1920, 1080], ['375', 375, 812]];
const log = (...a) => { console.log(...a); report.push(a.join(' ')); };

async function login(page) {
  await page.goto(BASE + 'index.html');
  await page.fill('#email', 'supervisor@demo.test');
  await page.fill('#password', 'x');
}
async function enter(page) {
  await page.click('#login button[type=submit]');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
  await page.waitForSelector('#pendList .pitem', { timeout: 15000 });
  await page.waitForTimeout(700);
  // Alarma SOS: cartel a pantalla completa visible al haber pendientes; se cierra con "Ver el panel" y la sirena sigue hasta atender.
  {
    const ov = page.locator('#sosOverlay');
    if (!(await ov.isVisible())) errors.push(`[${scheme} ${sz}] cartel SOS no visible con pendientes`);
    else {
      const t = await page.locator('#sosOvT').textContent();
      if (!/!$/.test(t)) errors.push(`[${scheme} ${sz}] titulo de cartel raro: ${t}`);
      await page.locator('.sos-ov-btns button').last().click();
      if (await ov.isVisible()) errors.push(`[${scheme} ${sz}] cartel no se cerro`);
    }
  }
}
const shot = (page, name) => page.screenshot({ path: `${OUT}/rediseno-${name}.png`, fullPage: false });

for (const scheme of process.env.ONLYFIX ? [] : ['dark', 'light']) {
  for (const [sz, w, h] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, locale: 'es-AR', timezoneId: 'America/Argentina/Buenos_Aires', serviceWorkers: 'block' });
    await mock(ctx);
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(`[${scheme} ${sz}] pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !/tile\.openstreetmap|fonts\.g|ERR_|favicon|sslip\.io\/live/.test(m.text() + (m.location().url || ''))) errors.push(`[${scheme} ${sz}] console.error: ${m.text()} @ ${m.location().url}`); });
    await login(page);
    if (sz === '1440' || sz === '375') await shot(page, `${TAG}-login-${sz}-${scheme}`);
    await enter(page);
    await shot(page, `${TAG}-centro-${sz}-${scheme}`);
    // layout checks
    const info = await page.evaluate(() => ({
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      pend: document.querySelectorAll('#pendList .pitem').length,
      sosDisplay: getComputedStyle(document.getElementById('sos')).display,
      sosText: document.getElementById('sos').innerText.slice(0, 200),
      status: document.getElementById('status').textContent,
      connState: document.getElementById('connWrap').dataset.state,
      title: document.title,
      rules: document.querySelectorAll('#pendList .rulebox').length,
      cursor0: document.querySelector('#pendList .rule-cursor') ? getComputedStyle(document.querySelector('#pendList .rule-cursor')).left : null,
      nav: [...document.querySelectorAll('#mainNav [role=tab]')].map(b => b.innerText.replace(/\s+/g, ' ').trim()),
      navBox: (() => { const r = document.getElementById('mainNav').getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })(),
      minTarget: Math.min(...[...document.querySelectorAll('button:not(.hidden),a.btn')].filter(e => e.offsetParent).map(e => e.getBoundingClientRect().height)),
      fonts: [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family + ' ' + f.weight).slice(0, 6),
    }));
    log(`[${scheme} ${sz}]`, JSON.stringify(info));
    if (info.overflowX) errors.push(`[${scheme} ${sz}] horizontal overflow in centro`);

    // En vivo
    await page.click('#tabLive'); await page.waitForTimeout(250);
    const start = page.locator('#lives .live', { hasText: '4132' }).locator('button', { hasText: 'Iniciar' }).first();
    if (await start.count()) { await start.click(); await page.waitForTimeout(500); }
    await shot(page, `${TAG}-envivo-${sz}-${scheme}`);
    // Mapa
    await page.click('#tabMap'); await page.waitForTimeout(1800);
    await shot(page, `${TAG}-mapa-${sz}-${scheme}`);
    // Equipos
    await page.click('#tabEq'); await page.waitForTimeout(400);
    await shot(page, `${TAG}-equipos-${sz}-${scheme}`);
    if (sz === '1440') { await page.click('#eqTabPeople'); await page.waitForTimeout(200); await shot(page, `${TAG}-equipos-personas-${sz}-${scheme}`); }
    // Historial
    await page.click('#tabDone'); await page.waitForTimeout(300);
    await shot(page, `${TAG}-historial-${sz}-${scheme}`);
    const hist = await page.evaluate(() => ({ items: document.querySelectorAll('#feedDone > li:not(.empty)').length, rules: document.querySelectorAll('#feedDone .rulebox').length, count: document.getElementById('doneCount').textContent }));
    log(`[${scheme} ${sz}] historial`, JSON.stringify(hist));
    await page.click('#tabCmd'); await page.waitForSelector('#cmdp-q', { timeout: 8000 }); await page.waitForTimeout(150);
    if (sz === '375') await shot(page, `${TAG}-comandos-tab-${sz}-${scheme}`);
    const ov = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    if (ov) errors.push(`[${scheme} ${sz}] horizontal overflow in a tab`);

    if (sz === '1440' && scheme === 'dark') {
      // flujo funcional: atender con nota
      await page.click('#tabMain'); await page.waitForTimeout(200);
      const card = page.locator('#pendList .pitem').first();
      await card.locator('input').fill('Voy en camino');
      let posted = null;
      page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/rest/v1/event_acks')) posted = r.postData(); });
      await card.locator('button.attend').click(); await page.waitForTimeout(600);
      log('atender POST:', posted);
      // teclado de pestañas
      await page.focus('#tabMain'); await page.keyboard.press('ArrowDown'); await page.waitForTimeout(100);
      log('tab tras ArrowDown:', await page.evaluate(() => document.activeElement.id + ' view=' + document.getElementById('panelMain').dataset.view));
      // tema persistente
      await page.click('#themeBtn');
      log('tema:', await page.evaluate(() => document.documentElement.dataset.theme + ' stored=' + localStorage.getItem('casco-theme')));
      await page.click('#tabMain');
      await shot(page, `${TAG}-centro-toggle-${sz}`);
      // evacuación / mensaje abren
      await page.click('#btnEvac'); await page.waitForTimeout(150);
      await shot(page, `${TAG}-centro-evac-${sz}`);
      await page.click('#evacCancel');
      // SOS por realtime vía error-state: no testeable aquí; ver estado de foco
    }
    await ctx.close();
  }
}

// estado de error con reintento + login con error
if (!process.env.ONLYFIX) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', locale: 'es-AR', serviceWorkers: 'block' });
  await mock(ctx, { failEvents: 'srv' });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('[err-state] pageerror: ' + e.message));
  await login(page);
  await page.click('#login button[type=submit]');
  await page.waitForSelector('#pendList .err-state', { timeout: 15000 });
  await page.waitForTimeout(300);
  await shot(page, `${TAG}-estado-error-1440-dark`);
  log('error-state:', await page.evaluate(() => document.querySelector('#pendList .err-state').innerText.replace(/\s+/g, ' ')));
  await ctx.close();
}

// ---- Casos de la correccion web: pendiente viejo, resync tras reconexion, sesion vencida, grabacion/cartel ----
const FAKE_RTC = () => {
  class FakePC {
    constructor() { this.iceGatheringState = 'complete'; this.connectionState = 'new'; this.localDescription = { type: 'offer', sdp: 'v=0\r\n' }; this.ontrack = null; this.onconnectionstatechange = null; }
    addTransceiver() {} addEventListener() {} removeEventListener() {}
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\n' }; }
    async setLocalDescription() {}
    async getStats() { return new Map(); }
    close() { this.connectionState = 'closed'; }
    async setRemoteDescription() {
      setTimeout(() => {
        const c = document.createElement('canvas'); c.width = 320; c.height = 240; const x = c.getContext('2d');
        let k = 0; setInterval(() => { x.fillStyle = 'hsl(' + ((k += 17) % 360) + ',70%,50%)'; x.fillRect(0, 0, 320, 240); }, 50);
        const vs = c.captureStream(15);
        if (window.__noTrack) { this.connectionState = 'connected'; if (this.onconnectionstatechange) this.onconnectionstatechange(); return; }
        const ac = (window.__fac = window.__fac || new AudioContext()), d = ac.createMediaStreamDestination(), o = ac.createOscillator(); o.connect(d); o.start();
        this.connectionState = 'connected';
        if (this.ontrack) { if (!window.__noAudio) this.ontrack({ track: d.stream.getAudioTracks()[0], streams: [d.stream] }); this.ontrack({ track: vs.getVideoTracks()[0], streams: [vs] }); }
        if (this.onconnectionstatechange) this.onconnectionstatechange();
      }, 60);
    }
  }
  window.RTCPeerConnection = FakePC;
  if (!window.__micDeny) {
    navigator.mediaDevices.getUserMedia = async () => { const ac = (window.__fac = window.__fac || new AudioContext()), d = ac.createMediaStreamDestination(), o = ac.createOscillator(); o.connect(d); o.start(); return d.stream; };
  } else {
    navigator.mediaDevices.getUserMedia = async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); };
  }
};
async function newPage(opts, deny, extraInit) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', locale: 'es-AR', timezoneId: 'America/Argentina/Buenos_Aires', serviceWorkers: 'block', acceptDownloads: true });
  await mock(ctx, opts);
  if (process.env.NOAUTO || process.env.NOCROP) await ctx.addInitScript("let v;Object.defineProperty(window,'CASCO_CONFIG',{get:()=>v,set:x=>{v=x;" + (process.env.NOAUTO ? 'x.REC_AUTO_ON_ALERT=false;' : '') + (process.env.NOCROP ? 'x.OVERLAY_CROP={};' : '') + "}})");
  await ctx.addInitScript('window.__noTrack=' + (process.env.NOTRACK ? 'true' : 'false') + ';window.__noAudio=' + (process.env.NOAUDIO ? 'true' : 'false') + ';window.__micDeny=' + (deny ? 'true' : 'false') + ';(' + FAKE_RTC.toString() + ')()');
  if (extraInit) await ctx.addInitScript(extraInit);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('[fix] pageerror: ' + e.message));
  page.on('crash', () => console.log('PAGE CRASH'));
  page.on('console', m => { if (m.type() === 'error' && !/tile.openstreetmap|fonts.g|ERR_|favicon/.test(m.text())) console.log('console.error:', m.text().slice(0, 200)); });
  await login(page);
  await page.click('#login button[type=submit]');
  await page.waitForSelector('#pendList .pitem', { timeout: 15000 });
  await page.waitForTimeout(500);
  return [ctx, page];
}
const closeOv = async page => { if (await page.locator('#sosOverlay').isVisible()) await page.locator('.sos-ov-btns button').last().click(); };
const check = (ok, msg) => { log((ok ? 'OK   ' : 'FAIL ') + msg); if (!ok) errors.push('[fix] ' + msg); };

// 1) pendiente viejo (5 dias, fuera de los ultimos 50) + sin select('*')
if (!process.env.ONLY4) {
  const state = {};
  const old = [{ id: 'e-old', device_id: '4140', type: 'sos', created_at: iso(5 * 86400000), lat: null, lng: null, battery: 40, payload: null, media_path: null }];
  const reqs = [];
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'es-AR', serviceWorkers: 'block' });
  ctx.on('request', r => { if (r.url().includes('/rest/v1/')) reqs.push(r.url()); });
  await mock(ctx, { old, state });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('[old] pageerror: ' + e.message));
  await login(page);
  await page.click('#login button[type=submit]');
  await page.waitForSelector('#pendList .pitem', { timeout: 15000 });
  await page.waitForTimeout(800);
  const n = await page.locator('#pendList .pitem').count();
  check(n === 4, 'pendiente viejo (7 dias) aparece junto a los 3 recientes (pendientes=' + n + ')');
  const star = reqs.filter(u => /[?&]select=\*/.test(u) || /select=%2A/.test(u));
  check(star.length === 0, "ninguna consulta usa select('*') (" + star.length + ')');
  const fb = reqs.filter(u => /\/events\?/.test(u) && /type=in\./.test(u)).length;
  check(fb >= 1, 'consulta explicita de SOS/caida/geocerca de 7 dias enviada');
  await ctx.close();
}

// 2) resync tras reconexion: llega un SOS mientras el canal estaba caido
if (!process.env.ONLY4) {
  const state = { extra: [] };
  const [ctx, page] = await newPage({ state });
  await closeOv(page);
  const before = await page.locator('#pendList .pitem').count();
  state.extra = [{ id: 'e-gap', device_id: '4150', type: 'sos', created_at: iso(1000), lat: null, lng: null, battery: 60, payload: null, media_path: null }];
  const nsock = state.sockets ? state.sockets.length : 0;
  if (nsock) await state.sockets[nsock - 1].close();
  let got = false;
  for (let i = 0; i < 40 && !got; i++) { await page.waitForTimeout(500); got = (await page.locator('#pendList .pitem').count()) === before + 1; }
  check(got, 'resync al reconectar Realtime recupera el SOS perdido (antes ' + before + ')');
  check(await page.locator('#sosOverlay').isVisible(), 'cartel SOS reaparece por la alerta recuperada');
  for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
  const inside = await page.evaluate(() => document.getElementById('sosOverlay').contains(document.activeElement));
  check(inside, 'la trampa de foco mantiene el foco dentro del cartel SOS');
  await page.keyboard.press('Escape');
  check(await page.locator('#sosOverlay').isVisible(), 'Escape NO descarta el cartel de una alerta critica');
  await page.locator('.sos-ov-btns button').last().click();
  check(!(await page.locator('#sosOverlay').isVisible()), 'Ver el panel cierra el cartel SOS');
  const inert = await page.evaluate(() => document.getElementById('app').inert);
  check(!inert, 'el panel deja de estar inerte al cerrar el cartel');
  await ctx.close();
}

// 3) sesion vencida: 401 al consultar eventos
if (!process.env.ONLY4) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'es-AR', serviceWorkers: 'block' });
  await mock(ctx, { failEvents: true });
  const page = await ctx.newPage();
  await login(page);
  await page.click('#login button[type=submit]');
  await page.waitForSelector('#sessBar', { timeout: 15000 });
  const txt = await page.locator('#sessBar').innerText();
  check(/Sesión vencida, ingresá de nuevo/.test(txt), 'aviso de sesion vencida ante 401/JWT expired');
  await page.locator('#sessBar button').click();
  check(await page.locator('#login').isVisible(), 'vuelve al login desde el aviso de sesion vencida');
  await ctx.close();
}

// 4) grabacion automatica por alerta + cartel de guardado (con y sin permiso de microfono)
for (const deny of [false, true]) {
  const [ctx, page] = await newPage({ whep: true }, deny);
  const tag = deny ? '[sin micro] ' : '[con micro] ';
  const ping = async n => { const t = Date.now(); const ok = await Promise.race([page.evaluate(() => 1), new Promise(r => setTimeout(() => r('HUNG'), 4000))]); if (process.env.DBG) console.log('ping', n, ok, Date.now() - t); };
  await ping('a');
  await closeOv(page); await ping('b');
  await page.click('#tabLive'); await ping('c');
  const sec = page.locator('#lives .live', { hasText: '4132' });
  await sec.locator('button', { hasText: 'Iniciar' }).first().click(); await ping('d');
  await page.waitForTimeout(300); await ping('e'); await page.waitForTimeout(1000); await ping('f');
  let rec = '';
  for (let i = 0; i < 40 && !/REC automático por alerta/.test(rec); i++) { await page.waitForTimeout(400); rec = await sec.locator('.recdot').innerText({ timeout: 300 }).catch(() => ''); }
  if (process.env.DBG) console.log('PANEL:', (await sec.innerText()).replace(/\s+/g, ' ').slice(0, 500));
  check(/REC automático por alerta/.test(rec), tag + 'grabacion automatica arranca sola con SOS pendiente y video en vivo: ' + rec.slice(0, 50));
  await page.waitForTimeout(1200);
  const st = await sec.locator('.rec .state').innerText({ timeout: 2000 }).catch(() => '');
  if (deny) check(/sin micrófono: permiso pendiente/.test(st), tag + 'estado avisa sin micrófono: ' + st.slice(0, 90));
  else check(/micrófono/.test(st), tag + 'estado incluye micrófono: ' + st.slice(0, 90));
  await page.waitForTimeout(1500);
  await page.click('#tabMain');
  await page.locator('#pendList .pitem', { hasText: '4132' }).first().locator('button.attend').click();
  await page.waitForSelector('#saveOverlay:not([hidden])', { timeout: 10000 });
  const body = await page.locator('#saveOverlay').innerText();
  check(/Casco 4132/.test(body) && /vigia-4132_/.test(body) && /duración/.test(body), tag + 'cartel de guardado muestra casco, duracion y archivo');
  check(/solo en tu PC/.test(body) && /Informá al personal/.test(body), tag + 'cartel incluye aviso de guardado solo en la PC');
  if (deny) check(/sin micrófono/.test(body), tag + 'cartel avisa que no hay micrófono');
  else check(/micrófono y del casco/.test(body), tag + 'cartel indica audio de micrófono y casco');
  await page.keyboard.press('Escape');
  check(await page.locator('#saveOverlay').isVisible(), tag + 'Escape no descarta el cartel de guardado');
  await page.locator('#saveOverlay button', { hasText: 'Descartar' }).first().click();
  check(/¿Descartar sin guardar\?/.test(await page.locator('#saveOverlay').innerText()), tag + 'descartar pide confirmacion');
  await page.locator('#saveOverlay button', { hasText: 'Volver' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }).catch(() => null), page.locator('#saveOverlay button', { hasText: 'Guardar en mi PC' }).click()]);
  check(!!dl && /^vigia-4132_.*\.(webm|mp4)$/.test(dl.suggestedFilename()), tag + 'Guardar en mi PC descarga el archivo: ' + (dl && dl.suggestedFilename()));
  await shot(page, `${TAG}-cartel-guardado-${deny ? 'sinmic' : 'conmic'}`);
  await page.locator('#saveOverlay button', { hasText: 'Cerrar' }).click();
  check(!(await page.locator('#saveOverlay').isVisible()), tag + 'cartel se cierra tras guardar');
  await ctx.close();
}

// 5) mapa: icono de casco, 0,0 ignorado, recorrido apagado, ultima posicion conocida, comandos.html
if (!process.env.ONLY4) {
  const [ctx, page] = await newPage({});
  await closeOv(page);
  await page.click('#tabMap');
  await page.waitForSelector('#mapBox .leaflet-container', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const m = await page.evaluate(() => ({
    hm: [...document.querySelectorAll('#mapBox .hm .hm-id')].map(e => e.textContent),
    zero: [...document.querySelectorAll('#mapDevList li')].some(l => /0\.00000, 0\.00000/.test(l.textContent)),
    paths: document.querySelectorAll('#mapBox .leaflet-overlay-pane path.leaflet-interactive').length,
    rec: (() => { const c = [...document.querySelectorAll('#mapLayers input')].find(i => /Recorrido/.test(i.parentElement.textContent)); return c ? c.checked : null; })(),
    list: [...document.querySelectorAll('#mapDevList li')].map(l => l.innerText.replace(/\s+/g, ' ').slice(0, 160)),
  }));
  check(m.hm.includes('4132') && m.hm.includes('4133'), 'marcadores con icono de casco e id: ' + m.hm.join(','));
  check(!m.zero, 'una posicion 0,0 se ignora');
  const where = await page.evaluate(() => ({
    centroSinFeed: !document.getElementById('panelMain').contains(document.getElementById('feed')) && !document.getElementById('panelMain').contains(document.getElementById('bcList')),
    historialConFeed: document.getElementById('panelDone').contains(document.getElementById('feed')) && document.getElementById('panelDone').contains(document.getElementById('bcList')),
  }));
  check(where.centroSinFeed && where.historialConFeed, 'Eventos recientes y Historial de ordenes viven en la pestana Historial, no en Centro');
  check(m.rec === false, 'capa Recorrido desmarcada por defecto');
  log('lista mapa:', JSON.stringify(m.list));
  const cen = await page.evaluate(() => document.getElementById('devList').innerText.replace(/\s+/g, ' '));
  check(/Ubicación/.test(cen) && /Ver en el mapa/.test(await page.evaluate(() => document.getElementById('devList').innerHTML.length ? [...document.querySelectorAll('#devList button')].map(b => b.textContent).join('|') : '')), 'tarjeta del casco muestra Ubicación y Ver en el mapa');
  await page.click('#gLocate');
  await ctx.close();
  // comandos.html
  const c2 = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'es-AR', serviceWorkers: 'block' });
  const pg = await c2.newPage();
  const cerr = [];
  pg.on('pageerror', e => cerr.push(e.message));
  pg.on('console', mm => { if (mm.type() === 'error' && !/fonts\.g|ERR_|favicon/.test(mm.text() + (mm.location().url || ''))) cerr.push(mm.text()); });
  await pg.goto(BASE + 'comandos.html');
  await pg.waitForSelector('#q');
  const before = await pg.evaluate(() => [...document.querySelectorAll('.cmd-table tbody tr')].filter(r => r.offsetParent).length);
  await pg.fill('#q', 'linterna'); await pg.waitForTimeout(300);
  const after = await pg.evaluate(() => [...document.querySelectorAll('.cmd-table tbody tr')].filter(r => r.offsetParent).length);
  check(before > 0 && after < before, 'comandos.html: el filtro oculta filas (' + before + ' -> ' + after + ')');
  check(cerr.length === 0, 'comandos.html carga sin errores de consola ' + cerr.join(' | ').slice(0, 150));
  await c2.close();
  // enlace en index
  const [c3, p3] = await newPage({});
  const href = await p3.locator('#cmdLink').getAttribute('href');
  check(href === 'comandos.html', 'index tiene el enlace Comandos de voz');
  await c3.close();
}

// ---- 6) Tanda 4: comandos, configuracion, alertas nuevas, reportes, mensajes, roles, degradacion ----
const posts = (S, t) => (S.posts || []).filter(x => x.t === t);
const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 150)); } return false; };
if (!process.env.ONLY4) {
  const state = {};
  const [ctx, page] = await newPage({ t4: true, state });
  check(await page.locator('#sosOverlay').isVisible(), 't4: cartel SOS visible con alertas pendientes (incluye sin usar / sin movimiento)');
  await closeOv(page);
  const pend = await page.locator('#pendList').innerText();
  check(/CASCO SIN USAR/.test(pend) && /SIN MOVIMIENTO/.test(pend), 't4: not_worn e inactive son tarjetas Atender con etiquetas es-AR');
  await page.locator('#pendList .pitem', { hasText: 'CASCO SIN USAR' }).first().locator('button.attend').click();
  check(await waitFor(() => posts(state, 'event_acks').length > 0), 't4: Atender un not_worn inserta event_acks');
  // equip / fall_cancel: informativos en Historial, un solo aviso de equipo
  await page.click('#tabDone');
  const feed = await page.locator('#feed').innerText();
  check(/EQUIPO/.test(feed) && /CAÍDA CANCELADA/.test(feed), 't4: equip y fall_cancel aparecen en Historial');
  const hal = await page.locator('#healthAlerts .halert', { hasText: 'batería baja' }).count();
  check(hal === 1, 't4: un solo aviso de bateria baja del casco 4132 (evento real sin duplicar la derivada): ' + hal);
  // comandos en En vivo
  await page.click('#tabLive');
  const sec = page.locator('#lives .live', { hasText: '4132' });
  const stat = sec.locator('.cmdstat');
  await sec.getByRole('button', { name: 'Sacar foto, casco 4132' }).click();
  check(await waitFor(() => posts(state, 'device_commands').some(x => x.body && x.body.device_id === '4132' && x.body.action === 'photo')), 't4: Sacar foto inserta device_commands(photo)');
  check(/pendiente/.test(await stat.innerText()), 't4: estado pendiente tras el pedido');
  state.acks = [{ command_id: 'cmd-1', device_id: '4132', ok: true, detail: '', created_at: new Date().toISOString() }];
  check(await waitFor(async () => /Foto: listo/.test(await stat.innerText()), 9000), 't4: el ack ok se lee por poll (Foto: listo)');
  const th = sec.locator('.thumb img');
  check((await th.count()) >= 1 && /Foto del casco 4132/.test((await th.first().getAttribute('alt')) || ''), 't4: miniatura con alt');
  await sec.locator('.thumb').first().click();
  check(await page.locator('dialog[open] img.photo-big').count() === 1, 't4: foto ampliada en dialogo');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }).catch(() => null), page.locator('dialog[open] button', { hasText: 'Descargar' }).click()]);
  check(!!dl && /^vigia-4132_.*\.jpg$/.test(dl.suggestedFilename()), 't4: descarga de la foto: ' + (dl && dl.suggestedFilename()));
  await shot(page, `${TAG}-t4-foto`);
  await page.keyboard.press('Escape');
  check(await page.locator('dialog[open]').count() === 0, 't4: Escape cierra el dialogo');
  await sec.getByRole('button', { name: /Linterna: encender, casco 4132/ }).click();
  await waitFor(() => posts(state, 'device_commands').length >= 2);
  state.acks.push({ command_id: 'cmd-2', device_id: '4132', ok: true, detail: '', created_at: new Date().toISOString() });
  check(await waitFor(async () => /Linterna: apagar/.test(await sec.locator('[data-fk="4132|torch"]').innerText()), 9000), 't4: la linterna pasa a "Linterna: apagar" tras el ack');
  await sec.getByRole('button', { name: /Probar enlace, casco 4132/ }).click();
  await waitFor(() => posts(state, 'device_commands').length >= 3);
  state.acks.push({ command_id: 'cmd-3', device_id: '4132', ok: false, detail: 'camara ocupada', created_at: new Date().toISOString() });
  check(await waitFor(async () => /camara ocupada/.test(await stat.innerText()), 9000), 't4: error del ack muestra el detail');
  // configuracion (admin)
  await sec.getByRole('button', { name: /Configuración del casco 4132/ }).click();
  await page.waitForSelector('dialog[open] #cfg_inactivity_s');
  await waitFor(async () => !(await page.locator('dialog[open] button[type=submit]').isDisabled()));
  await page.fill('#cfg_inactivity_s', '10');
  await page.locator('dialog[open] button[type=submit]').click();
  check(/inmovilidad/i.test(await page.locator('dialog[open] .err').innerText()), 't4: validacion de rango (inactivity_s 10 es invalido)');
  await page.fill('#cfg_inactivity_s', '300'); await page.fill('#cfg_location_s', '30'); await page.fill('#cfg_location_s_alert', '40'); await page.fill('#cfg_fall_g_threshold', '3,5');
  await page.locator('dialog[open] button[type=submit]').click();
  check(/más lenta/.test(await page.locator('dialog[open] .err').innerText()), 't4: location_s_alert no puede superar location_s');
  await page.fill('#cfg_location_s_alert', '10'); await page.selectOption('#cfg_torch_allowed', 'true');
  await page.locator('dialog[open] button[type=submit]').click();
  await waitFor(() => posts(state, 'device_config').length > 0);
  const cfgBody = (posts(state, 'device_config')[0] || {}).body || {};
  check(cfgBody.device_id === '4132' && JSON.stringify(cfgBody.config) === JSON.stringify({ fall_g_threshold: 3.5, inactivity_s: 300, location_s: 30, location_s_alert: 10, torch_allowed: true }), 't4: upsert device_config con las claves validadas: ' + JSON.stringify(cfgBody));
  await page.keyboard.press('Escape');
  await sec.getByRole('button', { name: /Reiniciar agente, casco 4132/ }).click();
  await page.locator('dialog[open] button', { hasText: 'Sí, reiniciar' }).click();
  check(await waitFor(() => posts(state, 'device_commands').some(x => x.body && x.body.action === 'restart_agent')), 't4: Reiniciar agente pide confirmacion y envia restart_agent');
  // reportes
  await page.click('#tabRep');
  check(await waitFor(async () => (await page.locator('#repHost tbody tr').count()) === 50), 't4: Reportes muestra 50 filas');
  check(/Página 1/.test(await page.locator('#repHost .pager').innerText()), 't4: pagina 1');
  const first1 = await page.locator('#repHost tbody tr').first().innerText();
  await page.locator('#repHost .pager button', { hasText: 'Siguiente' }).click();
  check(await waitFor(async () => /Página 2/.test(await page.locator('#repHost .pager').innerText())), 't4: paginacion keyset pagina 2');
  const first2 = await page.locator('#repHost tbody tr').first().innerText();
  check(first1 !== first2 && (await page.locator('#repHost tbody tr').count()) === 50, 't4: la pagina 2 trae otras 50 filas');
  await shot(page, `${TAG}-t4-reportes`);
  await page.selectOption('#repHost select >> nth=1', 'sos');
  await page.selectOption('#repHost select >> nth=2', 'pend');
  await page.locator('#repHost button[type=submit]').click();
  await waitFor(async () => /Página 1/.test(await page.locator('#repHost .pager').innerText()) && (await page.locator('#repHost tbody tr').count()) !== 50);   // espera la respuesta filtrada (no la pagina vieja)
  const cells = await page.evaluate(() => [...document.querySelectorAll('#repHost tbody tr')].map(r => [r.children[3].textContent, r.children[6].textContent]));
  if (process.env.DBG) console.log('CELLS', JSON.stringify(cells.slice(0, 6)));
  check(cells.length > 0 && cells.every(c => c[0] === 'SOS' && c[1] === 'Pendiente'), 't4: filtros tipo=SOS y estado=pendientes (' + cells.length + ' filas)');
  await page.selectOption('#repHost select >> nth=2', '');
  await page.selectOption('#repHost select >> nth=1', '');
  await page.locator('#repHost button[type=submit]').click();
  await waitFor(async () => (await page.locator('#repHost tbody tr').count()) === 50);
  const [csv] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }).catch(() => null), page.locator('#repHost button', { hasText: 'Exportar CSV' }).click()]);
  let txt = '';
  if (csv) txt = fs.readFileSync(await csv.path(), 'utf8');
  const lines = txt.split('\r\n').filter(Boolean);
  check(txt.charCodeAt(0) === 0xFEFF && lines.length === 121 && lines[0].includes('"fecha";"casco"'), 't4: CSV con BOM, ; y 120 filas + encabezado (' + lines.length + ')');
  check(/^"\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}";/.test((lines[1] || '').replace('\uFEFF', '')), 't4: fecha dd/mm/aaaa HH:mm en el CSV: ' + (lines[1] || '').slice(0, 40));
  check(/"-34,\d+"/.test(lines[1] || ''), 't4: latitud con coma decimal y signo conservado');
  await page.evaluate(() => { window.__p = 0; window.print = () => { window.__p++; }; });
  await page.locator('#repHost button', { hasText: 'Imprimir' }).click();
  check((await page.evaluate(() => window.__p)) === 1 && /Reporte de incidentes/.test(await page.locator('#repHost .print-only').textContent()), 't4: Imprimir / PDF llama a print con encabezado');
  // historial con filtros (events + acks)
  await page.click('#tabDone');
  await page.locator('#histSearch > summary').click();
  check(await waitFor(async () => (await page.locator('#histQuery tbody tr').count()) > 0), 't4: Historial: busqueda con filtros y paginas');
  // mensajes
  await page.click('#tabMain'); await closeOv(page);
  await page.click('#btnMsg');
  await page.fill('#msgText', 'hola');
  await page.click('#msgGo');
  check(/al menos 5/.test(await page.locator('#msgErr').innerText()), 't4: mensaje de menos de 5 caracteres se rechaza');
  await page.fill('#msgText', 'Cambio de turno a las 18');
  await page.click('#msgGo');
  await page.waitForSelector('dialog[open]');
  check(/todos los cascos/.test(await page.locator('dialog[open]').innerText()), 't4: confirmacion al enviar a Todos');
  await page.locator('dialog[open] button', { hasText: 'Cancelar' }).click();
  check(posts(state, 'broadcasts').length === 0, 't4: cancelar la confirmacion no envia');
  await page.click('#msgGo');
  await page.locator('dialog[open] button', { hasText: 'Sí, enviar a todos' }).click();
  check(await waitFor(() => posts(state, 'broadcasts').length === 1 && posts(state, 'broadcasts')[0].body.device_ids === null), 't4: envio a Todos tras confirmar');
  await page.click('#tabDone');
  const rs = page.locator('#bcList button', { hasText: 'Reenviar a los que no confirmaron' });
  check(await waitFor(async () => (await rs.count()) >= 1), 't4: boton Reenviar a los que no confirmaron');
  const rsTxt = await rs.first().innerText();
  await rs.last().click();
  await page.locator('dialog[open] button', { hasText: 'Sí, reenviar' }).click();
  await waitFor(() => posts(state, 'broadcasts').length === 2);
  const rb = (posts(state, 'broadcasts')[1] || {}).body || {};
  check(JSON.stringify(rb.device_ids) === '["4133"]' && rb.message === 'Revisar EPP', 't4: reenvio solo a los que no confirmaron: ' + JSON.stringify(rb.device_ids) + ' ' + rsTxt);
  // registrar casco detectado
  await page.click('#tabEq');
  await page.waitForSelector('.unreg');
  check(/4160/.test(await page.locator('.unreg').innerText()), 't4: casco detectado sin registrar');
  await page.locator('.unreg button', { hasText: 'Registrar' }).click();
  check((await page.locator('#eqForm input').first().inputValue()) === '4160', 't4: Registrar abre el alta con el alias precargado');
  await shot(page, `${TAG}-t4-registrar`);
  await ctx.close();
}

// viewer: sin altas, sin evacuacion, sin zonas, sin configuracion; comandos permitidos
if (!process.env.ONLY4) {
  const state = {};
  const [ctx, page] = await newPage({ t4: true, role: 'viewer', state });
  await closeOv(page);
  check(/supervisor/.test(await page.locator('#who').innerText()), 't4 viewer: el rol se muestra');
  check(await page.locator('#btnEvac').isDisabled() && await page.locator('#evacRoleNote').isVisible(), 't4 viewer: Evacuacion deshabilitada con explicacion');
  check(await page.locator('#btnMsg').isEnabled(), 't4 viewer: Mensaje a cascos permitido');
  await page.click('#tabMap');
  check(await page.locator('#gDrawCircle').isDisabled() && await page.locator('#mapRoleNote').isVisible(), 't4 viewer: dibujo de zonas deshabilitado con explicacion');
  await page.click('#tabEq');
  await page.waitForSelector('#eqBody .card');
  check((await page.locator('#eqBody button', { hasText: /Alta de|Editar|Dar de baja/ }).count()) === 0 && await page.locator('#eqBody .rolenote').first().isVisible(), 't4 viewer: Equipos sin altas/ediciones/bajas y con explicacion');
  await page.click('#eqTabAssign');
  check((await page.locator('#eqBody button', { hasText: /Asignar|Cerrar asignación/ }).count()) === 0, 't4 viewer: sin asignaciones');
  await page.click('#tabLive');
  const sec = page.locator('#lives .live', { hasText: '4132' });
  check((await sec.getByRole('button', { name: /Configuración del casco|Reiniciar agente/ }).count()) === 0, 't4 viewer: sin Configuracion ni Reiniciar agente');
  await sec.getByRole('button', { name: /Probar enlace/ }).click();
  check(await waitFor(() => posts(state, 'device_commands').some(x => x.body.action === 'ping')), 't4 viewer: Probar enlace permitido');
  await ctx.close();
}

// degradacion: el servidor todavia no tiene las tablas nuevas
if (!process.env.ONLY4) {
  const state = {};
  const [ctx, page] = await newPage({ t4: true, noNew: true, state });
  const cerr = [];
  page.on('console', m => { if (m.type() === 'error') cerr.push(m.text() + ' @ ' + (m.location().url || '')); });
  await closeOv(page);
  await page.click('#tabLive');
  const sec = page.locator('#lives .live', { hasText: '4132' });
  await sec.getByRole('button', { name: /Sacar foto/ }).click();
  check(await waitFor(async () => /cuando se aplique la actualización/.test(await sec.locator('.cmdstat').innerText())), 't4 sin tablas: Sacar foto avisa "disponible cuando se aplique la actualización"');
  await page.click('#tabRep');
  check(await waitFor(async () => (await page.locator('#repHost tbody td.mono').count()) > 0), 't4 sin tablas: Reportes cae a events + event_acks');
  check(await waitFor(async () => /todavía no está disponible/.test(await page.locator('#repHost').innerText())), 't4 sin tablas: Reportes avisa que la vista no existe');
  await page.click('#tabLive');
  await sec.getByRole('button', { name: /Configuración del casco 4132/ }).click();
  check(await waitFor(async () => /cuando se aplique la actualización/.test(await page.locator('dialog[open]').innerText())), 't4 sin tablas: Configuracion avisa lo mismo y no rompe');
  await page.keyboard.press('Escape');
  const bad = cerr.filter(x => !/Failed to load resource.*404|tile\.openstreetmap|fonts\.g|ERR_|favicon|sslip\.io\/live/.test(x));
  check(bad.length === 0, 't4 sin tablas: sin errores de consola salvo los 404 de recurso (' + cerr.length + ' 404, otros: ' + bad.join(' | ').slice(0, 150) + ')');
  check((state.hits || []).length <= 8, 't4 sin tablas: pocos pedidos a tablas inexistentes (' + (state.hits || []).length + ')');
  await ctx.close();
}

// ---- 7) Archivar (event_archive): admin archiva/desarchiva, viewer solo mira, tabla ausente degrada, CSV excluye ----
if (!process.env.ONLY4) {
  const state = {};
  const [ctx, page] = await newPage({ t4: true, state });
  await closeOv(page);
  await page.click('#tabRep');
  check(await waitFor(async () => (await page.locator('#repHost tbody tr').count()) === 50), 'arc: reportes cargan 50 filas');
  check(await waitFor(async () => (await page.locator('#repHost .arc-toggle-l').isVisible())), 'arc: toggle "Mostrar archivados" visible con la tabla presente');
  const pendBtn = page.locator('#repHost tbody tr.pend button[aria-label^="Archivar la fila"]').first();
  check((await pendBtn.getAttribute('aria-disabled')) === 'true' && /Atendé la alerta primero/.test((await pendBtn.getAttribute('title')) || ''), 'arc: Archivar deshabilitado en pendientes con tooltip');
  const okRow = page.locator('#repHost tbody tr:not(.pend)').first();
  const when0 = await okRow.locator('td').nth(1).innerText();
  await okRow.locator('button[aria-label^="Archivar la fila"]').click();
  await page.locator('dialog[open] input[type=text]').fill('limpieza de turno');
  await page.locator('dialog[open] button', { hasText: 'Sí, archivar' }).click();
  check(await waitFor(() => (state.arch || []).length === 1 && state.arch[0].reason === 'limpieza de turno'), 'arc: archivar una fila inserta en event_archive con motivo');
  check(await waitFor(async () => !(await page.locator('#repHost tbody').innerText()).includes(when0)), 'arc: la fila archivada desaparece del listado');
  const boxes = page.locator('#repHost tbody tr:not(.pend) input[type=checkbox]:not(:disabled)');
  for (let i = 0; i < 3; i++) await boxes.nth(i).check();
  check(/\(3\)/.test(await page.locator('#repHost button', { hasText: 'Archivar seleccionados' }).innerText()), 'arc: contador de seleccionados');
  await page.locator('#repHost button', { hasText: 'Archivar seleccionados' }).click();
  await page.locator('dialog[open] button', { hasText: 'Sí, archivar' }).click();
  check(await waitFor(() => (state.arch || []).length === 4), 'arc: un solo lote archiva 3 mas (total 4)');
  const batchPosts = posts(state, 'event_archive').filter(x => Array.isArray(x.body) && x.body.length === 3);
  check(batchPosts.length === 1, 'arc: el lote fue un unico INSERT de 3 filas');
  await waitFor(async () => (await page.locator('#repHost tbody tr').count()) === 50);
  let [csv] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }).catch(() => null), page.locator('#repHost button', { hasText: 'Exportar CSV' }).click()]);
  let lines = csv ? fs.readFileSync(await csv.path(), 'utf8').split('\r\n').filter(Boolean) : [];
  check(lines.length === 121 - 4, 'arc: el CSV excluye los archivados (' + lines.length + ')');
  await page.locator('#repHost .arc-toggle').check();
  check(await waitFor(async () => (await page.locator('#repHost tbody tr.archived').count()) >= 1), 'arc: con el toggle aparecen atenuados');
  check(/Archivado por supervisor@demo.test el \d{2}\/\d{2}\/\d{4}/.test(await page.locator('#repHost tbody tr.archived').first().innerText()), 'arc: "Archivado por <email> el <fecha>"');
  await shot(page, `${TAG}-arc-reportes`);
  [csv] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }).catch(() => null), page.locator('#repHost button', { hasText: 'Exportar CSV' }).click()]);
  lines = csv ? fs.readFileSync(await csv.path(), 'utf8').split('\r\n').filter(Boolean) : [];
  check(lines.length === 121, 'arc: con el toggle el CSV incluye archivados (' + lines.length + ')');
  await page.locator('#repHost tbody tr.archived').first().locator('button', { hasText: 'Desarchivar' }).click();
  check(await waitFor(() => (state.arch || []).length === 3), 'arc: Desarchivar borra de event_archive');
  await page.locator('#repHost .arc-toggle').uncheck();
  await page.click('#tabDone');
  const eq = page.locator('#feed li', { hasText: 'EQUIPO' }).first();
  await eq.locator('button', { hasText: 'Archivar' }).click();
  await page.locator('dialog[open] button', { hasText: 'Sí, archivar' }).click();
  check(await waitFor(() => (state.arch || []).some(x => x.event_id === 'e-eq')), 'arc: archivar una tarjeta informativa del Historial');
  check(await waitFor(async () => (await page.locator('#feed li.arc-hidden').count()) === 1), 'arc: la tarjeta archivada se oculta por defecto');
  const ackedDone = await page.locator('#feedDone > li:not(.empty):not(.arc-hidden)').count();
  check(String(ackedDone) === (await page.locator('#doneCount').innerText()), 'arc: la insignia de Historial cuenta solo no archivados (' + ackedDone + ')');
  await ctx.close();
}
if (!process.env.ONLY4) {
  const state = { arch: [{ event_id: 'e-done', archived_by_email: 'adm@demo.test', archived_at: iso(60000), reason: null }, { event_id: 'r000', archived_by_email: 'adm@demo.test', archived_at: iso(60000), reason: null }] };
  const [ctx, page] = await newPage({ t4: true, role: 'viewer', state });
  await closeOv(page);
  await page.click('#tabDone');
  check(await waitFor(async () => (await page.locator('#feedDone li.arc-hidden').count()) === 1), 'arc viewer: el atendido archivado no se ve por defecto');
  check((await page.locator('#doneCount').innerText()) === '0', 'arc viewer: la insignia no cuenta archivados');
  await page.locator('#panelDone > .row .arc-toggle').check();
  check(await waitFor(async () => /Archivado por adm@demo.test/.test(await page.locator('#feedDone').innerText())), 'arc viewer: con el toggle se ve "Archivado por"');
  check((await page.locator('#panelDone button:visible', { hasText: /Archivar|Desarchivar/ }).count()) === 0, 'arc viewer: sin botones de archivar');
  await page.click('#tabRep');
  await waitFor(async () => (await page.locator('#repHost tbody tr').count()) === 50);
  check((await page.locator('#repHost button:visible', { hasText: /Archivar|Desarchivar/ }).count()) === 0 && (await page.locator('#repHost tbody input[type=checkbox]').count()) === 0, 'arc viewer: reportes sin botones ni casillas');
  await ctx.close();
}
if (!process.env.ONLY4) {
  const state = {};
  const [ctx, page] = await newPage({ t4: true, noNew: true, state });
  await closeOv(page);
  await page.click('#tabRep');
  check(await waitFor(async () => (await page.locator('#repHost tbody td.mono').count()) > 0), 'arc sin tabla: reportes cargan igual');
  check(!(await page.locator('#repHost .arc-toggle-l').isVisible()) && (await page.locator('#repHost button:visible', { hasText: /Archivar/ }).count()) === 0, 'arc sin tabla: sin toggle ni botones de archivar');
  await ctx.close();
}

// ---- 8) Pestaña Comandos dentro del panel ----
if (!process.env.ONLY4) {
  const [ctx, page] = await newPage({});
  const perr = [];
  page.on('pageerror', e => perr.push(e.message));
  await closeOv(page);
  await page.click('#cmdLink');
  check(await page.locator('#panelCmd').isVisible() && (await page.evaluate(() => location.pathname.endsWith('index.html') || location.pathname === '/')), 'cmd: el enlace del encabezado abre la pestaña Comandos sin salir de la pagina');
  await page.waitForSelector('#cmdp-q');
  const vis = () => page.evaluate(() => [...document.querySelectorAll('#cmdHost .cmd-table tbody tr')].filter(r => r.offsetParent).length);
  const n0 = await vis();
  await page.fill('#cmdp-q', 'linterna');
  await page.waitForTimeout(250);
  const n1 = await vis();
  check(n0 > 0 && n1 > 0 && n1 < n0, 'cmd: el buscador de la pestaña filtra (' + n0 + ' -> ' + n1 + ')');
  check(await page.locator('#cmdHost #cmdp-t-panel').count() === 1 && await page.locator('main#main').count() === 1, 'cmd: ids con prefijo y un solo <main>');
  await page.evaluate(() => { window.__p = 0; window.print = () => { window.__p++; }; });
  await page.click('#cmdp-print');
  check((await page.evaluate(() => window.__p)) === 1, 'cmd: Imprimir dentro del panel');
  await page.focus('#tabCmd'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowRight');
  check((await page.evaluate(() => document.activeElement.id)) === 'tabCmd', 'cmd: teclado llega a la pestaña Comandos');
  check(perr.length === 0, 'cmd: sin errores de pagina');
  await ctx.close();
}

// ---- 9) Eliminar imagenes (admin) ----
if (!process.env.ONLY4) {
  const state = {};
  const [ctx, page] = await newPage({ t4: true, state });
  await closeOv(page);
  await page.click('#tabLive');
  const sec = page.locator('#lives .live', { hasText: '4132' });
  check((await sec.locator('.thumbwrap').count()) === 3 && (await sec.locator('button[aria-label="Eliminar imagen"]').count()) === 3, 'img: admin ve papelera y casilla en cada miniatura');
  // permiso: el servidor no deja borrar (RLS silenciosa) -> mensaje claro y la miniatura sigue
  state.delMode = 'rls';
  await sec.locator('button[aria-label="Eliminar imagen"]').first().click();
  check(/definitivamente del servidor/.test(await page.locator('dialog[open]').innerText()), 'img: confirmacion fuerte');
  await page.locator('dialog[open] button', { hasText: 'Sí, eliminar la imagen' }).click();
  check(await waitFor(async () => /actualización de permisos/.test(await page.locator('dialog[open]').innerText())), 'img: sin politicas explica "Falta aplicar la actualización de permisos"');
  await page.keyboard.press('Escape');
  check((await sec.locator('.thumbwrap').count()) === 3, 'img: tras el error de permiso la miniatura sigue');
  state.delMode = 'err';
  await sec.locator('button[aria-label="Eliminar imagen"]').first().click();
  await page.locator('dialog[open] button', { hasText: 'Sí, eliminar la imagen' }).click();
  check(await waitFor(async () => /actualización de permisos/.test(await page.locator('dialog[open]').innerText())), 'img: error 403 del storage tambien se explica');
  await page.keyboard.press('Escape');
  // borrado simple con motivo
  state.delMode = '';
  await sec.locator('.thumb').first().click();
  await page.locator('dialog[open] button', { hasText: 'Eliminar imagen' }).click();
  await page.locator('dialog[open] input[type=text]').fill('foto borrosa');
  await page.locator('dialog[open] button', { hasText: 'Sí, eliminar la imagen' }).click();
  check(await waitFor(() => (state.deleted || []).length === 1), 'img: storage.remove con la ruta de la imagen: ' + JSON.stringify(state.deleted));
  check(await waitFor(() => (state.arch || []).some(a => /^Imagen eliminada: foto borrosa/.test(a.reason || ''))), 'img: event_archive con motivo "Imagen eliminada: ..."');
  await page.locator('dialog[open] button', { hasText: 'Cerrar' }).last().click().catch(() => {});
  check(await waitFor(async () => (await sec.locator('.thumbwrap').count()) === 2), 'img: la miniatura desaparece en el acto');
  // multiple
  const cbs = sec.locator('.thumb-act input[type=checkbox]');
  await cbs.nth(0).check(); await cbs.nth(1).check();
  await sec.locator('button', { hasText: 'Eliminar seleccionadas (2)' }).click();
  await page.locator('dialog[open] button', { hasText: 'Sí, eliminar 2 imágenes' }).click();
  check(await waitFor(async () => /2 imágenes eliminadas/.test(await page.locator('dialog[open]').innerText())), 'img: borrado multiple con resumen');
  check((state.deleted || []).length === 3, 'img: tres archivos borrados en total');
  await page.keyboard.press('Escape');
  await page.click('#tabDone');
  check(await waitFor(async () => /Imagen eliminada por supervisor@demo.test/.test(await page.locator('#feed').innerText())), 'img: la tarjeta del Historial dice "Imagen eliminada por <email> el <fecha>"');
  check((await page.locator('#feed img.media').count()) === 0, 'img: la tarjeta ya no muestra imagen');
  await ctx.close();
}
if (!process.env.ONLY4) {
  const state = { arch: [{ event_id: 'e-ph3', archived_by_email: 'adm@demo.test', archived_at: iso(60000), reason: 'Imagen eliminada: duplicada' }] };
  const [ctx, page] = await newPage({ t4: true, role: 'viewer', state });
  await closeOv(page);
  await page.click('#tabLive');
  const sec = page.locator('#lives .live', { hasText: '4132' });
  check(await waitFor(async () => (await sec.locator('.thumb').count()) === 2), 'img viewer: la imagen eliminada por otro admin no se muestra');
  check((await page.locator('button[aria-label="Eliminar imagen"]:visible').count()) === 0 && (await sec.locator('.thumb-act').count()) === 0, 'img viewer: sin papelera ni seleccion');
  await page.click('#tabDone');
  check(/Imagen eliminada por adm@demo.test/.test(await page.locator('#feed').innerText()), 'img viewer: ve la nota "Imagen eliminada por"');
  await ctx.close();
}

// ---- 10) Ver en vivo ante una alerta: el casco tarda en publicar (WHEP 404 un rato) ----
if (!process.env.ONLY4) {
  const state = {};
  const [ctx, page] = await newPage({ whep: true, whepFailMs: 5000, state });
  check(await page.locator('#sosOverlay').isVisible(), 'live: cartel SOS visible');
  await page.locator('.sos-ov-btns button', { hasText: 'Ver en vivo' }).click();
  check(!(await page.locator('#sosOverlay').isVisible()), 'live: el cartel se cierra');
  check(await page.locator('#panelMain').getAttribute('data-view') === 'live' && await page.locator('#lives .live').first().isVisible(), 'live: el panel de video queda visible con alertas pendientes');
  check(await waitFor(() => posts(state, 'stream_commands').some(x => x.body && x.body.action === 'start')), 'live: se envia stream_commands start');
  const sec = page.locator('#lives .live', { hasText: '4132' });
  check(await waitFor(async () => /Esperando al casco… \d+ s/.test(await sec.locator('.state').first().innerText()), 4000), 'live: estado con segundos transcurridos');
  check(await waitFor(async () => /En vivo/.test(await sec.locator('.state').first().innerText()), 20000), 'live: reintenta ante 404 hasta que WHEP responde y conecta (' + state.whepHits + ' intentos)');
  check((state.whepHits || 0) >= 2, 'live: hubo reintentos (' + state.whepHits + ')');
  // (el cartel abre la alerta mas grave y vieja: el SOS del 4132) desde la tarjeta de otro casco: tambien reinicia el ciclo y muestra el panel
  await page.click('#tabMain');
  const n0 = posts(state, 'stream_commands').length;
  await page.locator('#pendList .pitem', { hasText: '4133' }).first().locator('button', { hasText: 'Ver en vivo' }).click();
  check(await waitFor(() => posts(state, 'stream_commands').length > n0), 'live: "Ver en vivo" de la tarjeta envia start');
  check(await page.locator('#lives .live', { hasText: '4133' }).isVisible(), 'live: panel del casco 4133 visible');
  await ctx.close();
}

// ---- 11) Foto desde el video en vivo y microfono ----
if (!process.env.ONLY4) {
  const state = {};
  const [ctx, page] = await newPage({ whep: true, state });
  await closeOv(page);
  await page.click('#tabLive');
  const sec = page.locator('#lives .live', { hasText: '4132' });
  await sec.locator('button', { hasText: 'Iniciar' }).first().click();
  check(await waitFor(async () => /En vivo/.test(await sec.locator('.state').first().innerText()), 15000), 'foto: video en vivo del 4132');
  await waitFor(() => page.evaluate(() => { const v = document.querySelector('#lives video'); return !!(v && v.videoWidth); }), 8000);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }).catch(() => null), sec.getByRole('button', { name: /Sacar foto, casco 4132/ }).click()]);
  check(!!dl && /^vigia-4132_.*\.png$/.test(dl.suggestedFilename()), 'foto: con video en vivo toma el cuadro y lo descarga: ' + (dl && dl.suggestedFilename()));
  check(posts(state, 'device_commands').length === 0, 'foto: no se envia comando al casco mientras transmite');
  check(/Cuadro del video guardado/.test(await page.locator('dialog[open]').innerText()), 'foto: cartel de confirmacion');
  await page.keyboard.press('Escape');
  check((await sec.locator('.thumb', { hasText: 'Cuadro del video · guardado en tu PC' }).count()) === 1, 'foto: miniatura con la etiqueta del cuadro');
  await ctx.close();
}
if (!process.env.ONLY4) {
  const state = {};
  const [ctx, page] = await newPage({ whep: true, t4: true, state });
  await closeOv(page);
  await page.click('#tabLive');
  const sec = page.locator('#lives .live', { hasText: '4132' });
  await sec.getByRole('button', { name: /Sacar foto, casco 4132/ }).click();
  await waitFor(() => posts(state, 'device_commands').length === 1);
  state.acks = [{ command_id: 'cmd-1', device_id: '4132', ok: false, detail: 'camara ocupada', created_at: new Date().toISOString() }];
  const bf = sec.getByRole('button', { name: /Tomar cuadro del video, casco 4132/ });
  check(await waitFor(async () => await bf.isVisible(), 9000), 'foto: ante "camara ocupada" ofrece "Tomar cuadro del video"');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }).catch(() => null), bf.click()]);
  check(!!dl && /^vigia-4132_.*\.png$/.test(dl.suggestedFilename()), 'foto: arranca el video y toma el cuadro: ' + (dl && dl.suggestedFilename()));
  await ctx.close();
}
const MICQ = s => "navigator.permissions.query = async () => ({ state: '" + s + "' });";
const MICERR = n => MICQ('prompt') + "navigator.mediaDevices.getUserMedia = async () => { throw Object.assign(new Error('x'), { name: '" + n + "' }); };";
if (!process.env.ONLY4) {
  let [ctx, page] = await newPage({}, false, MICQ('denied'));
  await closeOv(page);
  await page.click('#testMic');
  const t = await page.locator('dialog[open]').innerText();
  check(/candado/.test(t) && /Configuración del sitio/.test(t) && /F5/.test(t) && /chrome:\/\/settings\/content\/microphone/.test(t) && /Windows/.test(t), 'mic: permiso denegado muestra el panel con los pasos, la ruta y la nota de Windows');
  await page.locator('dialog[open] button', { hasText: 'Copiar' }).click();
  check(await waitFor(async () => /copiad|Seleccionada/i.test(await page.locator('dialog[open] button', { hasText: /Copiado|Seleccionada/ }).innerText().catch(() => ''))), 'mic: boton Copiar responde');
  await ctx.close();
  [ctx, page] = await newPage({}, false, MICERR('NotFoundError'));
  await closeOv(page);
  await page.click('#testMic');
  check(await waitFor(async () => /no se encontró un micrófono/.test(await page.locator('dialog[open]').innerText())), 'mic: sin dispositivo dice "no se encontró un micrófono"');
  await ctx.close();
  [ctx, page] = await newPage({}, false, MICERR('NotReadableError'));
  await closeOv(page);
  await page.click('#testMic');
  check(await waitFor(async () => /otra aplicación/.test(await page.locator('dialog[open]').innerText())), 'mic: en uso dice "otra aplicación está usando el micrófono"');
  await ctx.close();
  [ctx, page] = await newPage({}, false, MICQ('prompt'));
  await closeOv(page);
  await page.click('#testMic');
  check(await waitFor(async () => await page.locator('dialog[open] meter:visible').count() === 1), 'mic: con permiso muestra el medidor de nivel');
  await page.keyboard.press('Escape');
  await ctx.close();
}

// logos: cargan (200) y estan en el header y el login
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'es-AR', serviceWorkers: 'block' });
  await mock(ctx, {});
  const page = await ctx.newPage();
  const codes = {};
  page.on('response', r => { if (/\/img\//.test(r.url())) codes[r.url().split('/').pop()] = r.status(); });
  await page.goto(BASE + 'index.html');
  await page.waitForTimeout(800);
  const imgs = await page.evaluate(() => [...document.querySelectorAll('img.brand-logo,img.login-logo')].map(i => i.complete && i.naturalWidth > 0));
  check(imgs.length === 2 && imgs.every(Boolean), 'logos de header y login cargan');
  for (const f of ['favicon-32.png', 'favicon-64.png', 'apple-touch-icon.png', 'og-vigia.png', 'vigia-logo.png', 'vigia-logo-128.png']) {
    const st = (await page.request.get(BASE + 'img/' + f)).status();
    check(st === 200, 'imagen ' + f + ' responde 200');
  }
  await ctx.close();
}

// ---- 12) Tanda B: severidad, Atender en un paso, encabezado compacto, paneles colapsados ----
if (!process.env.ONLY4) {
  // a) el cartel muestra la alerta mas grave (luego la mas vieja) con contador; Atender atiende en un paso
  {
    const state = {};
    const [ctx, page] = await newPage({ state });
    check(/SOS/.test(await page.locator('#sosOvT').innerText()) && /4132/.test(await page.locator('#sosOvWho').innerText()), 'sev: el cartel abre con el SOS mas viejo (4132), no con el mas nuevo');
    check(/otras 2 alertas/.test(await page.locator('.sos-ov-more').innerText()), 'sev: contador de otras alertas pendientes en el cartel');
    check(/1 alerta|3 alertas/.test(await page.locator('#sos').innerText()) && !/alerta\(s\)/.test(await page.locator('#sos').innerText()), 'copy: plural correcto en el banner');
    await shot(page, `${TAG}-cartel-1440-dark`);
    await page.emulateMedia({ colorScheme: 'light' }); await page.setViewportSize({ width: 375, height: 812 }); await page.waitForTimeout(250);
    await shot(page, `${TAG}-cartel-375-light`);
    await page.emulateMedia({ colorScheme: 'dark' }); await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(250);
    await page.locator('#sosOverlay textarea').fill('Voy para allá');
    await page.locator('.sos-ov-go').click();
    check(await waitFor(() => posts(state, 'event_acks').some(x => x.body && x.body.event_id === 'e-sos' && x.body.note === 'Voy para allá')), 'atender: el boton del cartel inserta el acuse con la nota');
    check(await waitFor(async () => /4133/.test(await page.locator('#sosOvWho').innerText())), 'atender: el cartel pasa a la siguiente alerta (4133)');
    check(await page.locator('#sosOverlay').isVisible(), 'atender: el cartel sigue visible mientras haya criticas');
    await page.locator('.sos-ov-go').click();
    await waitFor(() => posts(state, 'event_acks').length >= 2);
    await page.waitForTimeout(500);
    // queda la geocerca de peligro (alta): sigue en el cartel
    await page.locator('.sos-ov-go').click();
    await waitFor(() => posts(state, 'event_acks').length >= 3);
    check(await waitFor(async () => !(await page.locator('#sosOverlay').isVisible())), 'atender: sin pendientes el cartel se cierra');
    check(await page.evaluate(() => document.activeElement && document.activeElement.id === 'pendH'), 'foco: tras atender la ultima, el foco va al titulo de Pendientes');
    check(/Todo en orden/.test(await page.locator('#pendList').innerText()), 'estado vacio con conexion: "Todo en orden"');
    await ctx.close();
  }
  // b) solo nivel medio (casco sin usar): sin cartel, banner ambar en role=status, etiqueta AVISO
  {
    const evs = [{ id: 'e-nw', device_id: '4140', type: 'not_worn', created_at: iso(50000), lat: null, lng: null, battery: 50, payload: null, media_path: null }];
    const [ctx, page] = await newPage({ evs });
    check(!(await page.locator('#sosOverlay').isVisible()), 'sev: casco sin usar solo no abre cartel a pantalla completa');
    check((await page.locator('#sos').getAttribute('role')) === 'status' && (await page.locator('#sos').getAttribute('class')) === 'med', 'sev: banner de nivel medio es role=status y ambar');
    check(/AVISO/.test(await page.locator('#pendList .pitem').first().innerText()), 'sev: tarjeta de nivel medio lleva la etiqueta AVISO');
    check(await page.locator('#navPend').evaluate(e => e.classList.contains('med')), 'sev: insignia de pestaña en estilo medio');
    check(!(await page.locator('#navPend').getAttribute('aria-hidden')) && /pendiente/.test(await page.locator('#tabMain').getAttribute('aria-label')), 'a11y: la insignia no es aria-hidden y la pestaña la nombra');
    await ctx.close();
  }
  // c) paneles de video colapsados en el Centro; header compacto y 7 pestañas completas en 375
  {
    const [ctx, page] = await newPage({});
    await closeOv(page);
    const lv = page.locator('#lives .live').first();
    check(await lv.evaluate(e => e.classList.contains('collapsed')) && !(await lv.locator('.live-body').isVisible()), 'video: los paneles inactivos nacen colapsados en el Centro');
    check(/^Ver en vivo/.test(await lv.locator('.bview').innerText()) && (await lv.locator('.bview').getAttribute('aria-expanded')) === 'false', 'video: boton "Ver en vivo" del panel colapsado');
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => ({ hh: document.querySelector('header.top').getBoundingClientRect().height, tabs: [...document.querySelectorAll('#mainNav [role=tab]')].map(b => { const r = b.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; }), who: document.getElementById('who').innerText.replace(/\s+/g, ' '), role: !!document.querySelector('.who-role') }));
    check(m.hh <= 96, 'responsive: encabezado <= 96 px en 375 (' + Math.round(m.hh) + ' px)');
    check(m.tabs.length === 10 && m.tabs.every(t => t[1] - t[0] >= 44) && m.tabs[0][0] >= 0, 'responsive: las 10 pestañas (barra deslizable) tienen >= 44 px de ancho en 375 ' + JSON.stringify(m.tabs.map(t => t[1] - t[0])));
    check(m.role && /supervisor/.test(m.who), 'header: el rol se ve completo (' + m.who + ')');
    await ctx.close();
  }
}

// ---- 13) Tanda C: Asistencia, Constancias, Auditoria, huella SHA-256, log_access, rol auditor ----
const logsOf = S => (S.logs || []).map(b => b.action);
const printStub = page => page.evaluate(() => { window.__p = 0; window.print = () => { window.__p++; }; });
const dl = async (page, locator) => {
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }).catch(() => null), locator.click()]);
  return d ? fs.readFileSync(await d.path(), 'utf8') : '';
};
const unnamed = (page, root) => page.evaluate(r => [...document.querySelectorAll(r + ' input:not([type=hidden]), ' + r + ' select, ' + r + ' textarea')]
  .filter(e => e.offsetParent && !(e.labels && e.labels.length) && !e.getAttribute('aria-label')).length, root);
if (!process.env.ONLY4) {
  // a) Asistencia: abrir a mano, cerrar con resultado y nota, KPIs, CSV, imprimir
  {
    const state = {};
    const [ctx, page] = await newPage({ t4: true, state });
    await closeOv(page);
    const ids = await page.evaluate(() => [...document.querySelectorAll('#mainNav [role=tab]')].map(b => b.id));
    check(JSON.stringify(ids) === JSON.stringify(['tabMain', 'tabLive', 'tabMap', 'tabEq', 'tabAsis', 'tabConst', 'tabDone', 'tabRep', 'tabAud', 'tabCmd']), 'tandaC: pestañas nuevas en la barra: ' + ids.join(','));
    check(await page.locator('#tabAud').isVisible(), 'tandaC: admin ve Auditoría');
    await page.click('#tabAsis');
    check(await waitFor(async () => /Sesiones abiertas \(0\)/.test(await page.locator('#asisHost').innerText())), 'asis: la pestaña carga sin sesiones abiertas');
    check(/Calibrar la bomba/.test(await page.locator('#asisHost').innerText()), 'asis: la lista del día muestra la sesión cerrada con su tema');
    const sf = page.locator('#asisHost form', { hasText: 'Iniciar una sesión de asistencia' });
    await sf.locator('button[type=submit]').click();
    check(/Elegí un casco/.test(await sf.innerText()), 'asis: validación al iniciar sin casco');
    await sf.locator('select').selectOption('4133');
    await sf.locator('input[type=text]').fill('Reparar bomba de lodo');
    await sf.locator('button[type=submit]').click();
    check(await waitFor(() => posts(state, 'assist_sessions').some(x => x.method === 'POST' && x.body.device_id === '4133' && x.body.topic === 'Reparar bomba de lodo')), 'asis: Iniciar sesión inserta assist_sessions(device_id, topic)');
    check(await waitFor(async () => /Sesiones abiertas \(1\)/.test(await page.locator('#asisHost').innerText())), 'asis: aparece en abiertas');
    check(/1 sesión abierta/.test((await page.locator('#tabAsis').getAttribute('aria-label')) || ''), 'asis: la pestaña avisa "1 sesión abierta"');
    check(await unnamed(page, '#panelAsis') === 0, 'a11y: todos los campos de Asistencia tienen nombre accesible');
    const cf = page.locator('#asisHost .assist-close');
    await cf.locator('button[type=submit]').click();
    check(/Elegí el resultado/.test(await cf.innerText()), 'asis: cerrar exige resultado');
    await cf.locator('select').selectOption('resuelto');
    await cf.locator('input[type=text]').fill('Se cambió el sello');
    await cf.locator('input[type=number]').fill('2');
    await cf.locator('button[type=submit]').click();
    check(await waitFor(() => posts(state, 'assist_sessions').some(x => x.method === 'PATCH' && x.body.outcome === 'resuelto' && x.body.note === 'Se cambió el sello' && x.body.photos === 2 && typeof x.body.ended_at === 'string')), 'asis: cerrar envía ended_at, outcome, note y photos');
    check(await waitFor(async () => /Sesiones abiertas \(0\)/.test(await page.locator('#asisHost').innerText())), 'asis: la sesión cerrada sale de abiertas');
    const kp = await page.locator('#asisHost .kpis').innerText();
    check(/Sesiones\s*2/.test(kp.replace(/\n/g, ' ')) && /50 %/.test(kp), 'asis: KPIs (2 sesiones, 50 % resueltas): ' + kp.replace(/\s+/g, ' '));
    await shot(page, `${TAG}-asistencia-1440`);
    const csv = await dl(page, page.locator('#asisHost button', { hasText: 'Exportar CSV' }));
    const lines = csv.split('\r\n').filter(Boolean);
    check(csv.charCodeAt(0) === 0xFEFF && lines.length === 3 && lines[0].includes('"inicio";"fin";"casco"'), 'asis: CSV con BOM, ; y 2 filas (' + lines.length + ')');
    check(/^"\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}";/.test((lines[1] || '').replace('﻿', '')), 'asis: fecha dd/mm/aaaa HH:mm en el CSV');
    await printStub(page);
    await page.locator('#asisHost button', { hasText: 'Imprimir' }).click();
    check(await waitFor(async () => (await page.evaluate(() => window.__p)) === 1) && /Empleador/.test(await page.locator('#asisPrint').textContent()), 'asis: Imprimir / PDF con encabezado del empleador');
    check(await waitFor(() => logsOf(state).includes('assist_open') && logsOf(state).includes('assist_close') && logsOf(state).includes('export_csv') && logsOf(state).includes('export_pdf')),
      'log_access: assist_open, assist_close, export_csv, export_pdf (' + [...new Set(logsOf(state))].join(',') + ')');
    await ctx.close();
  }
  // b) apertura automatica al tocar Iniciar / Hablar + mini-cartel
  {
    const state = {};
    const [ctx, page] = await newPage({ t4: true, state });
    await closeOv(page);
    await page.click('#tabLive');
    const sec = page.locator('#lives .live', { hasText: '4132' });
    await sec.locator('button', { hasText: 'Iniciar' }).first().click();
    check(await waitFor(() => posts(state, 'assist_sessions').some(x => x.method === 'POST' && x.body.device_id === '4132')), 'auto: Iniciar abre sola una sesión de asistencia con el casco');
    const mini = sec.locator('.assist-mini');
    check(await waitFor(async () => /Asistencia en curso/.test(await mini.innerText())) && /Se abrió sola/.test(await mini.innerText()), 'auto: mini-cartel en En vivo con el estado');
    await page.waitForTimeout(400);
    check(posts(state, 'assist_sessions').filter(x => x.method === 'POST').length === 1, 'auto: una sola sesión por casco aunque se toque de nuevo');
    await sec.locator('button', { hasText: 'Iniciar' }).first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
    check(posts(state, 'assist_sessions').filter(x => x.method === 'POST').length === 1, 'auto: no duplica si ya hay una abierta');
    await mini.locator('select').selectOption('sin_resolver');
    await mini.locator('input[type=text]').fill('Sin señal en el pozo');
    await mini.locator('button[type=submit]').click();
    check(await waitFor(() => posts(state, 'assist_sessions').some(x => x.method === 'PATCH' && x.body.outcome === 'sin_resolver' && x.body.note === 'Sin señal en el pozo')), 'auto: se cierra desde el mini-cartel con resultado y nota');
    check(await waitFor(async () => /Registrar asistencia/.test(await mini.innerText())), 'auto: el mini-cartel vuelve a "Registrar asistencia"');
    await sec.getByRole('button', { name: /Hablar con el casco 4132/ }).click();   // cierra y reabre: Hablar tambien abre sola
    check(await waitFor(() => posts(state, 'assist_sessions').filter(x => x.method === 'POST').length === 2), 'auto: Hablar abre sola una sesión si no hay abierta');
    check(await waitFor(() => logsOf(state).includes('view_live') && logsOf(state).includes('assist_open') && logsOf(state).includes('login')), 'log_access: view_live, assist_open y login (' + [...new Set(logsOf(state))].join(',') + ')');
    await ctx.close();
  }
  // c) Constancias: EPP (alta, validacion, correccion, CSV, imprimir), capacitacion (RPC), empleador
  {
    const state = {};
    const [ctx, page] = await newPage({ t4: true, state });
    await closeOv(page);
    await page.click('#tabConst');
    check(await waitFor(async () => /Guantes dieléctricos/.test(await page.locator('#constBody').innerText())), 'const: lista de EPP con la constancia cargada');
    check(/Marcos Peralta/.test(await page.locator('#constBody').innerText()) && /30111222/.test(await page.locator('#constBody').innerText()), 'const: admin ve el DNI del trabajador');
    await page.locator('#constBody button', { hasText: 'Nueva entrega de EPP' }).click();
    const form = page.locator('#constForm form');
    await form.locator('button[type=submit]').click();
    check(/Trabajador: es obligatorio/.test(await form.innerText()) && /Producto: es obligatorio/.test(await form.innerText()), 'const: validación de campos obligatorios del EPP');
    check(await unnamed(page, '#constForm') === 0, 'a11y: todos los campos del formulario de EPP tienen nombre accesible');
    const sels = form.locator('select');   // trabajador, casco, certificacion, conformidad
    await sels.nth(0).selectOption('p2');
    await form.locator('input[type=text]').first().fill('Casco de seguridad');
    await form.locator('input[type=number]').fill('2');
    await sels.nth(2).selectOption('si');
    await sels.nth(3).selectOption('con_observaciones');
    await form.locator('button[type=submit]').click();
    check(/Observación: es obligatoria/.test(await form.innerText()), 'const: observación obligatoria con "con observaciones"');
    await form.locator('input[type=text]').nth(4).fill('Talle chico');
    await form.locator('button[type=submit]').click();
    check(await waitFor(() => posts(state, 'epp_deliveries').some(x => x.body && x.body.person_id === 'p2' && x.body.item === 'Casco de seguridad' && x.body.quantity === 2 && x.body.certified === true
      && x.body.worker_ack === 'con_observaciones' && x.body.observation === 'Talle chico' && !('created_by' in x.body))), 'const: alta de EPP inserta solo las columnas permitidas');
    check(await waitFor(async () => /Casco de seguridad/.test(await page.locator('#constBody').innerText())), 'const: la nueva entrega aparece en el listado');
    // corregir la del seed: supersedes
    await page.locator('#constBody tbody tr', { hasText: 'Guantes' }).locator('button', { hasText: 'Corregir' }).click();
    const f2 = page.locator('#constForm form');
    check(await f2.locator('select').first().isDisabled(), 'const: en la corrección la persona no se puede cambiar');
    await f2.locator('input[type=number]').fill('3');
    await f2.locator('button[type=submit]').click();
    check(await waitFor(() => posts(state, 'epp_deliveries').some(x => x.body && x.body.supersedes === 'epp-seed' && x.body.quantity === 3)), 'const: la corrección se guarda con supersedes');
    check(await waitFor(async () => /Reemplazada por una corrección/.test(await page.locator('#constBody').innerText())), 'const: el registro corregido queda marcado como reemplazado');
    const csv = await dl(page, page.locator('#constBody button', { hasText: 'Exportar CSV' }));
    check(csv.charCodeAt(0) === 0xFEFF && /"fecha_entrega";"trabajador"/.test(csv) && /"\d{2}\/\d{2}\/\d{4}";/.test(csv.split('\r\n')[1].replace('﻿', '')), 'const: CSV de EPP con BOM, ; y fecha dd/mm/aaaa');
    await printStub(page);
    await page.locator('#constBody tbody tr').first().locator('button', { hasText: 'Imprimir constancia' }).click();
    check(await waitFor(async () => (await page.evaluate(() => window.__p)) === 1) && /Constancia de entrega de EPP/.test(await page.locator('#constPrint').textContent()), 'const: imprimir una constancia individual');
    // capacitacion
    await page.click('#constTabTrn');
    check(await waitFor(async () => /Trabajo en altura/.test(await page.locator('#constBody').innerText())) && /Falta el arnés/.test(await page.locator('#constBody').innerText()), 'const: lista de capacitaciones con asistentes y observación');
    await page.locator('#constBody button', { hasText: 'Nueva capacitación' }).click();
    const tf = page.locator('#constForm form');
    await tf.locator('button[type=submit]').click();
    check(/Tema: es obligatorio/.test(await tf.innerText()) && /Capacitador: es obligatorio/.test(await tf.innerText()), 'const: validación de la capacitación');
    check(await unnamed(page, '#constForm') === 0, 'a11y: campos de la capacitación con nombre accesible');
    await tf.locator('input[type=text]').nth(0).fill('Uso de extintores');
    await tf.locator('input[type=text]').nth(1).fill('Lic. Gómez');
    const ts = tf.locator('select');
    await ts.nth(0).selectOption('presencial'); await ts.nth(1).selectOption('sincronica'); await ts.nth(2).selectOption('si');
    await tf.locator('button[type=submit]').click();
    check(/al menos una persona/.test(await tf.innerText()), 'const: pide al menos un asistente');
    await tf.locator('.att-row input[type=checkbox]').first().check();
    await tf.locator('button[type=submit]').click();
    check(await waitFor(() => posts(state, 'rpc/create_training').some(x => x.body && x.body.topic === 'Uso de extintores' && x.body.attendees.length === 1 && x.body.attendees[0].person_id === 'p1'
      && x.body.assisted === true && x.body.modality_place === 'presencial' && !('supersedes' in x.body))), 'const: la capacitación se carga por rpc create_training con attendees');
    check(await waitFor(async () => /Uso de extintores/.test(await page.locator('#constBody').innerText())), 'const: la nueva capacitación aparece');
    // empleador
    await page.click('#constTabOrg');
    await page.locator('#constBody input').nth(0).fill('Petrolera Sur S.A.');
    await page.locator('#constBody input').nth(1).fill('123');
    await page.locator('#constBody button[type=submit]').click();
    check(/CUIT/.test(await page.locator('#constBody .err').innerText()), 'org: valida el CUIT');
    await page.locator('#constBody input').nth(1).fill('30123456789');
    await page.locator('#constBody button[type=submit]').click();
    check(await waitFor(() => posts(state, 'org_settings').some(x => x.method === 'POST' && x.body.id === 1 && x.body.legal_name === 'Petrolera Sur S.A.' && x.body.cuit === '30-12345678-9')), 'org: guarda con id = 1 y CUIT normalizado');
    await page.click('#tabAsis');
    await printStub(page);
    await waitFor(() => page.locator('#asisHost button', { hasText: 'Imprimir' }).isEnabled());
    await page.locator('#asisHost button', { hasText: 'Imprimir' }).click();
    check(await waitFor(async () => /Petrolera Sur S\.A\./.test(await page.locator('#asisPrint').textContent())), 'org: el encabezado impreso usa los datos del empleador');
    check(await waitFor(() => ['epp_create', 'training_create', 'config_change'].every(a => logsOf(state).includes(a))), 'log_access: epp_create, training_create, config_change');
    await ctx.close();
  }
  // d) Auditoria: tabla paginada, filtros, CSV; el supervisor no la ve
  {
    const state = {};
    const [ctx, page] = await newPage({ t4: true, state });
    await closeOv(page);
    await page.click('#tabAud');
    check(await waitFor(async () => (await page.locator('#audHost tbody tr').count()) === 50), 'aud: 50 filas en la primera página');
    check(await unnamed(page, '#panelAud') === 0, 'a11y: filtros de Auditoría con nombre accesible');
    await page.locator('#audHost .pager button', { hasText: 'Siguiente' }).click();
    check(await waitFor(async () => /Página 2/.test(await page.locator('#audHost .pager').innerText())) && (await page.locator('#audHost tbody tr').count()) === 50, 'aud: paginación, página 2');
    await page.locator('#audHost select').selectOption('export_csv');
    await page.locator('#audHost button[type=submit]').click();
    check(await waitFor(async () => { const n = await page.locator('#audHost tbody tr').count(); return n === 20 && /Exportó un CSV/.test(await page.locator('#audHost tbody').innerText()); }), 'aud: filtro por acción');
    const rows = await page.evaluate(() => [...document.querySelectorAll('#audHost tbody tr')].every(r => /Exportó un CSV/.test(r.textContent)));
    check(rows, 'aud: todas las filas son de la acción elegida');
    await page.locator('#audHost select').selectOption('');
    await page.locator('#audHost button[type=submit]').click();
    await waitFor(async () => (await page.locator('#audHost tbody tr').count()) === 50);
    const csv = await dl(page, page.locator('#audHost button', { hasText: 'Exportar CSV' }));
    const lines = csv.split('\r\n').filter(Boolean);
    check(csv.charCodeAt(0) === 0xFEFF && lines.length === 121 && /^"\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}";/.test(lines[1].replace('﻿', '')), 'aud: CSV con BOM, ; y fecha AR (' + lines.length + ')');
    await shot(page, `${TAG}-auditoria-1440`);
    check(await waitFor(() => logsOf(state).includes('export_csv')), 'log_access: la exportación de la auditoría queda registrada');
    await ctx.close();
    const [c2, p2] = await newPage({ t4: true, role: 'viewer', state: {} });
    await closeOv(p2);
    check(!(await p2.locator('#tabAud').isVisible()) && await p2.locator('#tabConst').isVisible() && await p2.locator('#tabAsis').isVisible(), 'viewer: ve Asistencia y Constancias pero no Auditoría');
    await p2.click('#tabConst');
    check(await waitFor(async () => /Guantes/.test(await p2.locator('#constBody').innerText())), 'viewer: lista EPP');
    check(!/30111222/.test(await p2.locator('#constBody').innerText()) && /DNI del trabajador solo lo ve un administrador/.test(await p2.locator('#constBody').innerText()), 'viewer: sin DNI en la constancia, con aviso');
    check(await p2.locator('#constBody button', { hasText: 'Nueva entrega de EPP' }).isVisible(), 'viewer: puede cargar constancias');
    await c2.close();
  }
  // e) huella SHA-256: Integro / No coincide / Sin huella
  {
    const state = {};
    const h = { hash_alg: 'sha256', size: PNG.length, captured_at: iso(1000) };
    const evs = [...events,
      { id: 'e-hok', device_id: '4132', type: 'photo', created_at: iso(5000), lat: null, lng: null, battery: 15, payload: { ...h, sha256: PNG_SHA }, media_path: '4132/ok.jpg' },
      { id: 'e-hbad', device_id: '4132', type: 'photo', created_at: iso(6000), lat: null, lng: null, battery: 15, payload: { ...h, sha256: 'a'.repeat(64) }, media_path: '4132/bad.jpg' },
      { id: 'e-hnone', device_id: '4132', type: 'video', created_at: iso(7000), lat: null, lng: null, battery: 15, payload: {}, media_path: '4132/v.mp4' }];
    const [ctx, page] = await newPage({ evs, state });
    await closeOv(page);
    await page.click('#tabDone');
    const btn = id => page.locator('#feed li[data-id="' + id + '"] .verify-row button');
    check(await waitFor(async () => (await btn('e-hok').count()) === 1 && (await btn('e-hbad').count()) === 1 && (await btn('e-hnone').count()) === 1), 'hash: foto y video del Historial tienen "Verificar integridad"');
    check(/Verificar integridad, foto del casco 4132/.test((await btn('e-hok').getAttribute('aria-label')) || ''), 'a11y: el nombre accesible empieza con el texto visible');
    await btn('e-hok').click();
    check(await waitFor(async () => /Íntegro/.test(await page.locator('#feed li[data-id="e-hok"] .verify-st').innerText())), 'hash: huella coincide -> Íntegro');
    await btn('e-hbad').click();
    check(await waitFor(async () => /No coincide/.test(await page.locator('#feed li[data-id="e-hbad"] .verify-st').innerText())), 'hash: huella distinta -> No coincide');
    await btn('e-hnone').click();
    check(await waitFor(async () => /Sin huella registrada/.test(await page.locator('#feed li[data-id="e-hnone"] .verify-st').innerText())), 'hash: sin huella -> aviso');
    check(await waitFor(() => (state.logs || []).filter(l => l.action === 'hash_verify').length === 3), 'log_access: 3 hash_verify');
    const r = (state.logs || []).find(l => l.action === 'hash_verify' && l.detail && l.detail.resultado === 'ok');
    check(!!r && r.target === '4132/ok.jpg', 'log_access: hash_verify con target = ruta del archivo');
    await ctx.close();
  }
  // f) log_access: 1 reintento, silencioso y sin bloquear la accion; sin migracion no insiste
  {
    const state = { logFail: 1 };
    const [ctx, page] = await newPage({ t4: true, state });
    await closeOv(page);
    state.logs = []; state.posts = [];
    await page.click('#tabLive');
    const sec = page.locator('#lives .live', { hasText: '4132' });
    state.logFail = 1;
    await sec.getByRole('button', { name: /Sacar foto, casco 4132/ }).click();
    check(await waitFor(() => posts(state, 'device_commands').length === 1), 'log: la acción se envía aunque el registro falle');
    check(await waitFor(() => posts(state, 'rpc/log_access').length >= 2 && (state.logs || []).some(l => l.action === 'photo')), 'log: reintenta una vez y el asiento llega (' + posts(state, 'rpc/log_access').length + ' pedidos)');
    check(!(await page.locator('#vigToast').isVisible().catch(() => false)), 'log: el fallo es silencioso (sin aviso en pantalla)');
    await ctx.close();
    const st2 = {};
    const [c2, p2] = await newPage({ t4: true, noNew: true, state: st2 });
    await closeOv(p2);
    await p2.click('#tabLive');
    const s2 = p2.locator('#lives .live', { hasText: '4132' });
    await s2.getByRole('button', { name: /Probar enlace, casco 4132/ }).click();
    await s2.locator('button', { hasText: 'Iniciar' }).first().click();
    await p2.waitForTimeout(1500);
    check(posts(st2, 'rpc/log_access').length <= 1, 'log sin migración: deja de insistir tras el primer 404 (' + posts(st2, 'rpc/log_access').length + ')');
    check(posts(st2, 'stream_commands').some(x => x.body && x.body.action === 'start'), 'sin migración: Iniciar sigue funcionando');
    check(!(await s2.locator('.assist-mini').isVisible()), 'sin migración: no hay mini-cartel de asistencia');
    for (const [tab, host] of [['#tabAsis', '#asisHost'], ['#tabConst', '#constBody'], ['#tabAud', '#audHost']]) {
      await p2.click(tab);
      check(await waitFor(async () => /Falta aplicar la migración 013/.test(await p2.locator(host).innerText())), 'sin migración: ' + tab + ' dice "Falta aplicar la migración 013"');
    }
    await c2.close();
  }
  // g) rol auditor: solo lectura
  {
    const state = {};
    const evs = [...events, { id: 'e-hok', device_id: '4132', type: 'photo', created_at: iso(5000), lat: null, lng: null, battery: 15, payload: { sha256: PNG_SHA, hash_alg: 'sha256' }, media_path: '4132/ok.jpg' }];
    const [ctx, page] = await newPage({ t4: true, role: 'auditor', evs, state });
    check(/auditor/.test(await page.locator('#who').innerText()), 'auditor: el rol se muestra');
    check(!(await page.locator('.sos-ov-go').isVisible()), 'auditor: el cartel no tiene Atender');
    await closeOv(page);
    check((await page.locator('#pendList .a-act').count()) === 0 && (await page.locator('#pendList button.attend').count()) === 0, 'auditor: tarjetas pendientes sin nota ni Atender');
    check(!(await page.locator('#orders').isVisible()) && !(await page.locator('#tabLive').isVisible()) && !(await page.locator('#tabMap').isVisible()), 'auditor: sin órdenes, En vivo ni Mapa');
    check(await page.locator('#toolbarAud').isVisible(), 'auditor: aviso de solo lectura');
    check((await page.locator('.cmdbar').count()) === 0, 'auditor: sin comandos a pedido');
    await page.click('#tabAsis');
    check(await waitFor(async () => /Sesiones abiertas/.test(await page.locator('#asisHost').innerText())) && !(await page.locator('#asisHost form', { hasText: 'Iniciar una sesión' }).count()), 'auditor: Asistencia en solo lectura (sin formulario)');
    await page.click('#tabConst');
    check(await waitFor(async () => /Guantes/.test(await page.locator('#constBody').innerText())) && (await page.locator('#constBody button', { hasText: /Nueva|Corregir/ }).count()) === 0, 'auditor: Constancias sin Nueva ni Corregir');
    check(!/30111222/.test(await page.locator('#constBody').innerText()), 'auditor: sin DNI');
    await page.click('#constTabTrn');
    check(await waitFor(async () => /Trabajo en altura/.test(await page.locator('#constBody').innerText())), 'auditor: lee capacitaciones');
    check((state.attTable || []).every(t => t === 'training_attendees_audit') && (state.attTable || []).length > 0, 'auditor: asistentes por la vista training_attendees_audit');
    const body = await page.locator('#constBody').innerText();
    check(/Falta el arnés/.test(body) && /Observaciones \(sin identificar\)/.test(body) && !/Lucía Ferreyra · Con observaciones/.test(body), 'auditor: observación sin la persona al lado');
    await page.click('#tabAud');
    check(await waitFor(async () => (await page.locator('#audHost tbody tr').count()) === 50), 'auditor: ve la auditoría');
    await page.click('#tabDone');
    check((await page.locator('#feed .verify-row').count()) === 0 && /huella SHA-256 registrada/.test(await page.locator('#feed').innerText()), 'auditor: sin Storage -> no verifica, solo ve la huella registrada');
    const wr = posts(state, 'event_acks').length + posts(state, 'broadcasts').length + posts(state, 'device_commands').length + posts(state, 'assist_sessions').length;
    check(wr === 0, 'auditor: no escribió nada (' + wr + ')');
    await ctx.close();
  }
  // h) 375 px: sin desborde y objetivos tactiles en las pestañas nuevas
  {
    const [ctx, page] = await newPage({ t4: true, state: {} });
    await closeOv(page);
    await page.setViewportSize({ width: 375, height: 812 });
    for (const [tab, name] of [['#tabAsis', 'asistencia'], ['#tabConst', 'constancias'], ['#tabAud', 'auditoria']]) {
      await page.click(tab); await page.waitForTimeout(700);
      if (tab === '#tabConst') { await page.locator('#constBody button', { hasText: 'Nueva entrega de EPP' }).click(); await page.waitForTimeout(200); }
      const m = await page.evaluate(() => ({ ov: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        small: [...document.querySelectorAll('.content :is(button,input:not([type=checkbox]),select):not(.hidden)')].filter(e => e.offsetParent && !e.closest('.hidden') && e.getBoundingClientRect().height < 43.5).length }));
      check(!m.ov, 'responsive 375: ' + name + ' sin desborde horizontal');
      check(m.small === 0, 'responsive 375: ' + name + ' con controles >= 44 px (' + m.small + ' chicos)');
      await shot(page, `${TAG}-${name}-375`);
    }
    await ctx.close();
  }
}

await browser.close();
server.close();
log('ERRORS:', errors.length);
errors.forEach(e => log('  ' + e));
fs.writeFileSync(`${OUT}/rediseno-test-${TAG}.log`, report.join('\n'));
