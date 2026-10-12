// Edge Function media-auth (Supabase, Deno). Ver docs/PROTOCOLO-VIDEO.md.
// MediaMTX (authMethod: http) hace POST JSON { user, password, token, ip, action,
// path, protocol, id, query } en cada conexion. Respondemos 200 (permitido) o
// 401 (denegado), siempre sin cuerpo. Un solo archivo para poder pegarlo en el dashboard.
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY (los inyecta Supabase), MEDIA_AUTH_SECRET (lo cargas vos).
// Sin service_role. No se loguean tokens.

import { createClient } from "npm:@supabase/supabase-js@2";

export type AuthUser = { app_metadata?: Record<string, unknown> } | null;
export interface Deps {
  getUser: (jwt: string) => Promise<AuthUser>;
  secret: string | undefined;
}

const PATH_RE = /^live\/([A-Za-z0-9_-]{1,64})$/;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_BODY = 8192;

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

const deny = () => new Response(null, { status: 401 });
const allow = () => new Response(null, { status: 200 });

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// JWT: token (Bearer de WHEP/HLS) > password (RTMP pass=) > ?pass= dentro de query.
function extractJwt(b: Record<string, unknown>): string {
  const clean = (s: string) => s.replace(/^Bearer\s+/i, "").trim();
  let c = clean(str(b.token));
  if (!c) c = clean(str(b.password));
  if (!c) {
    try {
      c = clean(new URLSearchParams(str(b.query)).get("pass") ?? "");
    } catch { /* query ilegible */ }
  }
  return c;
}

// Regla pura (testeable): devuelve motivo de rechazo o null si se permite.
export function decide(user: AuthUser, action: string, rawPath: string): string | null {
  const m = PATH_RE.exec(rawPath.replace(/^\/+/, ""));
  if (!m) return "path";
  const meta = user?.app_metadata ?? {};
  const role = str(meta.role);
  if (action === "publish") {
    if (role !== "device") return "role";
    if (str(meta.device_id) !== m[1]) return "device";
    return null;
  }
  if (action === "read" || action === "playback") {
    return role === "viewer" || role === "admin" ? null : "role";
  }
  return "action";
}

export function makeHandler(deps: Deps) {
  return async (req: Request): Promise<Response> => {
    try {
      if (req.method !== "POST") return deny();
      const secret = deps.secret;
      if (!secret) return deny(); // sin secreto configurado: falla cerrada
      const given = new URL(req.url).searchParams.get("k") ??
        req.headers.get("x-media-auth-key") ?? "";
      if (!(await safeEqual(given, secret))) return deny();

      const raw = await req.text();
      if (raw.length > MAX_BODY) return deny();
      const body = JSON.parse(raw);
      if (!body || typeof body !== "object") return deny();

      const action = str(body.action);
      const path = str(body.path);
      // Acciones no soportadas o path invalido: no gastamos una llamada a Auth.
      if (!["publish", "read", "playback"].includes(action)) return deny();
      if (!PATH_RE.test(path.replace(/^\/+/, ""))) return deny();

      const jwt = extractJwt(body);
      if (jwt.length > 4096 || !JWT_RE.test(jwt)) return deny();

      const user = await deps.getUser(jwt);
      if (!user) return deny();

      const why = decide(user, action, path);
      if (why) {
        console.log(`media-auth deny: ${why} action=${action}`);
        return deny();
      }
      return allow();
    } catch {
      return deny();
    }
  };
}

// Cache corto (30 s) por hash del token: MediaMTX consulta varias veces por sesion.
const cache = new Map<string, { user: AuthUser; exp: number }>();
let client: ReturnType<typeof createClient> | null = null;

async function realGetUser(jwt: string): Promise<AuthUser> {
  const h = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(jwt))))
    .map((x) => x.toString(16).padStart(2, "0")).join("");
  const hit = cache.get(h);
  if (hit && hit.exp > Date.now()) return hit.user;
  client ??= createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data, error } = await client.auth.getUser(jwt);
  if (error || !data?.user) return null;
  if (cache.size > 200) cache.clear();
  cache.set(h, { user: data.user as AuthUser, exp: Date.now() + 30_000 });
  return data.user as AuthUser;
}

// MEDIA_AUTH_NO_SERVE=1 lo usa test.ts para importar sin levantar el servidor.
if (!Deno.env.get("MEDIA_AUTH_NO_SERVE")) {
  Deno.serve(makeHandler({
    getUser: realGetUser,
    secret: Deno.env.get("MEDIA_AUTH_SECRET"),
  }));
}
