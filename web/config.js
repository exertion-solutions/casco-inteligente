// Valores PUBLICOS por diseno (la seguridad la da RLS en Supabase, ver supabase/schema.sql).
// Nunca poner aqui la service_role key.
window.CASCO_CONFIG = {
  SUPABASE_URL: "https://zgfvhjpdzkohouktakvt.supabase.co",
  // Dominio del VPS con MediaMTX (sin esquema). Vacio = se oculta el video propio y queda el boton de Runde.
  LIVE_HOST: "216-238-110-97.sslip.io",
  // "runde": Camara en vivo abre caps.runde.pro. "own": panel de video propio (requiere que el casco transmita a LIVE_HOST).
  LIVE_MODE: "runde",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpnZnZoanBkemtvaG91a3Rha3Z0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3NTMyMTYsImV4cCI6MjEwNzMyOTIxNn0.tAg9V2xzmcAwGoBG4LdUBnEdHgPXbrIclUVW-iKCF2s"
};
