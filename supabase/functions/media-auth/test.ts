// Correr:  deno test --allow-env --allow-net supabase/functions/media-auth/test.ts
// (no usa red ni Supabase real: getUser es un doble).
import { assertEquals } from "jsr:@std/assert@1";

Deno.env.set("MEDIA_AUTH_NO_SERVE", "1");
const { makeHandler } = await import("./index.ts");

const jwt = (n: string) => `aaa.${n}.zzz`; // forma valida de JWT, contenido irrelevante
const USERS: Record<string, { app_metadata: Record<string, unknown> }> = {
  [jwt("dev4132")]: { app_metadata: { role: "device", device_id: "4132" } },
  [jwt("viewer")]: { app_metadata: { role: "viewer" } },
  [jwt("admin")]: { app_metadata: { role: "admin" } },
  [jwt("norole")]: { app_metadata: {} },
};
const handler = makeHandler({
  secret: "s3cret",
  getUser: (t: string) => Promise.resolve(USERS[t] ?? null),
});

async function call(body: Record<string, unknown>, k = "s3cret", method = "POST") {
  const r = await handler(
    new Request(`https://x.test/media-auth?k=${k}`, {
      method,
      body: method === "POST" ? JSON.stringify(body) : undefined,
    }),
  );
  return r.status;
}
const base = { user: "", password: "", token: "", ip: "1.2.3.4", id: "x", query: "" };

Deno.test("publish device correcto (RTMP password)", async () =>
  assertEquals(await call({ ...base, action: "publish", path: "live/4132", protocol: "rtmp", user: "device", password: jwt("dev4132") }), 200));
Deno.test("publish con pass dentro de query", async () =>
  assertEquals(await call({ ...base, action: "publish", path: "live/4132", protocol: "rtmp", query: `user=device&pass=${jwt("dev4132")}` }), 200));
Deno.test("publish device_id ajeno", async () =>
  assertEquals(await call({ ...base, action: "publish", path: "live/9999", password: jwt("dev4132") }), 401));
Deno.test("viewer intenta publish", async () =>
  assertEquals(await call({ ...base, action: "publish", path: "live/4132", password: jwt("viewer") }), 401));
Deno.test("read viewer (Bearer WHEP)", async () =>
  assertEquals(await call({ ...base, action: "read", path: "live/4132", protocol: "webrtc", token: jwt("viewer") }), 200));
Deno.test("read admin con 'Bearer ' y path con barra inicial", async () =>
  assertEquals(await call({ ...base, action: "read", path: "/live/4132", token: `Bearer ${jwt("admin")}` }), 200));
Deno.test("read device denegado", async () =>
  assertEquals(await call({ ...base, action: "read", path: "live/4132", token: jwt("dev4132") }), 401));
Deno.test("read sin rol", async () =>
  assertEquals(await call({ ...base, action: "read", path: "live/4132", token: jwt("norole") }), 401));
Deno.test("jwt invalido (formato)", async () =>
  assertEquals(await call({ ...base, action: "read", path: "live/4132", token: "basura" }), 401));
Deno.test("jwt bien formado pero desconocido", async () =>
  assertEquals(await call({ ...base, action: "read", path: "live/4132", token: jwt("nadie") }), 401));
Deno.test("sin credenciales", async () =>
  assertEquals(await call({ ...base, action: "read", path: "live/4132" }), 401));
Deno.test("paths invalidos", async () => {
  for (const p of ["live/", "live/a/b", "other/4132", "live/../x", "live/4 1", "live/" + "a".repeat(65), ""]) {
    assertEquals(await call({ ...base, action: "read", path: p, token: jwt("viewer") }), 401, p);
  }
});
Deno.test("acciones api/metrics/pprof", async () => {
  for (const a of ["api", "metrics", "pprof", ""]) {
    assertEquals(await call({ ...base, action: a, path: "live/4132", token: jwt("admin") }), 401, a);
  }
});
Deno.test("secreto incorrecto / ausente / metodo GET", async () => {
  const b = { ...base, action: "read", path: "live/4132", token: jwt("viewer") };
  assertEquals(await call(b, "mal"), 401);
  assertEquals(await call(b, ""), 401);
  assertEquals(await call(b, "s3cret", "GET"), 401);
});
Deno.test("body no JSON", async () => {
  const r = await handler(new Request("https://x.test/?k=s3cret", { method: "POST", body: "no json" }));
  assertEquals(r.status, 401);
});
Deno.test("sin MEDIA_AUTH_SECRET configurado: falla cerrada", async () => {
  const h = makeHandler({ secret: undefined, getUser: () => Promise.resolve(USERS[jwt("viewer")]) });
  const r = await h(new Request("https://x.test/?k=", {
    method: "POST",
    body: JSON.stringify({ ...base, action: "read", path: "live/4132", token: jwt("viewer") }),
  }));
  assertEquals(r.status, 401);
});

// ---- audio del casco: ingest/<device_id> (docs/PROTOCOLO-GEO / audio) ----
Deno.test("ingest: publish device correcto", async () =>
  assertEquals(await call({ ...base, action: "publish", path: "ingest/4132", protocol: "rtmp", password: jwt("dev4132") }), 200));
Deno.test("ingest: publish con barra inicial y pass en query", async () =>
  assertEquals(await call({ ...base, action: "publish", path: "/ingest/4132", query: `user=device&pass=${jwt("dev4132")}` }), 200));
Deno.test("ingest: publish device_id ajeno", async () =>
  assertEquals(await call({ ...base, action: "publish", path: "ingest/9999", password: jwt("dev4132") }), 401));
Deno.test("ingest: viewer/admin no publican", async () => {
  assertEquals(await call({ ...base, action: "publish", path: "ingest/4132", password: jwt("viewer") }), 401);
  assertEquals(await call({ ...base, action: "publish", path: "ingest/4132", password: jwt("admin") }), 401);
});
Deno.test("ingest: sin rol no publica", async () =>
  assertEquals(await call({ ...base, action: "publish", path: "ingest/4132", password: jwt("norole") }), 401));
Deno.test("ingest: viewer/admin NO leen (read y playback)", async () => {
  for (const a of ["read", "playback"]) {
    assertEquals(await call({ ...base, action: a, path: "ingest/4132", token: jwt("viewer") }), 401, a);
    assertEquals(await call({ ...base, action: a, path: "ingest/4132", token: jwt("admin") }), 401, a);
  }
});
Deno.test("ingest: device lee su propio ingest (relay del VPS)", async () =>
  assertEquals(await call({ ...base, action: "read", path: "ingest/4132", protocol: "rtsp", password: jwt("dev4132") }), 200));
Deno.test("ingest: device lee ingest ajeno", async () =>
  assertEquals(await call({ ...base, action: "read", path: "ingest/9999", password: jwt("dev4132") }), 401));
Deno.test("live: device NO lee live (ni propio ni ajeno)", async () => {
  assertEquals(await call({ ...base, action: "read", path: "live/4132", password: jwt("dev4132") }), 401);
  assertEquals(await call({ ...base, action: "read", path: "live/9999", password: jwt("dev4132") }), 401);
});
Deno.test("ingest: device no usa playback", async () =>
  assertEquals(await call({ ...base, action: "playback", path: "ingest/4132", password: jwt("dev4132") }), 401));
Deno.test("ingest: sin rol no lee", async () =>
  assertEquals(await call({ ...base, action: "read", path: "ingest/4132", password: jwt("norole") }), 401));
Deno.test("live: playback viewer permitido; device no lee", async () => {
  assertEquals(await call({ ...base, action: "playback", path: "live/4132", token: jwt("viewer") }), 200);
  assertEquals(await call({ ...base, action: "playback", path: "live/4132", token: jwt("dev4132") }), 401);
});
Deno.test("live: publish device sigue permitido (compatibilidad)", async () =>
  assertEquals(await call({ ...base, action: "publish", path: "live/4132", password: jwt("dev4132") }), 200));
Deno.test("ingest: paths invalidos", async () => {
  for (const p of ["ingest/", "ingest/a/b", "ingest/../x", "ingest/4 1", "ingest/" + "a".repeat(65), "Ingest/4132", "ingest", "xingest/4132", "ingest/4132/"]) {
    assertEquals(await call({ ...base, action: "publish", path: p, password: jwt("dev4132") }), 401, p);
  }
});
Deno.test("ingest: acciones api/metrics/pprof", async () => {
  for (const a of ["api", "metrics", "pprof", ""]) {
    assertEquals(await call({ ...base, action: a, path: "ingest/4132", password: jwt("dev4132") }), 401, a);
  }
});
