-- Casco Inteligente: configuracion de los avisos por correo. EJEMPLO.
-- Este archivo es de un repo PUBLICO: los correos y la clave de aca son de mentira (ejemplo.com).
-- Copiar el contenido al SQL Editor de Supabase, reemplazar los valores y ejecutar ahi. NO guardar los reales en el repo.
-- Opcional: casi todo se hace desde el visor (Constancias > Empleador > Avisos por correo). Requiere migrations/014_avisos_correo.sql. Ver docs/PROTOCOLO-AVISOS.md.
-- El SQL Editor corre sin JWT, asi que pasa las guardas de "solo admin" y puede cargar el secreto (la API no puede).

-- 1. La clave interna se genera sola (el visor llama a notify_bootstrap()); aca no hace falta cargarla.
--    El canal (URL del flujo de Power Automate / Make / Zapier) se carga desde el visor, o aca (valor de ejemplo):
-- update public.notify_config set webhook_url = 'https://flujo.ejemplo.com/PEGAR-AQUI-LA-URL-DEL-FLUJO' where id = 1;

-- 1b. Proveedor de correo (migracion 015). Mejor desde el visor (la clave de API no se guarda en ningun archivo). Por SQL, con la rpc
--     (solo admin con sesion; desde el SQL Editor sin JWT usar un update directo a notify_config). Valores de ejemplo:
-- select public.notify_set_email('brevo', 'PEGAR-AQUI-LA-CLAVE-DE-API', 'avisos@ejemplo.com', 'Casco Inteligente');

-- 2. Destinatarios. min_severity: 'critica' (solo SOS y caidas), 'alta' (+ sin movimiento y zona de peligro; es el valor por defecto)
--    o 'media' (+ casco sin usar y zonas restringidas). El correo va en minusculas y sin espacios.
insert into public.notify_recipients (email, min_severity) values
  ('nombre@ejemplo.com',     'alta'),
  ('supervisor@ejemplo.com', 'critica'),
  ('seguridad@ejemplo.com',  'media')
on conflict (email) do update set active = true, min_severity = excluded.min_severity;

-- 3. Tiempos (opcionales). remind_after_s: segundos sin atender antes del recordatorio (30..86400).
--    cooldown_s: un aviso del mismo tipo por casco cada tantos segundos (0 = sin limite).
update public.notify_config set remind_after_s = 180, cooldown_s = 300 where id = 1;

-- 4. Activar (o hacerlo desde el visor: Constancias > Empleador > Avisos por correo). Probar antes con el boton "Enviar correo de prueba".
-- update public.notify_config set enabled = true where id = 1;

-- Ver que paso:
--   select event_id, kind, status, attempts, channel, recipients, detail, sent_at from public.notify_log order by sent_at desc limit 20;
--   select status_code, content::text, created from net._http_response order by created desc limit 5;
-- Pausar a una persona sin borrarla:  update public.notify_recipients set active = false where email = 'nombre@ejemplo.com';
-- Apagar todo:                        update public.notify_config set enabled = false where id = 1;
