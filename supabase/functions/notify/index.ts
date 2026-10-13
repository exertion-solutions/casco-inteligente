// Edge Function notify (Supabase, Deno). Ver docs/PROTOCOLO-AVISOS.md.
// Manda un correo a los responsables cuando entra una alerta (SOS, caida, zona, sin movimiento) y un
// recordatorio si nadie la atiende. La llaman: (a) el trigger de events por pg_net (inmediato) y (b) pg_cron
// cada minuto (recordatorio / reintento), ambos con la cabecera x-notify-secret; y (c) un admin desde el visor
// con su JWT, solo para {"test":true}. Un solo archivo para pegarlo en el dashboard; sin dependencias externas
// (supabase-js se importa solo cuando corre en Deno).
//
// SIN variables obligatorias: la clave y el canal se leen de la tabla notify_config con service_role
// (la clave la genera notify_bootstrap(); la URL del canal la guarda el admin desde el visor).
// Env (todas opcionales; SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY las inyecta Supabase, NUNCA van al repo):
//      NOTIFY_SECRET        (tambien vale como x-notify-secret, ademas de notify_config.webhook_secret),
//      NOTIFY_WEBHOOK_URL   (canal a de respaldo si la tabla no tiene webhook_url; POST JSON {to, subject, text, html, severity, event_id}),
//      RESEND_API_KEY       (canal b: API de Resend; la clave solo existe como variable de entorno) + remitente
//                           notify_config.resend_from o NOTIFY_FROM,
//      NOTIFY_VIEWER_URL    (opcional: enlace al visor; por defecto el de GitHub Pages).
// Si hay webhook y Resend, se intenta primero el webhook y, si falla, Resend.
//
// Cuerpo: {"event_id":"<uuid>","kind":"inmediato"|"recordatorio"}  o  {"test":true}.
// Respuestas: 200 {ok, sent, ...} | 400 | 401 | 403 | 404 | 405 | 502 (el canal rechazo el envio) |
//             503 {error:"canal_no_configurado"} | 500. Nunca devuelve ni registra correos, URLs ni secretos.

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
  /** notify_config.webhook_secret (la clave que usa el trigger). */
  secret: string | null;
  /** notify_config.webhook_url (canal a, guardado desde el visor). */
  webhookUrl: string | null;
  /** notify_config.resend_from (remitente del canal b). */
  resendFrom: string | null;
}
export interface Db {
  channel(): Promise<Channel>;
  config(): Promise<Cfg | null>;
  /** Solo destinatarios activos. */
  recipients(): Promise<Recipient[]>;
  event(id: string): Promise<Ev | null>;
  /** true solo si existe la fila en event_acks. Un error de base NO es "atendida": lanza. */
  acked(id: string): Promise<boolean>;
  deviceName(deviceId: string): Promise<string | null>;
  /** Reserva atomica (evento, kind). false = ya enviado o lo tiene otro proceso. */
  claim(eventId: string, kind: Kind): Promise<boolean>;
  finish(eventId: string, kind: Kind, ok: boolean, channel: string, recipients: number, detail: string): Promise<void>;
  /** Hubo un aviso ok del mismo kind para este casco desde sinceIso (otro evento)? */
  recentOk(deviceId: string, kind: Kind, sinceIso: string, exceptEventId: string): Promise<boolean>;
}
export interface Deps {
  db: Db;
  secret?: string;
  getUser?: (jwt: string) => Promise<{ app_metadata?: Record<string, unknown> } | null>;
  webhookUrl?: string;
  resendKey?: string;
  from?: string;
  viewerUrl?: string;
  fetch?: typeof fetch;
  now?: () => number; // ms
}

export const DEFAULT_VIEWER_URL = "https://exertion-solutions.github.io/casco-inteligente/";
const TIMEOUT_MS = 8_000;
const MAX_TO = 50; // tope de la API de Resend por mensaje
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

function httpsUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  try {
    return new URL(u).protocol === "https:" ? u : undefined;
  } catch {
    return undefined;
  }
}

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

export function makeHandler(deps: Deps) {
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const viewerUrl = httpsUrl(deps.viewerUrl) ?? DEFAULT_VIEWER_URL;

  async function send(
    ch: { webhook?: string; resend?: string; from?: string },
    to: string[], mail: Mail, severityName: string, eventId: string | null,
  ): Promise<SendResult> {
    const { webhook, resend } = ch;
    let detail = "";
    if (webhook) {
      const r = await post(f, webhook, {}, {
        to, subject: mail.subject, text: mail.text, html: mail.html, severity: severityName, event_id: eventId,
      });
      if (r === "ok") return { ok: true, channel: "webhook", detail: "HTTP 2xx" };
      detail = `webhook ${r}`;
    }
    if (resend) {
      const r = await post(f, "https://api.resend.com/emails", { authorization: `Bearer ${resend}` }, {
        from: ch.from, to, subject: mail.subject, text: mail.text, html: mail.html,
      });
      if (r === "ok") return { ok: true, channel: "resend", detail: "HTTP 2xx" };
      detail = (detail ? detail + "; " : "") + `resend ${r}`;
    }
    return { ok: false, channel: webhook ? "webhook" : "resend", detail };
  }

  return async (req: Request): Promise<Response> => {
    try {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (req.method !== "POST") return new Response(null, { status: 405 });

      // --- autenticacion: secreto compartido (pg_net / pg_cron) o JWT de admin (solo prueba) ---
      // El secreto vale si coincide con el de la TABLA (notify_config.webhook_secret) o con NOTIFY_SECRET del entorno.
      let mode: "system" | "admin" | null = null;
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
          if (u && u.app_metadata?.role === "admin") mode = "admin";
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
      const from = c.resendFrom || deps.from;
      const ch = {
        webhook: httpsUrl(c.webhookUrl ?? undefined) ?? httpsUrl(deps.webhookUrl),
        resend: deps.resendKey && from && from.length >= 3 && from.length <= 200 && from.split("").every((x) => x >= " ") ? deps.resendKey : undefined,
        from,
      };
      const hasChannel = !!(ch.webhook || ch.resend);

      // --- prueba: a todos los destinatarios activos, sin tocar notify_log ---
      if (body.test === true) {
        if (!hasChannel) return json(503, { ok: false, error: "canal_no_configurado" });
        const to = (await deps.db.recipients()).map((r) => r.email).slice(0, MAX_TO);
        if (!to.length) return json(409, { ok: false, error: "sin_destinatarios" });
        const r = await send(ch, to, testMail(viewerUrl), "prueba", null);
        return json(r.ok ? 200 : 502, { ok: r.ok, test: true, channel: r.channel, recipients: to.length, detail: r.detail });
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
      const nowMs = now();
      if (cfg.cooldown_s > 0) {
        const since = new Date(nowMs - cfg.cooldown_s * 1000).toISOString();
        if (await deps.db.recentOk(ev.device_id, kind, since, ev.id)) {
          return json(200, { ok: true, sent: 0, skipped: "cooldown" });
        }
      }
      const to = (await deps.db.recipients()).filter((r) => RANK[r.min_severity] <= sev).map((r) => r.email)
        .slice(0, MAX_TO);

      if (!(await deps.db.claim(ev.id, kind))) return json(200, { ok: true, sent: 0, skipped: "ya_enviado_o_en_curso" });
      if (!hasChannel) {
        await deps.db.finish(ev.id, kind, false, "-", to.length, "sin_canal");
        return json(503, { ok: false, error: "canal_no_configurado" });
      }
      if (!to.length) {
        await deps.db.finish(ev.id, kind, true, "-", 0, "sin_destinatarios");
        return json(200, { ok: true, sent: 0, skipped: "sin_destinatarios" });
      }
      const mail = buildMail(ev, sev, kind, nowMs, await deps.db.deviceName(ev.device_id), viewerUrl);
      const r = await send(ch, to, mail, SEV_NAME[sev], ev.id);
      await deps.db.finish(ev.id, kind, r.ok, r.channel, to.length, r.detail);
      return json(r.ok ? 200 : 502, { ok: r.ok, kind, channel: r.channel, sent: r.ok ? to.length : 0, detail: r.detail });
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
      const r = ok(await c.from("notify_config").select("webhook_secret,webhook_url,resend_from").eq("id", 1).maybeSingle()) as
        { webhook_secret: string | null; webhook_url: string | null; resend_from: string | null } | null;
      return { secret: r?.webhook_secret ?? null, webhookUrl: r?.webhook_url ?? null, resendFrom: r?.resend_from ?? null };
    },
    async config() {
      return ok(await c.from("notify_config").select("enabled,remind_after_s,cooldown_s").eq("id", 1).maybeSingle()) as Cfg | null;
    },
    async recipients() {
      return (ok(await c.from("notify_recipients").select("email,min_severity").eq("active", true).limit(MAX_TO)) ?? []) as Recipient[];
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
    async finish(eventId, kind, okFlag, channel, recipients, detail) {
      const r = await c.from("notify_log")
        .update({ status: okFlag ? "ok" : "error", channel, recipients, detail: detail.slice(0, 200), sent_at: new Date().toISOString() })
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
    return error || !data?.user ? null : (data.user as { app_metadata?: Record<string, unknown> });
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
