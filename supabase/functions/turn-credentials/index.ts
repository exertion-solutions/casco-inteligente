// Edge Function turn-credentials (Supabase, Deno). Ver docs/PROTOCOLO-VOZ.md seccion 2.
// El visor (navegador) y el casco la llaman con su JWT de Supabase (Authorization: Bearer)
// y reciben credenciales TURN temporales (estilo REST de coturn `use-auth-secret`):
//   username   = "<expiracion_unix>:<user_id corto>"
//   credential = base64(HMAC-SHA1(TURN_SECRET, username))
// Un solo archivo para poder pegarlo en el dashboard.
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY (los inyecta Supabase), TURN_SECRET y TURN_HOST
// (los cargas vos), ALLOWED_ORIGIN (opcional, por defecto https://exertion-solutions.github.io).
// Sin service_role. No se loguean tokens. TURN_SECRET nunca sale en la respuesta.

export type AuthUser = { id?: string; app_metadata?: Record<string, unknown> } | null;
export interface Deps {
  getUser: (jwt: string) => Promise<AuthUser>;
  secret: string | undefined; // TURN_SECRET
  host: string | undefined; // TURN_HOST (IP publica o dominio del VPS)
  origin?: string; // ALLOWED_ORIGIN
  now?: () => number; // ms; inyectable para tests
}

export const DEFAULT_ORIGIN = "https://exertion-solutions.github.io";
const TTL = 3600;
const PORT = 3478;
const ROLES = ["device", "viewer", "admin"];
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/; // IPv4 o nombre DNS

const enc = new TextEncoder();

// HMAC-SHA1 en base64 (formato que espera coturn).
export async function hmacSha1B64(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  let s = "";
  for (const b of sig) s += String.fromCharCode(b);
  return btoa(s);
}

export function makeHandler(deps: Deps) {
  const origin = deps.origin || DEFAULT_ORIGIN;
  const now = deps.now ?? Date.now;
  const cors = {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, apikey, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "600",
    "vary": "Origin",
  };
  // Errores: sin cuerpo (no revelar detalles). Siempre con CORS para que el navegador vea el estado.
  const empty = (status: number) => new Response(null, { status, headers: cors });

  return async (req: Request): Promise<Response> => {
    try {
      if (req.method === "OPTIONS") return empty(204);
      if (req.method !== "GET" && req.method !== "POST") return empty(405);

      const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
      const jwt = m ? m[1] : "";
      if (jwt.length > 4096 || !JWT_RE.test(jwt)) return empty(401);

      let user: AuthUser = null;
      try {
        user = await deps.getUser(jwt);
      } catch { /* auth caido o token ilegible: tratar como no autenticado */ }
      if (!user) return empty(401);

      const role = user.app_metadata?.role;
      if (typeof role !== "string" || !ROLES.includes(role)) return empty(403);

      const uid = String(user.id ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
      if (!uid) return empty(401);

      // Mal configurado: falla cerrada (y no dice cual secreto falta).
      if (!deps.secret || !deps.host || !HOST_RE.test(deps.host)) {
        console.log("turn-credentials: configuracion incompleta (TURN_SECRET/TURN_HOST)");
        return empty(500);
      }

      const exp = Math.floor(now() / 1000) + TTL;
      const username = `${exp}:${uid}`;
      const credential = await hmacSha1B64(deps.secret, username);
      const h = `${deps.host}:${PORT}`;
      return new Response(
        JSON.stringify({
          urls: [`stun:${h}`, `turn:${h}?transport=udp`, `turn:${h}?transport=tcp`],
          username,
          credential,
          ttl: TTL,
        }),
        { status: 200, headers: { ...cors, "content-type": "application/json", "cache-control": "no-store" } },
      );
    } catch {
      return empty(500);
    }
  };
}

let client: unknown = null;

async function realGetUser(jwt: string): Promise<AuthUser> {
  // Import dinamico: los tests (que no usan Supabase real) no necesitan el paquete.
  const { createClient } = await import("npm:@supabase/supabase-js@2");
  client ??= createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (client as any).auth.getUser(jwt);
  if (error || !data?.user) return null;
  return data.user as AuthUser;
}

// TURN_NO_SERVE=1 lo usa test.ts para importar sin levantar el servidor.
if (!Deno.env.get("TURN_NO_SERVE")) {
  Deno.serve(makeHandler({
    getUser: realGetUser,
    secret: Deno.env.get("TURN_SECRET"),
    host: Deno.env.get("TURN_HOST"),
    origin: Deno.env.get("ALLOWED_ORIGIN") || undefined,
  }));
}
