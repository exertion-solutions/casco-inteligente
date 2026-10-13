// Tests de la Edge Function notify con base y fetch simulados (sin red, sin Supabase).
// Uso (Node >= 22.18, que ejecuta .ts directamente):  node --test supabase/functions/notify/test.mjs
// Con Deno:  deno test --allow-env --allow-net supabase/functions/notify/test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { buildMail, fmtAR, makeHandler, mapUrl, severity } from "./index.ts";

const SECRET = "secreto-de-prueba-123";
const EID = "11111111-1111-1111-1111-111111111111";
const NOW = Date.parse("2026-10-13T17:08:00Z"); // 14:08 en Argentina
const ev = (o = {}) => ({
  id: EID, created_at: "2026-10-13T17:05:00Z", device_id: "4132", type: "sos", lat: -34.6, lng: -58.4, payload: {}, ...o,
});

function fakeDb(o = {}) {
  const calls = { claim: [], finish: [] };
  const db = {
    calls,
    channel: async () => o.chan ?? { secret: null, webhookUrl: null, resendFrom: null },
    config: async () => o.cfg === undefined ? { enabled: true, remind_after_s: 180, cooldown_s: 300 } : o.cfg,
    recipients: async () => o.recipients ?? [
      { email: "critico@ejemplo.com", min_severity: "critica" },
      { email: "alta@ejemplo.com", min_severity: "alta" },
      { email: "media@ejemplo.com", min_severity: "media" },
    ],
    event: async (id) => (o.event === undefined ? ev() : o.event)?.id === id || o.anyId ? (o.event ?? ev()) : null,
    acked: async () => { if (o.ackedThrows) throw new Error("db"); return o.acked === true; },
    deviceName: async () => o.name ?? "Casco Perforación",
    claim: async (id, kind) => { calls.claim.push([id, kind]); return o.claim !== false; },
    finish: async (id, kind, ok, channel, n, detail) => { calls.finish.push({ id, kind, ok, channel, n, detail }); },
    recentOk: async () => o.recent === true,
  };
  return db;
}

function fakeFetch(plan = {}) {
  const log = [];
  const f = async (url, init) => {
    log.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    const status = String(url).includes("api.resend.com") ? (plan.resend ?? 200) : (plan.webhook ?? 200);
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
    getUser: async (jwt) => jwt === "admin-jwt" ? { app_metadata: { role: "admin" } } : jwt === "viewer-jwt" ? { app_metadata: { role: "viewer" } } : null,
  });
  return { handler, db, f };
}
const run = async (h, r) => { const res = await h(r); const t = await res.text(); return { status: res.status, text: t, json: t ? JSON.parse(t) : null }; };

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

test("inmediato: arma el correo en espanol, hora Argentina, mapa y enlace; filtra por min_severity", async () => {
  const { handler, db, f } = mk();
  const r = await run(handler, req({ event_id: EID, kind: "inmediato" }));
  assert.equal(r.status, 200);
  assert.equal(r.json.sent, 3);
  const b = f.log[0].body;
  assert.deepEqual(b.to.sort(), ["alta@ejemplo.com", "critico@ejemplo.com", "media@ejemplo.com"]);
  assert.equal(b.severity, "critica");
  assert.equal(b.event_id, EID);
  assert.match(b.subject, /ALERTA CRÍTICA: SOS .* - casco 4132/);
  assert.match(b.text, /Casco: 4132 \(Casco Perforación\)/);
  assert.match(b.text, /Hora: 13\/10\/2026 14:05 \(hora de Argentina\)/);
  assert.match(b.text, /Hace: 3 min/);
  assert.match(b.text, /https:\/\/www\.google\.com\/maps\?q=-34\.600000,-58\.400000/);
  assert.match(b.text, /https:\/\/exertion-solutions\.github\.io\/casco-inteligente\//);
  assert.match(b.html, /<a href="https:\/\/exertion-solutions\.github\.io\/casco-inteligente\/"/);
  assert.deepEqual(db.calls.claim, [[EID, "inmediato"]]);
  assert.equal(db.calls.finish[0].ok, true);
  assert.equal(db.calls.finish[0].channel, "webhook");
  // la respuesta no filtra correos ni la URL del webhook
  assert.ok(!/ejemplo\.com|hooks\.example|SECRETPATH/.test(r.text));
});

test("severidad alta: no le llega a quien pidio solo criticas; media solo a quien lo pidio", async () => {
  const inact = mk({ dbo: { event: ev({ type: "inactive", lat: null, lng: null, payload: { still_s: 300 } }) } });
  await inact.handler(req({ event_id: EID, kind: "inmediato" }));
  assert.deepEqual(inact.f.log[0].body.to.sort(), ["alta@ejemplo.com", "media@ejemplo.com"]);
  assert.match(inact.f.log[0].body.text, /sin ubicación disponible/);
  const media = mk({ dbo: { event: ev({ type: "geofence", payload: { kind: "restringida", action: "enter", zone_name: "Pileta <b>x</b>" } }) } });
  await media.handler(req({ event_id: EID, kind: "inmediato" }));
  assert.deepEqual(media.f.log[0].body.to, ["media@ejemplo.com"]);
  assert.ok(!/<b>x/.test(media.f.log[0].body.html), "el nombre de zona no inyecta HTML");
});

test("idempotencia: si el claim ya estaba tomado no se manda nada", async () => {
  const { handler, f } = mk({ dbo: { claim: false } });
  const r = await run(handler, req({ event_id: EID, kind: "inmediato" }));
  assert.equal(r.status, 200);
  assert.equal(r.json.skipped, "ya_enviado_o_en_curso");
  assert.equal(f.log.length, 0);
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
  assert.match(sin.f.log[0].body.text, /SIN ATENDER/);

  const roto = mk({ dbo: { ackedThrows: true } });
  const r3 = await run(roto.handler, req({ event_id: EID, kind: "recordatorio" }));
  assert.equal(r3.status, 500);
  assert.equal(roto.f.log.length, 0, "ante la duda NO se asume atendida ni se manda");

  const media = mk({ dbo: { event: ev({ type: "not_worn" }) } });
  assert.equal((await run(media.handler, req({ event_id: EID, kind: "recordatorio" }))).json.skipped, "severidad_baja");
});

test("sin canal configurado: 503 y el fallo queda registrado", async () => {
  const { handler, db, f } = mk({ webhook: undefined });
  const r = await run(handler, req({ event_id: EID, kind: "inmediato" }));
  assert.equal(r.status, 503);
  assert.equal(r.json.error, "canal_no_configurado");
  assert.equal(f.log.length, 0);
  assert.equal(db.calls.finish[0].ok, false);
  assert.equal(db.calls.finish[0].detail, "sin_canal");
  // la prueba tambien responde 503
  const t = await run(mk({ webhook: undefined }).handler, req({ test: true }));
  assert.equal(t.status, 503);
});

test("canal b (Resend) solo con RESEND_API_KEY y NOTIFY_FROM; respaldo si el webhook falla", async () => {
  const soloKey = mk({ webhook: undefined, resendKey: "re_x" }); // sin NOTIFY_FROM: no cuenta como canal
  assert.equal((await run(soloKey.handler, req({ event_id: EID, kind: "inmediato" }))).status, 503);

  const r = mk({ webhook: undefined, resendKey: "re_test", from: "Avisos <avisos@ejemplo.com>" });
  const ok = await run(r.handler, req({ event_id: EID, kind: "inmediato" }));
  assert.equal(ok.status, 200);
  assert.equal(r.f.log[0].url, "https://api.resend.com/emails");
  assert.equal(r.f.log[0].headers.authorization, "Bearer re_test");
  assert.equal(r.f.log[0].body.from, "Avisos <avisos@ejemplo.com>");
  assert.equal(r.f.log[0].body.to.length, 3);
  assert.equal(r.db.calls.finish[0].channel, "resend");

  const resp = mk({ resendKey: "re_test", from: "avisos@ejemplo.com", plan: { webhook: 500 } });
  const fb = await run(resp.handler, req({ event_id: EID, kind: "inmediato" }));
  assert.equal(fb.status, 200);
  assert.deepEqual(resp.f.log.map((x) => new URL(x.url).host), ["hooks.example.test", "api.resend.com"]);
  assert.equal(fb.json.channel, "resend");
});

test("todos los canales fallan: 502, error registrado y sin filtrar secretos", async () => {
  const { handler, db } = mk({ resendKey: "re_test", from: "avisos@ejemplo.com", plan: { webhook: 500, resend: 401 } });
  const r = await run(handler, req({ event_id: EID, kind: "inmediato" }));
  assert.equal(r.status, 502);
  assert.equal(db.calls.finish[0].ok, false);
  assert.match(db.calls.finish[0].detail, /webhook HTTP 500; resend HTTP 401/);
  assert.ok(!/re_test|SECRETPATH|ejemplo\.com/.test(r.text + db.calls.finish[0].detail));
});

test("cooldown, desactivado, evento sin atencion, id invalido y evento inexistente", async () => {
  const cd = mk({ dbo: { recent: true } });
  assert.equal((await run(cd.handler, req({ event_id: EID, kind: "inmediato" }))).json.skipped, "cooldown");
  assert.equal(cd.f.log.length, 0);
  assert.equal(cd.db.calls.claim.length, 0);

  const off = mk({ dbo: { cfg: { enabled: false, remind_after_s: 180, cooldown_s: 300 } } });
  assert.equal((await run(off.handler, req({ event_id: EID, kind: "inmediato" }))).json.skipped, "desactivado");
  assert.equal(off.f.log.length, 0);

  const foto = mk({ dbo: { event: ev({ type: "photo" }) } });
  assert.equal((await run(foto.handler, req({ event_id: EID, kind: "inmediato" }))).json.skipped, "no_requiere_atencion");

  assert.equal((await mk().handler(req({ event_id: "no-es-uuid", kind: "inmediato" }))).status, 400);
  assert.equal((await mk().handler(req({ event_id: EID, kind: "otro" }))).status, 400);
  const nf = mk({ dbo: { event: null } });
  assert.equal((await nf.handler(req({ event_id: EID, kind: "inmediato" }))).status, 404);

  const sinDest = mk({ dbo: { recipients: [] } });
  const r = await run(sinDest.handler, req({ event_id: EID, kind: "inmediato" }));
  assert.equal(r.json.skipped, "sin_destinatarios");
  assert.equal(sinDest.db.calls.finish[0].ok, true); // queda registrado para que el cron no insista
});

test("prueba con JWT de admin: manda a todos los activos; viewer o anonimo no", async () => {
  const { handler, f } = mk();
  const r = await run(handler, req({ test: true }, { authorization: "Bearer admin-jwt" }));
  assert.equal(r.status, 200);
  assert.equal(r.json.test, true);
  assert.equal(r.json.recipients, 3);
  assert.match(f.log[0].body.subject, /^PRUEBA/);
  assert.equal(f.log[0].body.event_id, null);
  assert.equal((await handler(req({ test: true }, { authorization: "Bearer viewer-jwt" }))).status, 401);
  assert.equal((await handler(req({ test: true }, { authorization: "Bearer basura" }))).status, 401);
  assert.equal((await handler(req({ test: true }, {}))).status, 401);
  // el admin no puede disparar avisos reales con su JWT
  assert.equal((await handler(req({ event_id: EID, kind: "inmediato" }, { authorization: "Bearer admin-jwt" }))).status, 403);
  // sin destinatarios: 409 claro
  const vacio = mk({ dbo: { recipients: [] } });
  assert.equal((await vacio.handler(req({ test: true }, { authorization: "Bearer admin-jwt" }))).status, 409);
});

test("helpers: severidad (igual que sevOf/notify_severity), hora AR, mapa", () => {
  assert.equal(severity("sos", null), 3);
  assert.equal(severity("fall", {}), 3);
  assert.equal(severity("inactive", {}), 2);
  assert.equal(severity("not_worn", {}), 1);
  assert.equal(severity("geofence", { kind: "peligro", action: "enter" }), 2);
  assert.equal(severity("geofence", { kind: "peligro", action: "exit" }), 0);
  assert.equal(severity("geofence", { kind: "restringida", action: "enter" }), 1);
  assert.equal(severity("geofence", { kind: "permitida", action: "exit" }), 1);
  assert.equal(severity("photo", null), 0);
  assert.equal(fmtAR(Date.parse("2026-03-19T02:30:00Z")), "18/03/2026 23:30"); // no se corre al 19
  assert.equal(mapUrl(95, 0), null);
  assert.equal(mapUrl(null, 1), null);
  const m = buildMail(ev({ lat: null, lng: null }), 3, "inmediato", NOW, null, "https://v.example.test/");
  assert.match(m.text, /Casco: 4132\n/);
});

test("sin variables de entorno: clave y canal salen de la tabla (notify_config)", async () => {
  const chan = { secret: "clave-de-la-tabla-0123456789", webhookUrl: "https://hooks.example.test/desde-tabla", resendFrom: null };
  const m = mk({ secret: "", webhook: undefined, dbo: { chan } });
  const bad = await m.handler(req({ event_id: EID, kind: "inmediato" }, { "x-notify-secret": "otra" }));
  assert.equal(bad.status, 401);
  const r = await run(m.handler, req({ event_id: EID, kind: "inmediato" }, { "x-notify-secret": chan.secret }));
  assert.equal(r.status, 200);
  assert.equal(m.f.log[0].url, "https://hooks.example.test/desde-tabla");
  assert.ok(!r.text.includes("desde-tabla") && !r.text.includes(chan.secret));
  // la clave del entorno tambien vale; sin clave en tabla ni entorno, 401
  const env = mk({ dbo: { chan } });
  assert.equal((await env.handler(req({ event_id: EID, kind: "inmediato" }))).status, 200);
  const nada = mk({ secret: "", webhook: undefined });
  assert.equal((await nada.handler(req({ event_id: EID, kind: "inmediato" }, { "x-notify-secret": "x" }))).status, 401);
  // una URL de la tabla que no es https se ignora y se usa el entorno
  const http = mk({ dbo: { chan: { ...chan, webhookUrl: "http://inseguro.example.test/x" } } });
  await http.handler(req({ event_id: EID, kind: "inmediato" }));
  assert.equal(new URL(http.f.log[0].url).host, "hooks.example.test");
  assert.equal(http.f.log[0].url.includes("inseguro"), false);
});

test("remitente de Resend desde la tabla (resend_from) con la clave solo del entorno", async () => {
  const chan = { secret: null, webhookUrl: null, resendFrom: "Avisos <avisos@ejemplo.com>" };
  const r = mk({ webhook: undefined, resendKey: "re_test", dbo: { chan } });
  const ok = await run(r.handler, req({ event_id: EID, kind: "inmediato" }));
  assert.equal(ok.status, 200);
  assert.equal(r.f.log[0].body.from, "Avisos <avisos@ejemplo.com>");
  const sinKey = mk({ webhook: undefined, dbo: { chan } });
  assert.equal((await sinKey.handler(req({ event_id: EID, kind: "inmediato" }))).status, 503);
});
