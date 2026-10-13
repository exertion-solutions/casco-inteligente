// Tests de la Edge Function notify con base y fetch simulados (sin red, sin Supabase).
// Uso (Node >= 22.18, que ejecuta .ts directamente):  node --test supabase/functions/notify/test.mjs
// Con Deno:  deno test --allow-env --allow-net supabase/functions/notify/test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { b64u, buildMail, buildPush, encryptPush, fmtAR, generateVapid, makeHandler, mapUrl, severity, unb64u } from "./index.ts";

const SECRET = "secreto-de-prueba-123";
const EID = "11111111-1111-1111-1111-111111111111";
const NOW = Date.parse("2026-10-13T17:08:00Z"); // 14:08 en Argentina
const ev = (o = {}) => ({
  id: EID, created_at: "2026-10-13T17:05:00Z", device_id: "4132", type: "sos", lat: -34.6, lng: -58.4, payload: {}, ...o,
});
const NOCHAN = { secret: null, webhookUrl: null, resendFrom: null, emailProvider: null, emailApiKey: null, emailFrom: null, emailFromName: null, vapidPublic: null, vapidPrivate: null };
const BREVO = { emailProvider: "brevo", emailApiKey: "xkeysib-clave-de-prueba-1234", emailFrom: "avisos@ejemplo.com", emailFromName: "Avisos Casco" };
const RESEND = { emailProvider: "resend", emailApiKey: "re_clave_de_prueba_1234", emailFrom: "avisos@ejemplo.com", emailFromName: null };

function fakeDb(o = {}) {
  const calls = { claim: [], finish: [], deleted: [], vapid: null };
  const db = {
    calls,
    channel: async () => ({ ...NOCHAN, ...(o.chan ?? {}) }),
    config: async () => o.cfg === undefined ? { enabled: true, remind_after_s: 180, cooldown_s: 300 } : o.cfg,
    recipients: async () => o.recipients ?? [
      { email: "critico@ejemplo.com", min_severity: "critica" },
      { email: "alta@ejemplo.com", min_severity: "alta" },
      { email: "media@ejemplo.com", min_severity: "media" },
    ],
    subscriptions: async (uid) => (o.subs ?? []).filter((s) => !uid || s.user_id === uid),
    deleteSub: async (e) => { calls.deleted.push(e); },
    saveVapid: async (pub, priv) => { calls.vapid = { pub, priv }; },
    event: async (id) => (o.event === undefined ? ev() : o.event)?.id === id ? (o.event ?? ev()) : null,
    acked: async () => { if (o.ackedThrows) throw new Error("db"); return o.acked === true; },
    deviceName: async () => o.name ?? "Casco Perforación",
    claim: async (id, kind) => { calls.claim.push([id, kind]); return o.claim !== false; },
    results: async () => o.prev ?? {},
    finish: async (id, kind, ok, channel, n, detail, results) => { calls.finish.push({ id, kind, ok, channel, n, detail, results }); },
    recentOk: async () => o.recent === true,
  };
  return db;
}

// plan: { webhook, resend, brevo, push: status | (url)=>status, failFor: [emails] }
function fakeFetch(plan = {}) {
  const log = [];
  const f = async (url, init) => {
    const u = String(url);
    const isPush = !/hooks\.example|api\.resend|api\.brevo/.test(u);
    const body = isPush ? init.body : JSON.parse(init.body);
    log.push({ url: u, headers: init.headers, body });
    let status = 200;
    if (u.includes("api.resend.com")) status = plan.resend ?? 200;
    else if (u.includes("api.brevo.com")) status = plan.brevo ?? 200;
    else if (isPush) status = typeof plan.push === "function" ? plan.push(u) : (plan.push ?? 201);
    else status = plan.webhook ?? 200;
    const to = body && (body.to?.[0]?.email ?? body.to?.[0]);
    if (plan.failFor && plan.failFor.includes(to)) status = 400;
    return new Response(null, { status });
  };
  f.log = log;
  return f;
}

const req = (body, headers = { "x-notify-secret": SECRET }, method = "POST") =>
  new Request("https://x.test/functions/v1/notify", { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

function mk(o = {}, f = fakeFetch(o.plan)) {
  const db = o.db ?? fakeDb(o.dbo);
  const handler = makeHandler({
    db, secret: o.secret === undefined ? SECRET : o.secret, fetch: f, now: () => NOW,
    webhookUrl: "webhook" in o ? o.webhook : "https://hooks.example.test/abc123SECRETPATH",
    resendKey: o.resendKey, from: o.from,
    getUser: async (jwt) => jwt === "admin-jwt" ? { id: "u-admin", app_metadata: { role: "admin" } }
      : jwt === "viewer-jwt" ? { id: "u-viewer", app_metadata: { role: "viewer" } }
      : jwt === "device-jwt" ? { id: "u-dev", app_metadata: { role: "device" } } : null,
  });
  return { handler, db, f };
}
const run = async (h, r) => { const res = await h(r); const t = await res.text(); return { status: res.status, text: t, json: t ? JSON.parse(t) : null }; };
const sentTo = (f, host) => f.log.filter((x) => x.url.includes(host)).map((x) => x.body.to?.[0]?.email ?? x.body.to?.[0]).sort();

// --- helpers push: suscripcion de un "navegador" simulado y descifrado RFC 8291 ---
async function fakeBrowser(endpoint = "https://push.example.test/send/abc") {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { kp, pub, auth, sub: { endpoint, p256dh: b64u(pub), auth: b64u(auth), min_severity: "alta", user_id: "u-viewer" } };
}
const catB = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let k = 0; for (const x of p) { o.set(x, k); k += x.length; } return o; };
async function hk(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}
async function decryptPush(b, body) {
  const salt = body.slice(0, 16), idlen = body[20], asPub = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
  const te = new TextEncoder(), z = new Uint8Array([0]);
  const asKey = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, b.kp.privateKey, 256));
  const prk = await hk(b.auth, ecdh, catB(te.encode("WebPush: info"), z, b.pub, asPub), 32);
  const cek = await hk(salt, prk, catB(te.encode("Content-Encoding: aes128gcm"), z), 16);
  const nonce = await hk(salt, prk, catB(te.encode("Content-Encoding: nonce"), z), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, ct));
  assert.equal(pt[pt.length - 1], 2, "delimitador de registro unico");
  return JSON.parse(new TextDecoder().decode(pt.slice(0, -1)));
}
async function verifyVapid(header, vapidPublic, endpoint) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.ok(m, "formato vapid");
  assert.equal(m[2], vapidPublic);
  const [h, c, s] = m[1].split(".");
  const claims = JSON.parse(new TextDecoder().decode(unb64u(c)));
  assert.equal(claims.aud, new URL(endpoint).origin);
  assert.ok(claims.exp > NOW / 1000 && claims.exp <= NOW / 1000 + 24 * 3600);
  const key = await crypto.subtle.importKey("raw", unb64u(vapidPublic), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, unb64u(s), new TextEncoder().encode(`${h}.${c}`)));
}

test("autenticacion: metodo, secreto y falla cerrada", async () => {
  const { handler } = mk();
  assert.equal((await handler(req(undefined, {}, "GET"))).status, 405);
  assert.equal((await handler(req(undefined, {}, "OPTIONS"))).status, 204);
  assert.equal((await handler(req({ event_id: EID, kind: "inmediato" }, {}))).status, 401);
  assert.equal((await handler(req({ event_id: EID, kind: "inmediato" }, { "x-notify-secret": "otro" }))).status, 401);
  const sinSecreto = mk({ secret: "" });
  assert.equal((await sinSecreto.handler(req({ event_id: EID, kind: "inmediato" }, { "x-notify-secret": "" }))).status, 401);
  assert.equal(sinSecreto.f.log.length, 0);
});

test("inmediato por webhook: un envio por destinatario, español, hora Argentina, mapa y enlace; filtra por min_severity", async () => {
  const { handler, db, f } = mk();
  const r = await run(handler, req({ event_id: EID, kind: "inmediato" }));
  assert.equal(r.status, 200);
  assert.equal(r.json.sent, 3);
  assert.equal(f.log.length, 3);
  assert.ok(f.log.every((x) => x.body.to.length === 1), "uno por destinatario");
  assert.deepEqual(sentTo(f, "hooks.example"), ["alta@ejemplo.com", "critico@ejemplo.com", "media@ejemplo.com"]);
  const b = f.log[0].body;
  assert.equal(b.severity, "critica");
  assert.equal(b.event_id, EID);
  assert.match(b.subject, /ALERTA CRÍTICA: SOS .* - casco 4132/);
  assert.match(b.text, /Casco: 4132 \(Casco Perforación\)/);
  assert.match(b.text, /Hora: 13\/10\/2026 14:05 \(hora de Argentina\)/);
  assert.match(b.text, /Hace: 3 min/);
  assert.match(b.text, /https:\/\/www\.google\.com\/maps\?q=-34\.600000,-58\.400000/);
  assert.match(b.text, /https:\/\/exertion-solutions\.github\.io\/casco-inteligente\//);
  assert.deepEqual(db.calls.claim, [[EID, "inmediato"]]);
  assert.equal(db.calls.finish[0].ok, true);
  assert.equal(db.calls.finish[0].results["alta@ejemplo.com"].ok, true);
  assert.ok(!/ejemplo\.com|hooks\.example|SECRETPATH/.test(r.text));
});

test("Brevo: POST a api.brevo.com con api-key, sender, to[{email}], htmlContent/textContent; uno por destinatario", async () => {
  const { handler, f, db } = mk({ webhook: undefined, dbo: { chan: BREVO } });
  const r = await run(handler, req({ event_id: EID, kind: "inmediato" }));
  assert.equal(r.status, 200);
  assert.equal(f.log.length, 3);
  const x = f.log[0];
  assert.equal(x.url, "https://api.brevo.com/v3/smtp/email");
  assert.equal(x.headers["api-key"], BREVO.emailApiKey);
  assert.deepEqual(x.body.sender, { email: "avisos@ejemplo.com", name: "Avisos Casco" });
  assert.equal(x.body.to.length, 1);
  assert.ok(x.body.to[0].email.endsWith("@ejemplo.com"));
  assert.match(x.body.subject, /^ALERTA CRÍTICA/);
  assert.ok(x.body.htmlContent.includes("<table") && x.body.textContent.includes("Casco: 4132"));
  assert.equal(db.calls.finish[0].channel, "brevo");
  assert.ok(!r.text.includes(BREVO.emailApiKey));
});

test("Resend por proveedor de la tabla: Bearer, from con nombre, to[] de uno", async () => {
  const { handler, f } = mk({ webhook: undefined, dbo: { chan: { ...RESEND, emailFromName: "Avisos Casco" } } });
  const r = await run(handler, req({ event_id: EID, kind: "inmediato" }));
  assert.equal(r.status, 200);
  assert.equal(f.log.length, 3);
  assert.equal(f.log[0].url, "https://api.resend.com/emails");
  assert.equal(f.log[0].headers.authorization, `Bearer ${RESEND.emailApiKey}`);
  assert.equal(f.log[0].body.from, "Avisos Casco <avisos@ejemplo.com>");
  assert.equal(f.log[0].body.to.length, 1);
  assert.ok(f.log[0].body.html && f.log[0].body.text);
});

test("un rebote no afecta a los otros; reintento solo repite a quien fallo; webhook de respaldo", async () => {
  const falla = mk({ webhook: undefined, plan: { failFor: ["alta@ejemplo.com"] }, dbo: { chan: BREVO } });
  const r = await run(falla.handler, req({ event_id: EID, kind: "inmediato" }));
  assert.equal(r.status, 502);
  assert.equal(r.json.sent, 2);
  assert.equal(r.json.failed, 1);
  const fin = falla.db.calls.finish[0];
  assert.equal(fin.ok, false);
  assert.equal(fin.results["alta@ejemplo.com"].ok, false);
  assert.equal(fin.results["critico@ejemplo.com"].ok, true);
  assert.ok(!/ejemplo\.com/.test(r.text));
  // reintento: con el resultado previo solo se manda a quien fallo
  const prev = fin.results;
  const retry = mk({ webhook: undefined, dbo: { chan: BREVO, prev } });
  const r2 = await run(retry.handler, req({ event_id: EID, kind: "inmediato" }));
  assert.equal(r2.status, 200);
  assert.deepEqual(retry.f.log.map((x) => x.body.to[0].email), ["alta@ejemplo.com"]);
  // proveedor rechaza -> el webhook de respaldo entrega a cada uno
  const resp = mk({ plan: { brevo: 401 }, dbo: { chan: BREVO } });
  const r3 = await run(resp.handler, req({ event_id: EID, kind: "inmediato" }));
  assert.equal(r3.status, 200);
  assert.equal(resp.f.log.filter((x) => x.url.includes("api.brevo.com")).length, 3);
  assert.equal(resp.f.log.filter((x) => x.url.includes("hooks.example")).length, 3);
  assert.equal(resp.db.calls.finish[0].results["alta@ejemplo.com"].ch, "webhook");
});

test("push: cifrado aes128gcm descifrable, VAPID valido, payload minimo sin coordenadas", async () => {
  const b = await fakeBrowser();
  const v = await generateVapid();
  const chan = { vapidPublic: v.publicKey, vapidPrivate: v.privateJwk };
  const { handler, f, db } = mk({ webhook: undefined, dbo: { chan, subs: [b.sub], recipients: [] } });
  const r = await run(handler, req({ event_id: EID, kind: "inmediato" }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.push, { sent: 1, failed: 0, gone: 0 });
  assert.equal(f.log.length, 1);
  const x = f.log[0];
  assert.equal(x.url, b.sub.endpoint);
  assert.equal(x.headers["content-encoding"], "aes128gcm");
  assert.equal(x.headers.urgency, "high");
  assert.equal(x.headers.topic, EID.replace(/-/g, ""));
  await verifyVapid(x.headers.authorization, v.publicKey, b.sub.endpoint);
  const msg = await decryptPush(b, x.body);
  assert.deepEqual(Object.keys(msg).sort(), ["body", "severity", "tag", "title", "url"]);
  assert.equal(msg.severity, "critica");
  assert.equal(msg.tag, EID);
  assert.match(msg.title, /ALERTA CRÍTICA: SOS/);
  assert.match(msg.body, /Casco 4132 · 13\/10\/2026 14:05 \(Argentina\)/);
  assert.equal(msg.url, "https://exertion-solutions.github.io/casco-inteligente/");
  assert.ok(!/-34\.6|-58\.4|Perforaci/.test(JSON.stringify(msg)), "sin coordenadas ni nombres");
  assert.equal(db.calls.finish[0].ok, true);
  assert.equal(db.calls.finish[0].channel, "push");
});

test("push: 410/404 borran la suscripcion; 500 no; nivel minimo por dispositivo; sin duplicar", async () => {
  const v = await generateVapid();
  const chan = { vapidPublic: v.publicKey, vapidPrivate: v.privateJwk };
  const mkSub = async (n, sev) => (await fakeBrowser(`https://push.example.test/${n}`)).sub && { ...(await fakeBrowser(`https://push.example.test/${n}`)).sub, min_severity: sev };
  const subs = [await mkSub("ok", "alta"), await mkSub("gone", "alta"), await mkSub("err", "alta"), await mkSub("solocritica", "critica")];
  const plan = { push: (u) => u.endsWith("/gone") ? 410 : u.endsWith("/err") ? 500 : 201 };
  const r = mk({ webhook: undefined, plan, dbo: { chan, subs, recipients: [] } });
  const res = await run(r.handler, req({ event_id: EID, kind: "inmediato" }));
  assert.deepEqual(res.json.push, { sent: 2, failed: 1, gone: 1 });
  assert.deepEqual(r.db.calls.deleted, ["https://push.example.test/gone"]);
  assert.equal(res.status, 200, "con al menos un push entregado el aviso cuenta como enviado");
  // severidad alta: el dispositivo "solo criticas" no recibe
  const alta = mk({ webhook: undefined, dbo: { chan, subs, recipients: [], event: ev({ type: "inactive" }) } });
  await alta.handler(req({ event_id: EID, kind: "inmediato" }));
  assert.ok(!alta.f.log.some((x) => x.url.endsWith("/solocritica")));
  assert.equal(alta.f.log.length, 3);
  // ya enviado antes (claim tomado): no se vuelve a mandar nada
  const dup = mk({ webhook: undefined, dbo: { chan, subs, recipients: [], claim: false } });
  assert.equal((await run(dup.handler, req({ event_id: EID, kind: "inmediato" }))).json.skipped, "ya_enviado_o_en_curso");
  assert.equal(dup.f.log.length, 0);
});

test("bootstrap_push (admin) genera y guarda el par VAPID una vez; test_push solo a mis dispositivos", async () => {
  const m = mk({ webhook: undefined });
  const r = await run(m.handler, req({ bootstrap_push: true }, { authorization: "Bearer admin-jwt" }));
  assert.deepEqual(r.json, { ok: true, created: true });
  assert.equal(unb64u(m.db.calls.vapid.pub).length, 65);
  assert.equal(JSON.parse(m.db.calls.vapid.priv).crv, "P-256");
  assert.equal((await m.handler(req({ bootstrap_push: true }, { authorization: "Bearer viewer-jwt" }))).status, 403);
  assert.equal((await m.handler(req({ bootstrap_push: true }))).status, 403);
  const ya = mk({ dbo: { chan: { vapidPublic: "x", vapidPrivate: "{}" } } });
  assert.equal((await run(ya.handler, req({ bootstrap_push: true }, { authorization: "Bearer admin-jwt" }))).json.created, false);

  const v = await generateVapid();
  const mine = await fakeBrowser("https://push.example.test/mio");
  const other = { ...(await fakeBrowser("https://push.example.test/ajeno")).sub, user_id: "u-otro" };
  const t = mk({ webhook: undefined, dbo: { chan: { vapidPublic: v.publicKey, vapidPrivate: v.privateJwk }, subs: [mine.sub, other] } });
  const rt = await run(t.handler, req({ test_push: true }, { authorization: "Bearer viewer-jwt" }));
  assert.equal(rt.status, 200);
  assert.deepEqual(rt.json.push, { sent: 1, failed: 0, gone: 0 });
  assert.deepEqual(t.f.log.map((x) => x.url), ["https://push.example.test/mio"]);
  const msg = await decryptPush(mine, t.f.log[0].body);
  assert.match(msg.title, /^PRUEBA/);
  assert.equal((await t.handler(req({ test_push: true }, { authorization: "Bearer device-jwt" }))).status, 401);
  const sin = mk({ webhook: undefined, dbo: { chan: { vapidPublic: v.publicKey, vapidPrivate: v.privateJwk }, subs: [] } });
  assert.equal((await sin.handler(req({ test_push: true }, { authorization: "Bearer viewer-jwt" }))).status, 409);
});

test("encryptPush: dos cifrados del mismo texto difieren (sal y clave efimera nuevas)", async () => {
  const b = await fakeBrowser();
  const a = await encryptPush(b.sub, new TextEncoder().encode("hola"));
  const c = await encryptPush(b.sub, new TextEncoder().encode("hola"));
  assert.notDeepEqual(a, c);
  assert.deepEqual(JSON.parse(JSON.stringify(await decryptPush(b, new TextEncoder().encode("x")).catch(() => "err"))), "err");
});

test("severidad alta: no le llega a quien pidio solo criticas; media solo a quien lo pidio", async () => {
  const inact = mk({ dbo: { event: ev({ type: "inactive", lat: null, lng: null, payload: { still_s: 300 } }) } });
  await inact.handler(req({ event_id: EID, kind: "inmediato" }));
  assert.deepEqual(sentTo(inact.f, "hooks.example"), ["alta@ejemplo.com", "media@ejemplo.com"]);
  assert.match(inact.f.log[0].body.text, /sin ubicación disponible/);
  const media = mk({ dbo: { event: ev({ type: "geofence", payload: { kind: "restringida", action: "enter", zone_name: "Pileta <b>x</b>" } }) } });
  await media.handler(req({ event_id: EID, kind: "inmediato" }));
  assert.deepEqual(sentTo(media.f, "hooks.example"), ["media@ejemplo.com"]);
  assert.ok(!/<b>x/.test(media.f.log[0].body.html), "el nombre de zona no inyecta HTML");
});

test("recordatorio: solo si NO esta atendida; un error de lectura no cuenta como atendida", async () => {
  const atendida = mk({ dbo: { acked: true } });
  const r1 = await run(atendida.handler, req({ event_id: EID, kind: "recordatorio" }));
  assert.equal(r1.json.skipped, "atendida");
  assert.equal(atendida.f.log.length, 0);
  assert.equal(atendida.db.calls.claim.length, 0);

  const sin = mk();
  const r2 = await run(sin.handler, req({ event_id: EID, kind: "recordatorio" }));
  assert.equal(r2.status, 200);
  assert.match(sin.f.log[0].body.subject, /^RECORDATORIO, sin atender hace 3 min: SOS/);

  const roto = mk({ dbo: { ackedThrows: true } });
  assert.equal((await run(roto.handler, req({ event_id: EID, kind: "recordatorio" }))).status, 500);
  assert.equal(roto.f.log.length, 0, "ante la duda NO se asume atendida ni se manda");

  const media = mk({ dbo: { event: ev({ type: "not_worn" }) } });
  assert.equal((await run(media.handler, req({ event_id: EID, kind: "recordatorio" }))).json.skipped, "severidad_baja");
});

test("sin canal configurado ni push: 503 y el fallo queda registrado", async () => {
  const { handler, db, f } = mk({ webhook: undefined });
  const r = await run(handler, req({ event_id: EID, kind: "inmediato" }));
  assert.equal(r.status, 503);
  assert.equal(r.json.error, "canal_no_configurado");
  assert.equal(f.log.length, 0);
  assert.equal(db.calls.finish[0].ok, false);
  assert.equal(db.calls.finish[0].detail, "sin_canal");
  assert.equal((await run(mk({ webhook: undefined }).handler, req({ test: true }))).status, 503);
});

test("respaldo Resend por entorno solo con clave y remitente; todos fallan = 502 sin filtrar secretos", async () => {
  const soloKey = mk({ webhook: undefined, resendKey: "re_x" });
  assert.equal((await run(soloKey.handler, req({ event_id: EID, kind: "inmediato" }))).status, 503);
  const r = mk({ webhook: undefined, resendKey: "re_test", from: "Avisos <avisos@ejemplo.com>" });
  assert.equal((await run(r.handler, req({ event_id: EID, kind: "inmediato" }))).status, 200);
  assert.equal(r.f.log[0].url, "https://api.resend.com/emails");
  assert.equal(r.f.log[0].body.from, "Avisos <avisos@ejemplo.com>");
  const todo = mk({ resendKey: "re_test", from: "avisos@ejemplo.com", plan: { webhook: 500, resend: 401 } });
  const x = await run(todo.handler, req({ event_id: EID, kind: "inmediato" }));
  assert.equal(x.status, 502);
  assert.match(todo.db.calls.finish[0].detail, /correo 3 fallo/);
  assert.ok(!/re_test|SECRETPATH/.test(x.text + JSON.stringify(todo.db.calls.finish[0])));
});

test("cooldown, desactivado, evento sin atencion, id invalido, inexistente y sin destinatarios", async () => {
  const cd = mk({ dbo: { recent: true } });
  assert.equal((await run(cd.handler, req({ event_id: EID, kind: "inmediato" }))).json.skipped, "cooldown");
  assert.equal(cd.f.log.length, 0);
  assert.equal(cd.db.calls.claim.length, 0);
  const off = mk({ dbo: { cfg: { enabled: false, remind_after_s: 180, cooldown_s: 300 } } });
  assert.equal((await run(off.handler, req({ event_id: EID, kind: "inmediato" }))).json.skipped, "desactivado");
  const foto = mk({ dbo: { event: ev({ type: "photo" }) } });
  assert.equal((await run(foto.handler, req({ event_id: EID, kind: "inmediato" }))).json.skipped, "no_requiere_atencion");
  assert.equal((await mk().handler(req({ event_id: "no-es-uuid", kind: "inmediato" }))).status, 400);
  assert.equal((await mk().handler(req({ event_id: EID, kind: "otro" }))).status, 400);
  assert.equal((await mk({ dbo: { event: null } }).handler(req({ event_id: EID, kind: "inmediato" }))).status, 404);
  const sinDest = mk({ dbo: { recipients: [] } });
  const r = await run(sinDest.handler, req({ event_id: EID, kind: "inmediato" }));
  assert.equal(r.json.skipped, "sin_destinatarios");
  assert.equal(sinDest.db.calls.finish[0].ok, true);
});

test("sin variables de entorno: clave y canal salen de la tabla", async () => {
  const chan = { secret: "clave-de-la-tabla-0123456789", webhookUrl: "https://hooks.example.test/desde-tabla" };
  const m = mk({ secret: "", webhook: undefined, dbo: { chan } });
  assert.equal((await m.handler(req({ event_id: EID, kind: "inmediato" }, { "x-notify-secret": "otra" }))).status, 401);
  const r = await run(m.handler, req({ event_id: EID, kind: "inmediato" }, { "x-notify-secret": chan.secret }));
  assert.equal(r.status, 200);
  assert.equal(m.f.log[0].url, "https://hooks.example.test/desde-tabla");
  assert.ok(!r.text.includes("desde-tabla") && !r.text.includes(chan.secret));
  const http = mk({ dbo: { chan: { webhookUrl: "http://inseguro.example.test/x" } } });
  await http.handler(req({ event_id: EID, kind: "inmediato" }));
  assert.equal(new URL(http.f.log[0].url).host, "hooks.example.test");
});

test("prueba de correo con JWT de admin: por proveedor a cada activo; viewer/anonimo no", async () => {
  const { handler, f } = mk({ webhook: undefined, dbo: { chan: BREVO } });
  const r = await run(handler, req({ test: true }, { authorization: "Bearer admin-jwt" }));
  assert.equal(r.status, 200);
  assert.equal(r.json.test, true);
  assert.equal(r.json.recipients, 3);
  assert.equal(r.json.channel, "brevo");
  assert.equal(f.log.length, 3);
  assert.match(f.log[0].body.subject, /^PRUEBA/);
  assert.equal((await handler(req({ test: true }, { authorization: "Bearer viewer-jwt" }))).status, 403);
  assert.equal((await handler(req({ test: true }, { authorization: "Bearer basura" }))).status, 401);
  assert.equal((await handler(req({ test: true }, {}))).status, 401);
  assert.equal((await handler(req({ event_id: EID, kind: "inmediato" }, { authorization: "Bearer admin-jwt" }))).status, 403);
  const vacio = mk({ dbo: { recipients: [], chan: BREVO } });
  assert.equal((await vacio.handler(req({ test: true }, { authorization: "Bearer admin-jwt" }))).status, 409);
});

test("helpers: severidad (igual que sevOf/notify_severity), hora AR, mapa, payload push", () => {
  assert.equal(severity("sos", null), 3);
  assert.equal(severity("inactive", {}), 2);
  assert.equal(severity("not_worn", {}), 1);
  assert.equal(severity("geofence", { kind: "peligro", action: "enter" }), 2);
  assert.equal(severity("geofence", { kind: "peligro", action: "exit" }), 0);
  assert.equal(severity("geofence", { kind: "restringida", action: "enter" }), 1);
  assert.equal(severity("photo", null), 0);
  assert.equal(fmtAR(Date.parse("2026-03-19T02:30:00Z")), "18/03/2026 23:30");
  assert.equal(mapUrl(95, 0), null);
  const m = buildMail(ev({ lat: null, lng: null }), 3, "inmediato", NOW, null, "https://v.example.test/");
  assert.match(m.text, /Casco: 4132\n/);
  const p = buildPush(ev({ type: "geofence", payload: { kind: "peligro", action: "enter", zone_name: "Pileta" } }), 2, "recordatorio", NOW, "https://v.example.test/");
  assert.match(p.title, /^SIN ATENDER: Zona de peligro/);
  assert.ok(!p.body.includes("Pileta"));
});
