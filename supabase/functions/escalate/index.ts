// Edge Function escalate (Supabase, Deno). Ver docs/PROTOCOLO-CENTRO.md seccion 2.
// pg_cron + pg_net la llaman cada minuto (POST). Busca alertas (sos / caida / geocerca que
// requiere atencion) sin atender hace >= after_seconds de una regla habilitada y las envia a un
// webhook entrante de Teams / Power Automate. Un solo archivo para pegarlo en el dashboard.
//
// Env: SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY (los inyecta Supabase; NUNCA van al repo),
//      ESCALATE_SECRET (lo cargas vos; cabecera x-escalate-key o ?k=),
//      ESCALATION_WEBHOOK_URL (webhook de Teams/Power Automate),
//      ESCALATION_WEBHOOK_URL_INMEDIATO (opcional: segundo webhook para reglas con after_seconds = 0),
//      ESCALATION_CARD ("0" para no incluir la Adaptive Card; por defecto se incluye).
// Usa service_role porque la dispara un cron sin usuario y escribe una tabla que ningun usuario
// debe poder escribir. Solo toca: escalation_rules, events, event_acks, escalations.
// No loguea ni devuelve la URL del webhook ni el secreto.
//
// Respuesta: JSON {ok, rules, candidates, sent, failed, skipped, ms}. Cuerpo opcional:
//   {"dry_run":true}  cuenta candidatos sin enviar ni registrar.
//   {"test":true}     envia un mensaje de prueba al webhook (no toca la base).

import { createClient } from "npm:@supabase/supabase-js@2";

export interface Rule {
  id: string;
  after_seconds: number;
  channel: string;
  enabled: boolean;
  message_template: string | null;
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
export interface EscRow {
  event_id: string;
  rule_id: string;
  ok: boolean;
  sent_at: string;
}
export interface Db {
  rules(): Promise<Rule[]>;
  events(sinceIso: string, beforeIso: string): Promise<Ev[]>;
  acked(ids: string[]): Promise<Set<string>>;
  escalations(ids: string[]): Promise<EscRow[]>;
  /** Reserva (evento, regla) de forma atomica. false = otro proceso lo tiene o ya esta hecho. */
  claim(eventId: string, ruleId: string, nowIso: string, staleIso: string): Promise<boolean>;
  finish(eventId: string, ruleId: string, ok: boolean, detail: string): Promise<void>;
}
export interface Deps {
  db: Db;
  secret?: string;
  webhookUrl?: string;
  webhookUrlNow?: string;
  card?: boolean;
  fetch?: typeof fetch;
  now?: () => number; // ms
  sleep?: (ms: number) => Promise<void>;
}

export const WINDOW_MS = 30 * 60_000; // solo alertas de los ultimos 30 min
export const MAX_PER_RUN = 20;
const STALE_MS = 55_000; // un envio "en curso" o fallido se reintenta pasado este tiempo
const BUDGET_MS = 90_000; // tope de tiempo por corrida (la funcion vive ~150 s)
const TIMEOUT_MS = 8_000;
const MAX_CONSECUTIVE_FAILS = 3;
const DEFAULT_TEMPLATE =
  "ALERTA {tipo} sin atender: casco {device_id}. {motivo}. Hace {edad}. {mapa}";

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
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// Texto que viene del casco (payload): solo letras, numeros y signos simples.
function clean(v: unknown, max = 60): string {
  const s = typeof v === "string" ? v : "";
  return s.replace(/[^\p{L}\p{N} .,_-]/gu, "").trim().slice(0, max);
}

/** Devuelve el motivo legible si el evento requiere atencion; null si es solo informativo. */
export function alertReason(e: Ev): string | null {
  if (e.type === "sos") return "SOS";
  if (e.type === "fall") return "Caida / hombre caido";
  if (e.type === "geofence") {
    const p = e.payload ?? {};
    const kind = clean(p.kind), action = clean(p.action);
    const zone = clean(p.zone_name) || "sin nombre";
    if ((kind === "restringida" || kind === "peligro") && action === "enter") {
      return `Ingreso a zona restringida: ${zone}`;
    }
    if (kind === "permitida" && action === "exit") {
      return `Salio de zona permitida: ${zone}`;
    }
  }
  return null;
}

function fmtAge(s: number): string {
  if (s < 90) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 90 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function mapUrl(lat: unknown, lng: unknown): string | null {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const a = lat.toFixed(6), b = lng.toFixed(6);
  return `https://www.openstreetmap.org/?mlat=${a}&mlon=${b}#map=17/${a}/${b}`;
}

const TYPE_LABEL: Record<string, string> = { sos: "SOS", fall: "CAIDA", geofence: "GEOCERCA" };

export function buildPayload(e: Ev, reason: string, ageS: number, template: string | null, card: boolean) {
  const device = clean(e.device_id, 64);
  const map = mapUrl(e.lat, e.lng);
  const tipo = TYPE_LABEL[e.type] ?? e.type;
  const title = `${tipo} sin atender - casco ${device}`;
  const text = (template?.trim() || DEFAULT_TEMPLATE)
    .replaceAll("{tipo}", tipo)
    .replaceAll("{device_id}", device)
    .replaceAll("{motivo}", reason)
    .replaceAll("{edad}", fmtAge(ageS))
    .replaceAll("{mapa}", map ?? "")
    .trim();
  // Campos del protocolo + attachments (Adaptive Card minima) para los flujos de Teams.
  const body: Record<string, unknown> = {
    title,
    text,
    device_id: device,
    type: e.type,
    reason,
    age_s: ageS,
    lat: e.lat,
    lng: e.lng,
    map_url: map,
  };
  if (card) {
    body.attachments = [{
      contentType: "application/vnd.microsoft.card.adaptive",
      contentUrl: null,
      content: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.4",
        body: [
          { type: "TextBlock", text: title, weight: "Bolder", size: "Medium", wrap: true, color: "Attention" },
          { type: "TextBlock", text, wrap: true },
        ],
        actions: map ? [{ type: "Action.OpenUrl", title: "Ver en el mapa", url: map }] : [],
      },
    }];
  }
  return body;
}

interface PostResult {
  ok: boolean;
  detail: string;
  retry: boolean;
}

async function post(f: typeof fetch, url: string, payload: unknown): Promise<PostResult> {
  try {
    const r = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "manual", // no seguir redirecciones a otro host
    });
    await r.body?.cancel();
    if (r.ok) return { ok: true, detail: `HTTP ${r.status}`, retry: false };
    return { ok: false, detail: `HTTP ${r.status}`, retry: r.status === 429 || r.status >= 500 };
  } catch (e) {
    const n = (e as Error)?.name;
    // Sin e.message: algunas implementaciones incluyen la URL del webhook.
    return { ok: false, detail: n === "TimeoutError" || n === "AbortError" ? "timeout" : "red", retry: true };
  }
}

function validUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  try {
    return new URL(u).protocol === "https:" ? u : undefined;
  } catch {
    return undefined;
  }
}

export function makeHandler(deps: Deps) {
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const card = deps.card ?? true;

  async function send(url: string, payload: unknown): Promise<PostResult> {
    let r = await post(f, url, payload);
    if (!r.ok && r.retry) {
      await sleep(1000);
      r = await post(f, url, payload); // reintento 1 vez
    }
    return r;
  }

  return async (req: Request): Promise<Response> => {
    const t0 = now();
    try {
      if (req.method !== "POST") return new Response(null, { status: 405 });
      if (!deps.secret) return new Response(null, { status: 401 }); // falla cerrada
      const given = req.headers.get("x-escalate-key") ?? new URL(req.url).searchParams.get("k") ?? "";
      if (!(await safeEqual(given, deps.secret))) return new Response(null, { status: 401 });

      let opts: { dry_run?: boolean; test?: boolean } = {};
      try {
        const raw = await req.text();
        if (raw.length <= 2048 && raw.trim()) opts = JSON.parse(raw) ?? {};
      } catch { /* cuerpo vacio o ilegible: opciones por defecto */ }

      const url1 = validUrl(deps.webhookUrl);
      const url0 = validUrl(deps.webhookUrlNow) ?? url1;
      if (!url1 && !url0) return json(503, { ok: false, error: "webhook_no_configurado" });

      if (opts.test === true) {
        const sample: Ev = {
          id: "00000000-0000-0000-0000-000000000000",
          created_at: new Date(t0).toISOString(),
          device_id: "PRUEBA",
          type: "sos",
          lat: -34.6037,
          lng: -58.3816,
          payload: {},
        };
        const p = buildPayload(sample, "Mensaje de prueba (no es una alerta real)", 0, null, card);
        p.title = "PRUEBA - Casco Inteligente";
        const r = await send((url1 ?? url0)!, p);
        return json(r.ok ? 200 : 502, { ok: r.ok, test: true, detail: r.detail, ms: now() - t0 });
      }

      const rules = (await deps.db.rules()).filter((r) => r.enabled && r.channel === "teams");
      const out = { ok: true, rules: rules.length, candidates: 0, sent: 0, failed: 0, skipped: 0, ms: 0 };
      if (rules.length === 0) return json(200, { ...out, ms: now() - t0 });

      const minAfter = Math.min(...rules.map((r) => r.after_seconds));
      const evs = await deps.db.events(
        new Date(t0 - WINDOW_MS).toISOString(),
        new Date(t0 - minAfter * 1000).toISOString(),
      );
      const alerts = evs.map((e) => ({ e, reason: alertReason(e) }))
        .filter((x): x is { e: Ev; reason: string } => x.reason !== null);
      const ids = alerts.map((x) => x.e.id);
      const acked = ids.length ? await deps.db.acked(ids) : new Set<string>();
      const escs = ids.length ? await deps.db.escalations(ids) : [];
      const staleIso = new Date(t0 - STALE_MS).toISOString();
      const blocked = new Set(
        escs.filter((x) => x.ok || x.sent_at > staleIso).map((x) => `${x.event_id}|${x.rule_id}`),
      );

      const todoAll: { e: Ev; reason: string; rule: Rule; age: number }[] = [];
      for (const { e, reason } of alerts) { // alerts ya viene de la mas vieja a la mas nueva
        if (acked.has(e.id)) continue;
        const age = Math.floor((t0 - Date.parse(e.created_at)) / 1000);
        for (const rule of rules) {
          if (age >= rule.after_seconds && !blocked.has(`${e.id}|${rule.id}`)) {
            todoAll.push({ e, reason, rule, age });
          }
        }
      }
      out.candidates = todoAll.length;
      if (opts.dry_run === true) return json(200, { ...out, dry_run: true, ms: now() - t0 });

      const todo = todoAll.slice(0, MAX_PER_RUN);
      out.skipped = todoAll.length - todo.length; // excedio el maximo por corrida: va en la proxima
      let fails = 0;
      for (let i = 0; i < todo.length; i++) {
        const { e, reason, rule, age } = todo[i];
        if (now() - t0 > BUDGET_MS || fails >= MAX_CONSECUTIVE_FAILS) {
          out.skipped += todo.length - i; // webhook caido o sin tiempo: proxima corrida
          break;
        }
        const url = rule.after_seconds === 0 ? url0 : url1;
        if (!url) {
          out.skipped++;
          continue;
        }
        const mine = await deps.db.claim(e.id, rule.id, new Date(now()).toISOString(), staleIso);
        if (!mine) {
          out.skipped++; // otra corrida lo tomo
          continue;
        }
        const r = await send(url, buildPayload(e, reason, age, rule.message_template, card));
        await deps.db.finish(e.id, rule.id, r.ok, r.detail);
        if (r.ok) {
          out.sent++;
          fails = 0;
        } else {
          out.failed++;
          fails++;
        }
      }
      return json(200, { ...out, ms: now() - t0 });
    } catch {
      return json(500, { ok: false, error: "interno" }); // sin detalles
    }
  };
}

// --- Acceso real a la base (service_role, inyectado por Supabase) ---------------------------
function realDb(): Db {
  const c = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const ok = <T>(r: { data: T | null; error: unknown }): T => {
    if (r.error) throw new Error("db");
    return (r.data ?? []) as T;
  };
  return {
    async rules() {
      return ok(await c.from("escalation_rules")
        .select("id,after_seconds,channel,enabled,message_template").eq("enabled", true)) as Rule[];
    },
    async events(sinceIso, beforeIso) {
      // limit 100: los ids van en la URL de las consultas siguientes.
      return ok(await c.from("events")
        .select("id,created_at,device_id,type,lat,lng,payload")
        .in("type", ["sos", "fall", "geofence"])
        .gte("created_at", sinceIso).lte("created_at", beforeIso)
        .order("created_at", { ascending: true }).limit(100)) as Ev[];
    },
    async acked(ids) {
      const rows = ok(await c.from("event_acks").select("event_id").in("event_id", ids)) as
        { event_id: string }[];
      return new Set(rows.map((r) => r.event_id));
    },
    async escalations(ids) {
      return ok(await c.from("escalations").select("event_id,rule_id,ok,sent_at")
        .in("event_id", ids)) as EscRow[];
    },
    async claim(eventId, ruleId, nowIso, staleIso) {
      const ins = await c.from("escalations")
        .insert({ event_id: eventId, rule_id: ruleId, ok: false, detail: "enviando", sent_at: nowIso });
      if (!ins.error) return true;
      if (ins.error.code !== "23505") throw new Error("db");
      // Ya existe: solo se retoma si fallo / quedo colgada hace mas de STALE_MS.
      const upd = await c.from("escalations").update({ sent_at: nowIso, detail: "reintento" })
        .eq("event_id", eventId).eq("rule_id", ruleId).eq("ok", false).lt("sent_at", staleIso)
        .select("event_id");
      return (upd.data?.length ?? 0) === 1;
    },
    async finish(eventId, ruleId, okFlag, detail) {
      const r = await c.from("escalations").update({ ok: okFlag, detail, sent_at: new Date().toISOString() })
        .eq("event_id", eventId).eq("rule_id", ruleId);
      if (r.error) throw new Error("db");
    },
  };
}

// ESCALATE_NO_SERVE=1 lo usa test.ts para importar sin levantar el servidor.
if (!Deno.env.get("ESCALATE_NO_SERVE")) {
  let db: Db | null = null;
  Deno.serve((req) =>
    makeHandler({
      get db() {
        return (db ??= realDb());
      },
      secret: Deno.env.get("ESCALATE_SECRET"),
      webhookUrl: Deno.env.get("ESCALATION_WEBHOOK_URL"),
      webhookUrlNow: Deno.env.get("ESCALATION_WEBHOOK_URL_INMEDIATO"),
      card: Deno.env.get("ESCALATION_CARD") !== "0",
    } as Deps)(req)
  );
}
