import { chromium } from 'file:///C:/Users/jcastro/eia-app/node_modules/.pnpm/playwright-core@1.63.0/node_modules/playwright-core/index.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const WEB = 'C:/CASCO INTELIGENTE/web';
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
  await ctx.route('https://216-238-110-97.sslip.io/**', r => r.fulfill({ status: 503, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }, body: 'no' }));
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
      if (opts.failEvents) return json({ code: 'PGRST301', message: 'JWT expired' }, 401);
      if (q.includes('type=eq.heartbeat')) return json(hbs);
      if (q.includes('type=eq.location')) return json(locs);
      return json(events);
    }
    if (t === 'event_acks') return json(acks);
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

const browser = await chromium.launch({ channel: 'chrome' });
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

for (const scheme of ['dark', 'light']) {
  for (const [sz, w, h] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, locale: 'es-AR', timezoneId: 'America/Argentina/Buenos_Aires', serviceWorkers: 'block' });
    await mock(ctx);
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(`[${scheme} ${sz}] pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !/tile\.openstreetmap|fonts\.g|ERR_|favicon/.test(m.text() + (m.location().url || ''))) errors.push(`[${scheme} ${sz}] console.error: ${m.text()} @ ${m.location().url}`); });
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
    const start = page.locator('#lives .live button', { hasText: 'Iniciar' }).first();
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
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', locale: 'es-AR', serviceWorkers: 'block' });
  await mock(ctx, { failEvents: true });
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
await browser.close();
server.close();
log('ERRORS:', errors.length);
errors.forEach(e => log('  ' + e));
fs.writeFileSync(`${OUT}/rediseno-test-${TAG}.log`, report.join('\n'));
