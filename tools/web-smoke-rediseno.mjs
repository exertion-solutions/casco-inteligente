import { chromium } from 'file:///C:/Users/jcastro/eia-app/node_modules/.pnpm/playwright-core@1.63.0/node_modules/playwright-core/index.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const WEB = process.env.WEBDIR || 'C:/CASCO INTELIGENTE/web';
const OUT = 'C:/CASCO INTELIGENTE/out';
const TAG = process.argv[2] || 'a';
const SB = 'https://zgfvhjpdzkohouktakvt.supabase.co';
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

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
const JWT = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: 'u1', role: 'authenticated', exp: 4102444800, app_metadata: { role: 'admin' } }) + '.sig';
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
const devicesT = [
  { device_id: '4132', name: 'Casco Perforación', model: 'rd_aqm6816', group_id: 'g1', sector: 'Pozo 12', status: 'activo', imei: '860000000000001' },
  { device_id: '4133', name: 'Casco Mantenimiento', model: 'rd_aqm6816', group_id: 'g1', sector: 'Planta', status: 'activo' },
  { device_id: '4140', name: 'Casco Reserva', model: 'rd_aqm6816', group_id: null, sector: '', status: 'mantenimiento' },
];
const people = [{ id: 'p1', full_name: 'Marcos Peralta', legajo: '1042', job_title: 'Operario', sector: 'Pozo 12', group_id: 'g1', active: true, dni: '30111222', contact_phone: '+54 11 5555-1234' },
  { id: 'p2', full_name: 'Lucía Ferreyra', legajo: '1077', job_title: 'Técnica', sector: 'Planta', group_id: 'g1', active: true }];
const groups = [{ id: 'g1', name: 'Cuadrilla Norte', site: 'Yacimiento Sur', notes: '', active: true }];
const assigns = [{ id: 'a1', device_id: '4132', person_id: 'p1', starts_at: iso(86400000), ends_at: null }];
const geofences = [{ id: 'z1', name: 'Pileta de ácido', kind: 'restringida', shape: 'circle', geometry: { center: [-34.602, -58.399], radius_m: 120 }, message: 'Zona restringida', alarm: 'voz_y_sirena', device_ids: null, active: true }];
const points = [{ id: 'pt1', name: 'Punto de reunión A', category: 'punto_reunion', lat: -34.605, lng: -58.395, notes: '', alert_radius_m: null, active: true }];

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
async function mock(ctx, opts = {}) {
  const H = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
  await ctx.route('https://216-238-110-97.sslip.io/**', r => {
    if (!opts.whep) return r.fulfill({ status: 503, headers: H, body: 'no' });
    const m = r.request().method();
    if (m === 'OPTIONS') return r.fulfill({ status: 204, headers: H });
    if (m === 'POST') return r.fulfill({ status: 201, headers: { ...H, location: '/live/4132/whep/s1', 'content-type': 'application/sdp' }, body: 'v=0\r\n' });
    return r.fulfill({ status: 200, headers: H, body: '' });
  });
  await ctx.route(SB + '/**', async route => {
    const req = route.request(), u = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const json = (o, status = 200) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(o) });
    if (u.pathname.includes('/auth/v1/token')) return json({ access_token: JWT, token_type: 'bearer', expires_in: 3600, refresh_token: 'r', user: { id: 'u1', email: 'supervisor@demo.test', app_metadata: { role: 'admin' }, aud: 'authenticated', created_at: iso(0) } });
    if (u.pathname.includes('/auth/v1/user')) return json({ id: 'u1', email: 'supervisor@demo.test', app_metadata: { role: 'admin' } });
    if (u.pathname.includes('/storage/')) return json({ signedURL: '/x' });
    const t = u.pathname.split('/rest/v1/')[1] || '';
    if (req.method() !== 'GET' && req.method() !== 'HEAD') return json(req.method() === 'POST' ? [{ id: 'new' }] : [], 201);
    const q = u.search;
    if (t === 'events') {
      if (opts.failEvents === 'srv') return json({ code: 'XX000', message: 'Error de servidor' }, 500);
      if (opts.failEvents) return json({ code: 'PGRST301', message: 'JWT expired' }, 401);
      if (q.includes('type=eq.heartbeat')) return json(hbs);
      if (q.includes('type=eq.location')) return json(locs);
      if (q.includes('type=in.')) return json([...events, ...(opts.old || [])]);
      return json([...((opts.state && opts.state.extra) || []), ...events]);
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
async function newPage(opts, deny) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', locale: 'es-AR', timezoneId: 'America/Argentina/Buenos_Aires', serviceWorkers: 'block', acceptDownloads: true });
  await mock(ctx, opts);
  if (process.env.NOAUTO || process.env.NOCROP) await ctx.addInitScript("let v;Object.defineProperty(window,'CASCO_CONFIG',{get:()=>v,set:x=>{v=x;" + (process.env.NOAUTO ? 'x.REC_AUTO_ON_ALERT=false;' : '') + (process.env.NOCROP ? 'x.OVERLAY_CROP={};' : '') + "}})");
  await ctx.addInitScript('window.__noTrack=' + (process.env.NOTRACK ? 'true' : 'false') + ';window.__noAudio=' + (process.env.NOAUDIO ? 'true' : 'false') + ';window.__micDeny=' + (deny ? 'true' : 'false') + ';(' + FAKE_RTC.toString() + ')()');
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
  check(!(await page.locator('#sosOverlay').isVisible()), 'Escape cierra el cartel SOS (Ver el panel)');
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
  check(/Casco 4132/.test(body) && /casco-4132_/.test(body) && /duración/.test(body), tag + 'cartel de guardado muestra casco, duracion y archivo');
  check(/solo en tu PC/.test(body) && /Informá al personal/.test(body), tag + 'cartel incluye aviso de guardado solo en la PC');
  if (deny) check(/sin micrófono/.test(body), tag + 'cartel avisa que no hay micrófono');
  else check(/micrófono y del casco/.test(body), tag + 'cartel indica audio de micrófono y casco');
  await page.keyboard.press('Escape');
  check(await page.locator('#saveOverlay').isVisible(), tag + 'Escape no descarta el cartel de guardado');
  await page.locator('#saveOverlay button', { hasText: 'Descartar' }).first().click();
  check(/¿Descartar sin guardar\?/.test(await page.locator('#saveOverlay').innerText()), tag + 'descartar pide confirmacion');
  await page.locator('#saveOverlay button', { hasText: 'Volver' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }).catch(() => null), page.locator('#saveOverlay button', { hasText: 'Guardar en mi PC' }).click()]);
  check(!!dl && /^casco-4132_.*\.(webm|mp4)$/.test(dl.suggestedFilename()), tag + 'Guardar en mi PC descarga el archivo: ' + (dl && dl.suggestedFilename()));
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
await browser.close();
server.close();
log('ERRORS:', errors.length);
errors.forEach(e => log('  ' + e));
fs.writeFileSync(`${OUT}/rediseno-test-${TAG}.log`, report.join('\n'));
