// Correr:  deno test --allow-env supabase/functions/turn-credentials/test.ts
// (no usa red ni Supabase real: getUser es un doble).
import { assert, assertEquals } from "jsr:@std/assert@1";

Deno.env.set("TURN_NO_SERVE", "1");
const { makeHandler, hmacSha1B64, DEFAULT_ORIGIN } = await import("./index.ts");

const jwt = (n: string) => `aaa.${n}.zzz`; // forma valida de JWT, contenido irrelevante
const ID = "11111111-2222-3333-4444-555555555555";
const USERS: Record<string, { id: string; app_metadata: Record<string, unknown> }> = {
  [jwt("dev")]: { id: ID, app_metadata: { role: "device", device_id: "4132" } },
  [jwt("viewer")]: { id: ID, app_metadata: { role: "viewer" } },
  [jwt("admin")]: { id: ID, app_metadata: { role: "admin" } },
  [jwt("norole")]: { id: ID, app_metadata: {} },
  [jwt("other")]: { id: ID, app_metadata: { role: "operator" } },
};
const NOW = 1_700_000_000_000; // ms -> exp = 1700003600
const SECRET = "test-secret";
const mk = (over: Record<string, unknown> = {}) =>
  makeHandler({
    secret: SECRET,
    host: "203.0.113.7",
    now: () => NOW,
    getUser: (t: string) => Promise.resolve(USERS[t] ?? null),
    ...over,
  });
const handler = mk();

const req = (token?: string, method = "GET", headers: Record<string, string> = {}) =>
  new Request("https://x.test/turn-credentials", {
    method,
    headers: token === undefined ? headers : { authorization: token, ...headers },
  });

Deno.test("vector RFC 2202 de HMAC-SHA1 (base64)", async () =>
  assertEquals(await hmacSha1B64("Jefe", "what do ya want for nothing?"), "7/zfauXrL6LSdBbV8YTfnCWafHk="));

Deno.test("sin token: 401 sin cuerpo", async () => {
  const r = await handler(req());
  assertEquals(r.status, 401);
  assertEquals(await r.text(), "");
});
Deno.test("token con formato invalido: 401", async () => {
  for (const t of ["Bearer basura", "Bearer ", "Basic abc", jwt("viewer")]) {
    assertEquals((await handler(req(t))).status, 401, t);
  }
});
Deno.test("token bien formado pero desconocido: 401", async () =>
  assertEquals((await handler(req(`Bearer ${jwt("nadie")}`))).status, 401));
Deno.test("getUser que lanza: 401", async () => {
  const h = mk({ getUser: () => Promise.reject(new Error("boom")) });
  assertEquals((await h(req(`Bearer ${jwt("viewer")}`))).status, 401);
});

Deno.test("viewer ok: forma de la respuesta", async () => {
  const r = await handler(req(`Bearer ${jwt("viewer")}`));
  assertEquals(r.status, 200);
  const b = await r.json();
  assertEquals(b.urls, [
    "stun:203.0.113.7:3478",
    "turn:203.0.113.7:3478?transport=udp",
    "turn:203.0.113.7:3478?transport=tcp",
  ]);
  assertEquals(b.ttl, 3600);
  assertEquals(Object.keys(b).sort(), ["credential", "ttl", "urls", "username"]);
  assert(!JSON.stringify(b).includes(SECRET));
});
Deno.test("device y admin ok (POST tambien)", async () => {
  assertEquals((await handler(req(`Bearer ${jwt("dev")}`))).status, 200);
  assertEquals((await handler(req(`bearer ${jwt("admin")}`, "POST"))).status, 200);
});
Deno.test("rol sin permiso o sin rol: 403 sin cuerpo", async () => {
  for (const n of ["norole", "other"]) {
    const r = await handler(req(`Bearer ${jwt(n)}`));
    assertEquals(r.status, 403, n);
    assertEquals(await r.text(), "");
  }
});

Deno.test("username <exp>:<id corto> y firma verificable", async () => {
  const b = await (await handler(req(`Bearer ${jwt("viewer")}`))).json();
  assertEquals(b.username, "1700003600:111111112222");
  assert(/^\d{10}:[A-Za-z0-9]{1,12}$/.test(b.username));
  assertEquals(b.credential, await hmacSha1B64(SECRET, b.username));
  // valor calculado fuera de este codigo: printf '1700003600:111111112222' | openssl dgst -sha1 -hmac test-secret -binary | base64
  assertEquals(b.credential, "/Dm8Vmmcl/UZfWD+mNiu39tpgGE=");
  // otro secreto => otra firma
  assert(b.credential !== await hmacSha1B64("otro", b.username));
});

Deno.test("CORS: preflight OPTIONS", async () => {
  const r = await handler(req(undefined, "OPTIONS", { origin: DEFAULT_ORIGIN }));
  assertEquals(r.status, 204);
  assertEquals(r.headers.get("access-control-allow-origin"), "https://exertion-solutions.github.io");
  assertEquals(r.headers.get("access-control-allow-headers"), "authorization, apikey, content-type");
});
Deno.test("CORS: origen fijo tambien en 200 y en 401 (nunca *)", async () => {
  for (const t of [`Bearer ${jwt("viewer")}`, "Bearer basura"]) {
    const r = await handler(req(t, "GET", { origin: "https://evil.example" }));
    assertEquals(r.headers.get("access-control-allow-origin"), "https://exertion-solutions.github.io");
  }
});
Deno.test("CORS: ALLOWED_ORIGIN configurable", async () => {
  const r = await mk({ origin: "https://otro.example" })(req(undefined, "OPTIONS"));
  assertEquals(r.headers.get("access-control-allow-origin"), "https://otro.example");
});

Deno.test("sin TURN_SECRET o TURN_HOST: falla cerrada 500 sin secretos", async () => {
  for (const over of [{ secret: undefined }, { host: undefined }, { host: "a b;c" }]) {
    const r = await mk(over)(req(`Bearer ${jwt("viewer")}`));
    assertEquals(r.status, 500);
    assertEquals(await r.text(), "");
  }
});
Deno.test("metodo no permitido: 405", async () =>
  assertEquals((await handler(req(`Bearer ${jwt("viewer")}`, "DELETE"))).status, 405));
