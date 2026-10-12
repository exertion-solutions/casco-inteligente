// Valores PUBLICOS por diseno (la seguridad la da RLS en Supabase, ver supabase/schema.sql).
// Nunca poner aqui la service_role key.
window.CASCO_CONFIG = {
  SUPABASE_URL: "https://zgfvhjpdzkohouktakvt.supabase.co",
  // Dominio del VPS con MediaMTX (sin esquema). Vacio = se oculta el video propio y queda el boton de Runde.
  LIVE_HOST: "216-238-110-97.sslip.io",
  // "runde": Camara en vivo abre caps.runde.pro. "own": panel de video propio (requiere que el casco transmita a LIVE_HOST).
  LIVE_MODE: "own",
  // Giro inicial de la imagen en grados (0/90/180/270) para el casco PUESTO (camara al frente).
  // Calibrado con el casco boca arriba en la mesa (270); puesto equivale a +180 = 90.
  // El boton Girar del visor lo recuerda por casco y navegador.
  // Recorte (fracciones del cuadro original) para ocultar el texto TM/ID/BT/TP/SS que la camara del casco graba en la imagen.
  // Con rotacion 0 el texto cae en la franja izquierda (~33 % del ancho). Quitar (poner todo en 0) si se desactiva en el casco.
  OVERLAY_CROP: { left: 0.34, top: 0, right: 0, bottom: 0 },
  // Llamada de voz en vivo (boton Hablar). false = el boton queda oculto.
  // Poner true SOLO cuando esten desplegados turn-credentials, rtc_signals y coturn (ver docs/PROTOCOLO-VOZ.md).
  VOICE_ENABLED: false,
  // Grabacion a la PC (boton Grabar) y Captura: true = estampa casco, fecha y hora en la imagen. false = sin marca.
  REC_WATERMARK: true,
  LIVE_ROTATION: 90,
  // Auto-orientacion (docs/PROTOCOLO-VOZ.md seccion 1): giro = (payload.rot del ultimo heartbeat + AUTO_ROT_OFFSET) % 360.
  // 0 por defecto. CALIBRAR con una pose conocida: si con el casco puesto la imagen sale girada N grados, poner N aqui.
  AUTO_ROT_OFFSET: 0,
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpnZnZoanBkemtvaG91a3Rha3Z0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3NTMyMTYsImV4cCI6MjEwNzMyOTIxNn0.tAg9V2xzmcAwGoBG4LdUBnEdHgPXbrIclUVW-iKCF2s"
};

