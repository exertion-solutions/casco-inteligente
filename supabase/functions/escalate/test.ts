// Correr:  deno test --allow-env --allow-net supabase/functions/escalate/test.ts
// No usa red ni Supabase real: la base y fetch son dobles en memoria.
import { assertEquals, assert } from "jsr:@std/assert@1";

Deno.env.set("ESCALATE_NO_SERVE", "1");
const { makeHandler, alertReason, buildPayload, mapUrl } = await import("./index.ts");
type Ev = import("./index.ts").Ev;
type Rule = import("./index.ts").Rule;

const T0 = Date.parse("2026-01-01T12:00:00Z");
const ago = (s: number) => new Date(T0 - s * 1000).toISOString();
const URL1 = "https://example.invalid/hook/SECRET-PATH";
const RULE: Rule = { id: "r1", after_seconds: 60, channel: "teams", enabled: true, message_template: null };

function ev(id: string, type: string, ageS: number, extra: Partial<Ev> = {}): Ev {
  return { id, created_at: ago(ageS), device_id: "4132", type, lat: -34.6, lng: -58.4, payload: {}, ...extra };
}

interface World {
  rules?: Rule[];
  events?: Ev[];
  acked?: string[];
  escs?: { event_id: string; rule_id: string; ok: boolean; sent_at: string }[];
  claimDenied?: Set<string>;
  status?: number | "throw";
}
function setup(w: World, over: Record<string, unknown> = {}) {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const finished: { id: string; ok: boolean; detail: string }[] = [];
  const claimed: string[] = [];
  let sinceSeen = "", beforeSeen = "";
  const fakeFetch = (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    if (w.status === "throw") return Promise.reject(Object.assign(new Error(`fail ${url}`), { name: "TimeoutError" }));
    return Promise.resolve(new Response("1", { status: w.status ?? 200 }));
  };
  const handler = makeHandler({
    secret: "s3cret",
    webhookUrl: URL1,
    now: () => T0,
    sleep: () => Promise.resolve(),
    fetch: fakeFetch as typeof fetch,
    db: {
      rules: () => Promise.resolve(w.rules ?? [RULE]),
      events: (s: string, b: string) => {
        sinceSeen = s;
        beforeSeen = b;
        return Promise.resolve(w.events ?? []);
      },
      acked: (ids: string[]) => Promise.resolve(new Set(ids.filter((i) => (w.acked ?? []).includes(i)))),
      escalations: () => Promise.resolve(w.escs ?? []),
      claim: (e: string, r: string) => {
        if (w.claimDenied?.has(e)) return Promise.resolve(false);
        claimed.push(`${e}|${r}`);
        return Promise.resolve(true);
      },
      finish: (id: string, _r: string, ok: boolean, detail: string) => {
        finished.push({ id, ok, detail });
        return Promise.resolve();
      },
    },
    ...over,
  });
  return { handler, sent, finished, claimed, seen: () => ({ sinceSeen, beforeSeen }) };
}

const call = (h: (r: Request) => Promise<Response>, body: unknown = {}, hdr: Record<string, string> = { "x-escalate-key": "s3cret" }, method = "POST", qs = "") =>
  h(new Request(`https://x.test/escalate${qs}`, { method, headers: hdr, body: method === "POST" ? JSON.stringify(body) : undefined }));

Deno.test("sin secreto, secreto malo, GET: sin cuerpo", async () => {
  const s = setup({});
  assertEquals((await call(s.handler, {}, {})).status, 401);
  assertEquals((await call(s.handler, {}, { "x-escalate-key": "mal" })).status, 401);
  assertEquals((await call(s.handler, {}, { "x-escalate-key": "s3cret" }, "GET")).status, 405);
  const r = await call(s.handler, {}, {}, "POST", "?k=s3cret"); // ?k= tambien vale
  assertEquals(r.status, 200);
  const closed = setup({}, { secret: undefined });
  assertEquals((await call(closed.handler)).status, 401); // sin ESCALATE_SECRET: falla cerrada
});

Deno.test("sin webhook configurado: 503 y no consulta nada", async () => {
  const s = setup({ events: [ev("a", "sos", 120)] }, { webhookUrl: undefined });
  assertEquals((await call(s.handler)).status, 503);
  assertEquals(s.sent.length, 0);
  const http = setup({}, { webhookUrl: "http://inseguro.test/x" }); // solo https
  assertEquals((await call(http.handler)).status, 503);
});

Deno.test("sin reglas habilitadas: no hace nada", async () => {
  const s = setup({ rules: [{ ...RULE, enabled: false }] });
  const j = await (await call(s.handler)).json();
  assertEquals([j.rules, j.sent], [0, 0]);
});

Deno.test("SOS de 120 s sin atender: se envia y se registra", async () => {
  const s = setup({ events: [ev("a", "sos", 120)] });
  const j = await (await call(s.handler)).json();
  assertEquals([j.candidates, j.sent, j.failed], [1, 1, 0]);
  assertEquals(s.sent.length, 1);
  const b = s.sent[0].body;
  assertEquals(b.type, "sos");
  assertEquals(b.device_id, "4132");
  assertEquals(b.age_s, 120);
  assert(String(b.text).includes("4132") && String(b.text).includes("SOS"));
  assert(String(b.map_url).startsWith("https://www.openstreetmap.org/"));
  assert(Array.isArray(b.attachments)); // Adaptive Card por defecto
  assertEquals(s.finished, [{ id: "a", ok: true, detail: "HTTP 200" }]);
});

Deno.test("la URL del webhook no aparece en la respuesta ni en el detalle", async () => {
  const s = setup({ events: [ev("a", "sos", 120)], status: "throw" });
  const res = await call(s.handler);
  const txt = await res.text();
  assert(!txt.includes("SECRET-PATH") && !txt.includes("example.invalid"));
  for (const f of s.finished) assert(!f.detail.includes("SECRET-PATH"));
});

Deno.test("ya atendido, ya escalado ok, o menor a after_seconds: no se envia", async () => {
  const s = setup({
    events: [ev("ack", "sos", 300), ev("done", "fall", 300), ev("young", "sos", 30), ev("go", "fall", 100)],
    acked: ["ack"],
    escs: [{ event_id: "done", rule_id: "r1", ok: true, sent_at: ago(200) }],
  });
  const j = await (await call(s.handler)).json();
  assertEquals(j.sent, 1);
  assertEquals(s.sent[0].body.type, "fall");
  assertEquals(s.claimed, ["go|r1"]);
});

Deno.test("fallo previo viejo se reintenta; fallo reciente (<55 s) o en curso no", async () => {
  const s = setup({
    events: [ev("old", "sos", 300), ev("recent", "sos", 300)],
    escs: [
      { event_id: "old", rule_id: "r1", ok: false, sent_at: ago(120) },
      { event_id: "recent", rule_id: "r1", ok: false, sent_at: ago(10) },
    ],
  });
  const j = await (await call(s.handler)).json();
  assertEquals(j.sent, 1);
  assertEquals(s.claimed, ["old|r1"]);
});

Deno.test("otra corrida lo reservo: se omite sin enviar", async () => {
  const s = setup({ events: [ev("a", "sos", 120)], claimDenied: new Set(["a"]) });
  const j = await (await call(s.handler)).json();
  assertEquals([j.sent, j.skipped], [0, 1]);
  assertEquals(s.sent.length, 0);
});

Deno.test("maximo 20 por corrida; el resto queda como skipped", async () => {
  const events = Array.from({ length: 25 }, (_, i) => ev(`e${i}`, "sos", 600 - i));
  const s = setup({ events });
  const j = await (await call(s.handler)).json();
  assertEquals([j.candidates, j.sent, j.skipped], [25, 20, 5]);
  assertEquals(s.sent.length, 20);
});

Deno.test("geocerca: solo restringida/peligro enter y permitida exit", () => {
  const g = (p: Record<string, unknown>) => alertReason(ev("g", "geofence", 100, { payload: p }));
  assert(g({ kind: "restringida", action: "enter", zone_name: "Pozo 4" })!.includes("Pozo 4"));
  assert(g({ kind: "peligro", action: "enter" }) !== null);
  assert(g({ kind: "permitida", action: "exit" }) !== null);
  assertEquals(g({ kind: "permitida", action: "enter" }), null);
  assertEquals(g({ kind: "restringida", action: "exit" }), null);
  assertEquals(g({ kind: "informativa", action: "enter" }), null);
  assertEquals(alertReason(ev("h", "heartbeat", 100)), null);
});

Deno.test("nombre de zona hostil se sanea", () => {
  const r = alertReason(ev("g", "geofence", 100, {
    payload: { kind: "restringida", action: "enter", zone_name: "<script>x</script>[click](http://evil)" },
  }))!;
  assert(!r.includes("<") && !r.includes("[") && !r.includes("("));
});

Deno.test("plantilla con placeholders; sin card si ESCALATION_CARD=0; mapa nulo sin coordenadas", () => {
  const e = ev("a", "sos", 100, { lat: null, lng: null });
  const p = buildPayload(e, "SOS", 100, "{tipo}|{device_id}|{edad}|{mapa}|", false);
  assertEquals(p.text, "SOS|4132|100 s||");
  assertEquals(p.map_url, null);
  assertEquals("attachments" in p, false);
  assertEquals(mapUrl(100, 0), null);
  assertEquals(mapUrl("a", 0), null);
});

Deno.test("webhook 500: reintenta una vez y registra fallo", async () => {
  const s = setup({ events: [ev("a", "sos", 120)], status: 500 });
  const j = await (await call(s.handler)).json();
  assertEquals([j.sent, j.failed], [0, 1]);
  assertEquals(s.sent.length, 2); // 1 intento + 1 reintento
  assertEquals(s.finished[0], { id: "a", ok: false, detail: "HTTP 500" });
});

Deno.test("webhook 400: no reintenta", async () => {
  const s = setup({ events: [ev("a", "sos", 120)], status: 400 });
  await call(s.handler);
  assertEquals(s.sent.length, 1);
});

Deno.test("3 fallos seguidos cortan la corrida", async () => {
  const s = setup({ events: Array.from({ length: 6 }, (_, i) => ev(`e${i}`, "sos", 300)), status: 400 });
  const j = await (await call(s.handler)).json();
  assertEquals([j.failed, j.skipped], [3, 3]);
});

Deno.test("dry_run cuenta sin enviar; test envia una prueba", async () => {
  const s = setup({ events: [ev("a", "sos", 120)] });
  const j = await (await call(s.handler, { dry_run: true })).json();
  assertEquals([j.candidates, j.sent, s.sent.length, s.claimed.length], [1, 0, 0, 0]);
  const t = await (await call(s.handler, { test: true })).json();
  assertEquals(t.ok, true);
  assertEquals(s.sent.length, 1);
  assertEquals(s.sent[0].body.device_id, "PRUEBA");
});

Deno.test("after_seconds=0 usa el webhook inmediato si existe", async () => {
  const s = setup(
    { rules: [{ ...RULE, after_seconds: 0 }], events: [ev("a", "sos", 1)] },
    { webhookUrlNow: "https://inmediato.invalid/x" },
  );
  await call(s.handler);
  assertEquals(s.sent[0].url, "https://inmediato.invalid/x");
});

Deno.test("ventana: consulta ultimos 30 min hasta ahora - after_seconds", async () => {
  const s = setup({ events: [] });
  await call(s.handler);
  assertEquals(s.seen().sinceSeen, ago(30 * 60));
  assertEquals(s.seen().beforeSeen, ago(60));
});
