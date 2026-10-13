// Edge Function notify (Supabase, Deno). Ver docs/PROTOCOLO-AVISOS.md.
// Avisa de una alerta (SOS, caida, zona, sin movimiento) por PUSH del navegador (Web Push, VAPID) y por CORREO
// (proveedor HTTP Brevo o Resend, un envio por destinatario; webhook generico como respaldo), y repite una vez como
// recordatorio si nadie la atiende. La llaman: (a) el trigger de events por pg_net (inmediato) y (b) pg_cron cada
// minuto (recordatorio / reintento), ambos con la cabecera x-notify-secret; y (c) un usuario del visor con su JWT:
// admin {"test":true} (correo de prueba) y {"bootstrap_push":true} (genera el par VAPID); cualquier viewer/admin/auditor
// {"test_push":true} (prueba a SUS dispositivos). Un solo archivo para pegarlo en el dashboard; sin dependencias externas
// (supabase-js se importa solo cuando corre en Deno; el cifrado Web Push usa WebCrypto, sin npm:web-push).
//
// SIN variables obligatorias: clave, canal, proveedor de correo y VAPID se leen/guardan en notify_config con service_role.
// Env (todas opcionales; SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY las inyecta Supabase, NUNCA van al repo):
//      NOTIFY_SECRET        (tambien vale como x-notify-secret, ademas de notify_config.webhook_secret),
//      NOTIFY_WEBHOOK_URL   (webhook de respaldo si la tabla no tiene webhook_url),
//      RESEND_API_KEY       (Resend por entorno si no hay proveedor en la tabla; remitente notify_config.resend_from o NOTIFY_FROM),
//      NOTIFY_VIEWER_URL    (enlace al visor; por defecto el de GitHub Pages).
//
// Respuestas: 200 {ok, sent, ...} | 400 | 401 | 403 | 404 | 405 | 409 | 502 (todos los canales rechazaron el envio) |
//             503 {error:"canal_no_configurado"} | 500. Nunca devuelve ni registra claves ni URLs; el payload push no lleva
//             coordenadas ni nombres de personas.

export type Kind = "inmediato" | "recordatorio";
export type SevName = "critica" | "alta" | "media";
export interface Cfg {
  enabled: boolean;
  remind_after_s: number;
  cooldown_s: number;
}
export interface Recipient {
  email: string;
  min_severity: SevName;
}
export interface Ev {
  id: string;
  created_at: string;
  device_id: string;
  type: string;
  lat: number | null;
  lng: number | null;
  payload: Record<string, unknown> | null;
}
export interface Channel {
  secret: string | null;
  webhookUrl: string | null;
  resendFrom: string | null;
  emailProvider: "brevo" | "resend" | null;
  emailApiKey: string | null;
  emailFrom: string | null;
  emailFromName: string | null;
  vapidPublic: string | null;
  /** JWK (JSON) de la clave privada ECDSA P-256. */
  vapidPrivate: string | null;
}
export interface Sub {
  endpoint: string;
  p256dh: string;
  auth: string;
  min_severity: SevName;
}
/** Resultado por destinatario guardado en notify_log.results. */
export type Results = Record<string, { ok?: boolean; ch?: string; d?: string; sent?: number; failed?: number; gone?: number }>;
export interface Db {
  channel(): Promise<Channel>;
  config(): Promise<Cfg | null>;
  /** Solo destinatarios activos. */
  recipients(): Promise<Recipient[]>;
  /** Suscripciones push; con userId solo las de ese usuario. */
  subscriptions(userId?: string): Promise<Sub[]>;
  deleteSub(endpoint: string): Promise<void>;
  saveVapid(publicKey: string, privateJwk: string): Promise<void>;
  event(id: string): Promise<Ev | null>;
  /** true solo si existe la fila en event_acks. Un error de base NO es "atendida": lanza. */
  acked(id: string): Promise<boolean>;
  deviceName(deviceId: string): Promise<string | null>;
  /** Reserva atomica (evento, kind). false = ya enviado o lo tiene otro proceso. */
  claim(eventId: string, kind: Kind): Promise<boolean>;
  /** Resultados por destinatario de un intento anterior (para no repetir a quien ya recibio). */
  results(eventId: string, kind: Kind): Promise<Results>;
  finish(eventId: string, kind: Kind, ok: boolean, channel: string, recipients: number, detail: string, results: Results): Promise<void>;
  /** Hubo un aviso ok del mismo kind para este casco desde sinceIso (otro evento)? */
  recentOk(deviceId: string, kind: Kind, sinceIso: string, exceptEventId: string): Promise<boolean>;
}
export interface Deps {
  db: Db;
  secret?: string;
  getUser?: (jwt: string) => Promise<{ id?: string; app_metadata?: Record<string, unknown> } | null>;
  webhookUrl?: string;
  resendKey?: string;
  from?: string;
  viewerUrl?: string;
  fetch?: typeof fetch;
  now?: () => number; // ms
}

export const DEFAULT_VIEWER_URL = "https://exertion-solutions.github.io/casco-inteligente/";
const TIMEOUT_MS = 8_000;
const MAX_TO = 50;
const RANK: Record<SevName, number> = { critica: 3, alta: 2, media: 1 };
const SEV_NAME: Record<number, SevName> = { 3: "critica", 2: "alta", 1: "media" };
const SEV_LABEL: Record<number, string> = { 3: "CRÍTICA", 2: "ALTA", 1: "MEDIA" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info, x-notify-secret",
  "access-control-allow-methods": "POST, OPTIONS",
};

const enc = new TextEncoder();

// Comparacion en tiempo constante: se comparan hashes SHA-256 (longitud fija).
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });

// Texto que viene del casco (payload, nombre): solo letras, numeros y signos simples.
function clean(v: unknown, max = 60): string {
  const s = typeof v === "string" ? v : "";
  return s.replace(/[^\p{L}\p{N} .,_-]/gu, "").trim().slice(0, max);
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Misma tabla que sevOf de web/app.js y notify_severity() de la migracion 014. 0 = no requiere atencion. */
export function severity(type: string, payload: Record<string, unknown> | null): number {
  if (type === "sos" || type === "fall") return 3;
  if (type === "inactive") return 2;
  if (type === "not_worn") return 1;
  if (type === "geofence") {
    const k = payload?.kind, a = payload?.action;
    if (k === "peligro" && a === "enter") return 2;
    if (k === "restringida" && a === "enter") return 1;
    if (k === "permitida" && a === "exit") return 1;
  }
  return 0;
}

export function reasonOf(e: Ev): string {
  const zone = clean(e.payload?.zone_name) || "sin nombre";
  switch (e.type) {
    case "sos": return "SOS (botón de emergencia)";
    case "fall": return "Caída / hombre caído";
    case "inactive": return "Sin movimiento";
    case "not_worn": return "Casco sin usar";
    case "geofence":
      if (e.payload?.kind === "peligro") return `Ingresó a una zona de peligro: ${zone}`;
      if (e.payload?.kind === "restringida") return `Ingresó a una zona restringida: ${zone}`;
      return `Salió de una zona permitida: ${zone}`;
    default: return e.type;
  }
}

export function mapUrl(lat: unknown, lng: unknown): string | null {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return `https://www.google.com/maps?q=${lat.toFixed(6)},${lng.toFixed(6)}`;
}

/** Hora de Argentina (UTC-3, sin horario de verano) dd/mm/yyyy HH:MM, calculada explicitamente. */
export function fmtAR(ms: number): string {
  const d = new Date(ms - 3 * 3600_000), p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export function fmtAge(s: number): string {
  if (s < 90) return `${Math.max(0, s)} s`;
  const m = Math.floor(s / 60);
  return m < 90 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export interface Mail {
  subject: string;
  text: string;
  html: string;
}

export function buildMail(
  e: Ev, sev: number, kind: Kind, nowMs: number, deviceName: string | null, viewerUrl: string,
): Mail {
  const device = clean(e.device_id, 64);
  const name = clean(deviceName, 80);
  const casco = name ? `${device} (${name})` : device;
  const reason = reasonOf(e);
  const ageS = Math.floor((nowMs - Date.parse(e.created_at)) / 1000);
  const map = mapUrl(e.lat, e.lng);
  const sevL = SEV_LABEL[sev] ?? "";
  const subject = kind === "recordatorio"
    ? `RECORDATORIO, sin atender hace ${fmtAge(ageS)}: ${reason} - casco ${device}`
    : `ALERTA ${sevL}: ${reason} - casco ${device}`;
  const head = kind === "recordatorio"
    ? "RECORDATORIO: esta alerta sigue SIN ATENDER."
    : `ALERTA ${sevL}: hay una alerta en el casco ${device}.`;
  const lines: [string, string][] = [
    ["Qué pasó", reason],
    ["Casco", casco],
    ["Hora", `${fmtAR(Date.parse(e.created_at))} (hora de Argentina)`],
    ["Hace", fmtAge(ageS)],
    ["Ubicación", map ?? "sin ubicación disponible"],
  ];
  const foot = kind === "recordatorio"
    ? "Entrá al visor y tocá «Atender» para que dejen de llegar avisos."
    : "Entrá al visor y tocá «Atender». Si nadie la atiende, se manda un recordatorio.";
  const text = [head, "", ...lines.map(([k, v]) => `${k}: ${v}`), "", foot, viewerUrl].join("\n");
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px">` +
    `<p style="font-size:18px;font-weight:bold;color:#b00020;margin:0 0 12px">${esc(head)}</p>` +
    `<table style="border-collapse:collapse">` +
    lines.map(([k, v]) =>
      `<tr><td style="padding:4px 12px 4px 0;color:#555">${esc(k)}</td><td style="padding:4px 0"><b>` +
      (k === "Ubicación" && map ? `<a href="${esc(map)}">Ver en el mapa</a>` : esc(v)) + `</b></td></tr>`
    ).join("") +
    `</table><p style="margin:16px 0">${esc(foot)}</p>` +
    `<p><a href="${esc(viewerUrl)}" style="background:#b00020;color:#fff;padding:10px 16px;text-decoration:none;border-radius:6px">Abrir el visor</a></p>` +
    `</div>`;
  return { subject, text, html };
}

export function testMail(viewerUrl: string): Mail {
  const text = "Este es un correo de prueba de los avisos de Casco Inteligente.\n" +
    "Si te llegó, el canal de correo funciona. No hay ninguna alerta.\n" + viewerUrl;
  return {
    subject: "PRUEBA - Avisos por correo de Casco Inteligente",
    text,
    html: `<div style="font-family:Arial,sans-serif"><p><b>Correo de prueba</b> de los avisos de Casco Inteligente.</p>` +
      `<p>Si te llegó, el canal de correo funciona. No hay ninguna alerta.</p><p><a href="${esc(viewerUrl)}">Abrir el visor</a></p></div>`,
  };
}

/** Payload push minimo: casco, tipo, hora Argentina y enlace. Sin coordenadas ni nombres de personas. */
export interface PushMsg {
  title: string;
  body: string;
  url: string;
  severity: string;
  tag: string;
}
export function buildPush(e: Ev, sev: number, kind: Kind, nowMs: number, viewerUrl: string): PushMsg {
  const device = clean(e.device_id, 64);
  const ageS = Math.floor((nowMs - Date.parse(e.created_at)) / 1000);
  const what = e.type === "geofence" ? (e.payload?.kind === "peligro" ? "Zona de peligro" : e.payload?.kind === "restringida" ? "Zona restringida" : "Salió de zona permitida")
    : e.type === "sos" ? "SOS" : e.type === "fall" ? "Caída" : e.type === "inactive" ? "Sin movimiento" : e.type === "not_worn" ? "Casco sin usar" : e.type;
  const title = kind === "recordatorio" ? `SIN ATENDER: ${what}` : `ALERTA ${SEV_LABEL[sev] ?? ""}: ${what}`;
  const body = `Casco ${device} · ${fmtAR(Date.parse(e.created_at))} (Argentina)` + (kind === "recordatorio" ? ` · hace ${fmtAge(ageS)}` : "");
  return { title, body, url: viewerUrl, severity: SEV_NAME[sev] ?? "media", tag: e.id };
}

function httpsUrl(u: string | null | undefined): string | undefined {
  if (!u) return undefined;
  try {
    return new URL(u).protocol === "https:" ? u : undefined;
  } catch {
    return undefined;
  }
}

// ---- Web Push (RFC 8030 / 8291 aes128gcm / 8292 VAPID) con WebCrypto ----------------------------------------
export const b64u = (b: Uint8Array): string => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const unb64u = (s: string): Uint8Array => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const r = atob(t);
  const o = new Uint8Array(r.length);
  for (let i = 0; i < r.length; i++) o[i] = r.charCodeAt(i);
  return o;
};
const cat = (...p: Uint8Array[]): Uint8Array => {
  const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let k = 0;
  for (const x of p) {
    o.set(x, k);
    k += x.length;
  }
  return o;
};
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}

/** Genera el par VAPID: publica = punto sin comprimir (65 bytes) en base64url; privada = JWK en JSON. */
export async function generateVapid(): Promise<{ publicKey: string; privateJwk: string }> {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { publicKey: b64u(raw), privateJwk: JSON.stringify(jwk) };
}

async function vapidHeader(endpoint: string, publicKey: string, privateJwk: string, subject: string, nowMs: number): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", JSON.parse(privateJwk), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(nowMs / 1000) + 12 * 3600,
    sub: subject,
  })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${claims}`)));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${publicKey}`;
}

/** Cifra el payload para una suscripcion (RFC 8291, un solo registro). Devuelve el cuerpo aes128gcm. */
export async function encryptPush(sub: { p256dh: string; auth: string }, plaintext: Uint8Array): Promise<Uint8Array> {
  const uaPublic = unb64u(sub.p256dh), authSecret = unb64u(sub.auth);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const zero = new Uint8Array([0]);
  const prk = await hkdf(authSecret, ecdh, cat(enc.encode("WebPush: info"), zero, uaPublic, asPublic), 32);
  const cek = await hkdf(salt, prk, cat(enc.encode("Content-Encoding: aes128gcm"), zero), 16);
  const nonce = await hkdf(salt, prk, cat(enc.encode("Content-Encoding: nonce"), zero), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, cat(plaintext, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 0x10, 0]); // 4096
  return cat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

type PushOutcome = "ok" | "gone" | "fail";
async function sendPush(
  f: typeof fetch, ch: Channel, sub: Sub, msg: PushMsg, subject: string, nowMs: number, urgent: boolean,
): Promise<PushOutcome> {
  try {
    const endpoint = httpsUrl(sub.endpoint);
    if (!endpoint || !ch.vapidPublic || !ch.vapidPrivate) return "fail";
    const body = await encryptPush(sub, enc.encode(JSON.stringify(msg)));
    const r = await f(endpoint, {
      method: "POST",
      headers: {
        authorization: await vapidHeader(endpoint, ch.vapidPublic, ch.vapidPrivate, subject, nowMs),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: urgent ? "86400" : "3600",
        urgency: urgent ? "high" : "normal",
        topic: msg.tag.replace(/[^A-Za-z0-9]/g, "").slice(0, 32),
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "manual",
    });
    await r.body?.cancel();
    if (r.ok) return "ok";
    return r.status === 404 || r.status === 410 ? "gone" : "fail";
  } catch {
    return "fail";
  }
}

// ---- Correo por proveedor HTTP / webhook ----------------------------------------------------------------------
interface SendResult {
  ok: boolean;
  channel: string;
  detail: string;
}

async function post(f: typeof fetch, url: string, headers: Record<string, string>, body: unknown): Promise<string> {
  try {
    const r = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "manual", // no seguir redirecciones a otro host
    });
    await r.body?.cancel();
    return r.ok ? "ok" : `HTTP ${r.status}`;
  } catch (e) {
    const n = (e as Error)?.name; // sin e.message: algunas implementaciones incluyen la URL
    return n === "TimeoutError" || n === "AbortError" ? "timeout" : "red";
  }
}

/** Entrega un correo a UN destinatario: proveedor (Brevo/Resend) -> webhook -> Resend por entorno. */
async function deliver(
  f: typeof fetch, ch: Channel, env: { webhook?: string; resendKey?: string; from?: string },
  to: string, mail: Mail, severityName: string, eventId: string | null,
): Promise<SendResult> {
  const fails: string[] = [];
  if (ch.emailProvider && ch.emailApiKey && ch.emailFrom) {
    let r: string;
    if (ch.emailProvider === "brevo") {
      r = await post(f, "https://api.brevo.com/v3/smtp/email", { "api-key": ch.emailApiKey, accept: "application/json" }, {
        sender: { email: ch.emailFrom, ...(ch.emailFromName ? { name: ch.emailFromName } : {}) },
        to: [{ email: to }],
        subject: mail.subject,
        htmlContent: mail.html,
        textContent: mail.text,
      });
    } else {
      r = await post(f, "https://api.resend.com/emails", { authorization: `Bearer ${ch.emailApiKey}` }, {
        from: ch.emailFromName ? `${ch.emailFromName} <${ch.emailFrom}>` : ch.emailFrom,
        to: [to], subject: mail.subject, html: mail.html, text: mail.text,
      });
    }
    if (r === "ok") return { ok: true, channel: ch.emailProvider, detail: "HTTP 2xx" };
    fails.push(`${ch.emailProvider} ${r}`);
  }
  if (env.webhook) {
    const r = await post(f, env.webhook, {}, {
      to: [to], subject: mail.subject, text: mail.text, html: mail.html, severity: severityName, event_id: eventId,
    });
    if (r === "ok") return { ok: true, channel: "webhook", detail: "HTTP 2xx" };
    fails.push(`webhook ${r}`);
  }
  if (!ch.emailProvider && env.resendKey && env.from) {
    const r = await post(f, "https://api.resend.com/emails", { authorization: `Bearer ${env.resendKey}` }, {
      from: env.from, to: [to], subject: mail.subject, html: mail.html, text: mail.text,
    });
    if (r === "ok") return { ok: true, channel: "resend", detail: "HTTP 2xx" };
    fails.push(`resend ${r}`);
  }
  return { ok: false, channel: "-", detail: fails.join("; ") || "sin_canal" };
}

export function makeHandler(deps: Deps) {
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const viewerUrl = httpsUrl(deps.viewerUrl) ?? DEFAULT_VIEWER_URL;

  return async (req: Request): Promise<Response> => {
    try {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (req.method !== "POST") return new Response(null, { status: 405 });

      // --- autenticacion: secreto compartido (pg_net / pg_cron) o JWT de usuario del visor ---
      // El secreto vale si coincide con el de la TABLA (notify_config.webhook_secret) o con NOTIFY_SECRET del entorno.
      let mode: "system" | "user" | null = null;
      let userId = "", role = "";
      let chan: Channel | null = null;
      const getChan = async () => (chan ??= await deps.db.channel());
      const given = req.headers.get("x-notify-secret");
      if (given !== null) {
        if (!given) return new Response(null, { status: 401 });
        const tbl = (await getChan()).secret;
        const okEnv = !!deps.secret && await safeEqual(given, deps.secret);
        const okTbl = !!tbl && await safeEqual(given, tbl);
        if (!okEnv && !okTbl) return new Response(null, { status: 401 });
        mode = "system";
      } else {
        const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
        if (jwt && jwt.length <= 4096 && deps.getUser) {
          const u = await deps.getUser(jwt);
          const r = String(u?.app_metadata?.role ?? "");
          if (u && u.id && ["admin", "viewer", "auditor"].includes(r)) {
            mode = "user";
            userId = u.id;
            role = r;
          }
        }
      }
      if (!mode) return new Response(null, { status: 401 });

      let body: Record<string, unknown> = {};
      try {
        const raw = await req.text();
        if (raw.length <= 2048 && raw.trim()) body = JSON.parse(raw) ?? {};
      } catch {
        return json(400, { ok: false, error: "cuerpo_ilegible" });
      }
      const c = await getChan();
      const env = {
        webhook: httpsUrl(c.webhookUrl) ?? httpsUrl(deps.webhookUrl),
        resendKey: deps.resendKey,
        from: c.resendFrom || deps.from,
      };
      const mailOk = !!((c.emailProvider && c.emailApiKey && c.emailFrom) || env.webhook || (env.resendKey && env.from));
      const nowMs = now();
      const pushReady = !!(c.vapidPublic && c.vapidPrivate);
      const subject = viewerUrl;

      // --- acciones del visor (JWT de usuario) ---
      if (body.bootstrap_push === true) {
        if (role !== "admin") return json(403, { ok: false, error: "solo_admin" });
        if (pushReady) return json(200, { ok: true, created: false });
        const v = await generateVapid();
        await deps.db.saveVapid(v.publicKey, v.privateJwk);
        return json(200, { ok: true, created: true });
      }
      if (body.test_push === true) {
        if (mode !== "user") return json(403, { ok: false, error: "solo_usuario" });
        if (!pushReady) return json(409, { ok: false, error: "push_no_habilitado" });
        const subs = await deps.db.subscriptions(userId);
        if (!subs.length) return json(409, { ok: false, error: "sin_dispositivos" });
        const msg: PushMsg = { title: "PRUEBA - Casco Inteligente", body: "Este es un aviso de prueba. No hay ninguna alerta.", url: viewerUrl, severity: "prueba", tag: "prueba" };
        let sent = 0, failed = 0, gone = 0;
        for (const s of subs) {
          const o = await sendPush(f, c, s, msg, subject, nowMs, false);
          if (o === "ok") sent++;
          else if (o === "gone") {
            gone++;
            await deps.db.deleteSub(s.endpoint);
          } else failed++;
        }
        return json(sent ? 200 : 502, { ok: sent > 0, test: true, push: { sent, failed, gone } });
      }
      if (body.test === true) {
        if (mode === "user" && role !== "admin") return json(403, { ok: false, error: "solo_admin" });
        if (!mailOk) return json(503, { ok: false, error: "canal_no_configurado" });
        const to = (await deps.db.recipients()).map((r) => r.email).slice(0, MAX_TO);
        if (!to.length) return json(409, { ok: false, error: "sin_destinatarios" });
        const mail = testMail(viewerUrl);
        const rs = await Promise.all(to.map((t) => deliver(f, c, env, t, mail, "prueba", null)));
        const okN = rs.filter((r) => r.ok).length;
        return json(okN ? 200 : 502, {
          ok: okN > 0, test: true, recipients: to.length, sent: okN, failed: to.length - okN,
          channel: rs.find((r) => r.ok)?.channel ?? "-", detail: okN ? "ok" : rs[0].detail,
        });
      }
      if (mode !== "system") return json(403, { ok: false, error: "solo_prueba" });

      // --- aviso real ---
      const eventId = String(body.event_id ?? "");
      const kind = body.kind as Kind;
      if (!UUID_RE.test(eventId) || (kind !== "inmediato" && kind !== "recordatorio")) {
        return json(400, { ok: false, error: "parametros" });
      }
      const cfg = await deps.db.config();
      if (!cfg || cfg.enabled !== true) return json(200, { ok: true, sent: 0, skipped: "desactivado" });
      const ev = await deps.db.event(eventId);
      if (!ev) return json(404, { ok: false, error: "evento_no_encontrado" });
      const sev = severity(ev.type, ev.payload);
      if (sev === 0) return json(200, { ok: true, sent: 0, skipped: "no_requiere_atencion" });
      if (kind === "recordatorio") {
        if (sev < 2) return json(200, { ok: true, sent: 0, skipped: "severidad_baja" });
        // Solo "atendida" si la fila existe en event_acks; un fallo de lectura lanza (500) y se reintenta.
        if (await deps.db.acked(ev.id)) return json(200, { ok: true, sent: 0, skipped: "atendida" });
      }
      if (cfg.cooldown_s > 0) {
        const since = new Date(nowMs - cfg.cooldown_s * 1000).toISOString();
        if (await deps.db.recentOk(ev.device_id, kind, since, ev.id)) {
          return json(200, { ok: true, sent: 0, skipped: "cooldown" });
        }
      }
      const to = (await deps.db.recipients()).filter((r) => RANK[r.min_severity] <= sev).map((r) => r.email).slice(0, MAX_TO);
      const subs = pushReady ? (await deps.db.subscriptions()).filter((s) => RANK[s.min_severity] <= sev) : [];

      if (!mailOk && !subs.length) {
        if (await deps.db.claim(ev.id, kind)) await deps.db.finish(ev.id, kind, false, "-", to.length, "sin_canal", {});
        return json(503, { ok: false, error: "canal_no_configurado" });
      }
      if (!(await deps.db.claim(ev.id, kind))) return json(200, { ok: true, sent: 0, skipped: "ya_enviado_o_en_curso" });

      const prev = await deps.db.results(ev.id, kind); // un reintento solo repite lo que fallo
      const results: Results = { ...prev };
      const mail = mailOk && to.length ? buildMail(ev, sev, kind, nowMs, await deps.db.deviceName(ev.device_id), viewerUrl) : null;
      const pending = mail ? to.filter((t) => prev[t]?.ok !== true) : [];
      const urgent = sev >= 2;

      const mailJob = Promise.all(pending.map(async (t) => {
        const r = await deliver(f, c, env, t, mail!, SEV_NAME[sev], ev.id);
        results[t] = { ok: r.ok, ch: r.channel, d: r.detail };
      }));
      let pushJob: Promise<void> = Promise.resolve();
      const prevPush = prev.push;
      if (subs.length && !(prevPush && (prevPush.sent ?? 0) > 0)) {
        const msg = buildPush(ev, sev, kind, nowMs, viewerUrl);
        pushJob = (async () => {
          let sent = 0, failed = 0, gone = 0;
          await Promise.all(subs.map(async (s) => {
            const o = await sendPush(f, c, s, msg, subject, nowMs, urgent);
            if (o === "ok") sent++;
            else if (o === "gone") {
              gone++;
              await deps.db.deleteSub(s.endpoint);
            } else failed++;
          }));
          results.push = { sent, failed, gone };
        })();
      }
      await Promise.all([mailJob, pushJob]);

      const mailFailed = pending.filter((t) => results[t]?.ok !== true);
      const pushFailedAll = !!results.push && (results.push.sent ?? 0) === 0 && (results.push.failed ?? 0) > 0;
      const allOk = mailFailed.length === 0 && !pushFailedAll;
      const sentMail = to.filter((t) => results[t]?.ok === true).length;
      const channels = [results.push?.sent ? "push" : "", ...new Set(to.map((t) => results[t]?.ch ?? "").filter((x) => x && x !== "-"))].filter(Boolean).join("+") || "-";
      const detail = allOk ? (to.length || subs.length ? "ok" : "sin_destinatarios")
        : [mailFailed.length ? `correo ${mailFailed.length} fallo(s): ${results[mailFailed[0]]?.d ?? ""}` : "", pushFailedAll ? "push fallo" : ""].filter(Boolean).join("; ");
      await deps.db.finish(ev.id, kind, allOk, channels, sentMail, detail, results);
      return json(allOk ? 200 : 502, {
        ok: allOk, kind, channel: channels, sent: sentMail, failed: mailFailed.length,
        push: results.push ?? null, ...(allOk && !to.length && !subs.length ? { skipped: "sin_destinatarios" } : {}),
      });
    } catch {
      return json(500, { ok: false, error: "interno" }); // sin detalles
    }
  };
}

// --- Acceso real a la base (service_role, inyectado por Supabase) --------------------------------
async function realDeps(): Promise<Pick<Deps, "db" | "getUser">> {
  const { createClient } = await import("npm:@supabase/supabase-js@2");
  const c = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  // deno-lint-ignore no-explicit-any
  const ok = <T>(r: { data: T | null; error: any }): T | null => {
    if (r.error) throw new Error("db");
    return r.data;
  };
  const db: Db = {
    async channel() {
      const r = ok(await c.from("notify_config")
        .select("webhook_secret,webhook_url,resend_from,email_provider,email_api_key,email_from,email_from_name,vapid_public,vapid_private")
        .eq("id", 1).maybeSingle()) as Record<string, string | null> | null;
      const g = (k: string) => r?.[k] ?? null;
      return {
        secret: g("webhook_secret"), webhookUrl: g("webhook_url"), resendFrom: g("resend_from"),
        emailProvider: (g("email_provider") as Channel["emailProvider"]), emailApiKey: g("email_api_key"),
        emailFrom: g("email_from"), emailFromName: g("email_from_name"),
        vapidPublic: g("vapid_public"), vapidPrivate: g("vapid_private"),
      };
    },
    async config() {
      return ok(await c.from("notify_config").select("enabled,remind_after_s,cooldown_s").eq("id", 1).maybeSingle()) as Cfg | null;
    },
    async recipients() {
      return (ok(await c.from("notify_recipients").select("email,min_severity").eq("active", true).limit(MAX_TO)) ?? []) as Recipient[];
    },
    async subscriptions(userId) {
      let q = c.from("push_subscriptions").select("endpoint,p256dh,auth,min_severity").limit(200);
      if (userId) q = q.eq("user_id", userId);
      return (ok(await q) ?? []) as Sub[];
    },
    async deleteSub(endpoint) {
      await c.from("push_subscriptions").delete().eq("endpoint", endpoint);
    },
    async saveVapid(publicKey, privateJwk) {
      const r = await c.from("notify_config").update({ vapid_public: publicKey, vapid_private: privateJwk })
        .eq("id", 1).is("vapid_public", null);
      if (r.error) throw new Error("db");
    },
    async event(id) {
      return ok(await c.from("events").select("id,created_at,device_id,type,lat,lng,payload").eq("id", id).maybeSingle()) as Ev | null;
    },
    async acked(id) {
      return ok(await c.from("event_acks").select("event_id").eq("event_id", id).maybeSingle()) !== null;
    },
    async deviceName(deviceId) {
      const r = await c.from("devices").select("name").eq("device_id", deviceId).maybeSingle();
      return r.error ? null : ((r.data as { name?: string } | null)?.name ?? null);
    },
    async claim(eventId, kind) {
      const r = await c.rpc("notify_claim", { p_event: eventId, p_kind: kind });
      if (r.error) throw new Error("db");
      return r.data === true;
    },
    async results(eventId, kind) {
      const r = ok(await c.from("notify_log").select("results").eq("event_id", eventId).eq("kind", kind).maybeSingle()) as
        { results: Results } | null;
      return r?.results ?? {};
    },
    async finish(eventId, kind, okFlag, channel, recipients, detail, results) {
      const r = await c.from("notify_log")
        .update({ status: okFlag ? "ok" : "error", channel, recipients, detail: detail.slice(0, 200), results, sent_at: new Date().toISOString() })
        .eq("event_id", eventId).eq("kind", kind);
      if (r.error) throw new Error("db");
    },
    async recentOk(deviceId, kind, sinceIso, exceptEventId) {
      const r = await c.from("notify_log").select("event_id,events!inner(device_id)")
        .eq("kind", kind).eq("status", "ok").gt("recipients", 0).gte("sent_at", sinceIso)
        .neq("event_id", exceptEventId).eq("events.device_id", deviceId).limit(1);
      if (r.error) throw new Error("db");
      return (r.data?.length ?? 0) > 0;
    },
  };
  const getUser: Deps["getUser"] = async (jwt) => {
    const { data, error } = await c.auth.getUser(jwt);
    return error || !data?.user ? null : (data.user as { id?: string; app_metadata?: Record<string, unknown> });
  };
  return { db, getUser };
}

// NOTIFY_NO_SERVE=1 (o no estar en Deno) permite importar este archivo desde un test sin levantar el servidor.
// deno-lint-ignore no-explicit-any
const D = (globalThis as any).Deno;
if (D && !D.env.get("NOTIFY_NO_SERVE")) {
  let real: Pick<Deps, "db" | "getUser"> | null = null;
  D.serve(async (req: Request) => {
    real ??= await realDeps();
    return makeHandler({
      ...real,
      secret: D.env.get("NOTIFY_SECRET"),
      webhookUrl: D.env.get("NOTIFY_WEBHOOK_URL"),
      resendKey: D.env.get("RESEND_API_KEY"),
      from: D.env.get("NOTIFY_FROM"),
      viewerUrl: D.env.get("NOTIFY_VIEWER_URL"),
    } as Deps)(req);
  });
}
