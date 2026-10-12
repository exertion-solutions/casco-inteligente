-- Casco Inteligente: programa la funcion `escalate` cada minuto (pg_cron + pg_net).
-- Ejecutar en Supabase > SQL Editor, DESPUES de: migrations/005_centro.sql y de publicar la
-- Edge Function `escalate` (supabase/functions/escalate/README.md). Idempotente.
--
-- Por que NO esta dentro de ejecutar-todo.sql ni de 005: necesita extensiones que se habilitan
-- aparte y un secreto que no puede estar en el repo (es publico).
--
-- Donde vive el secreto: en Supabase Vault (vault.secrets, cifrado en reposo). Alternativas descartadas:
--   * escribirlo dentro del comando de cron.schedule: queda en texto plano en cron.job (legible
--     por cualquiera con acceso a esa tabla) y en este archivo del repo publico.
--   * `alter database ... set app.xxx`: el hosted no siempre permite el ALTER y el valor queda en
--     la configuracion de la base, sin cifrar.
-- El comando programado lee el secreto de Vault en cada ejecucion, asi que rotarlo = actualizar
-- Vault (paso 2), sin reprogramar.

-- ---------------------------------------------------------------------------
-- 1. Extensiones (si da error de permisos: Database > Extensions > activar pg_cron y pg_net)
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------------
-- 2. Guardar el secreto en Vault. EJECUTAR UNA VEZ, EN UNA CONSULTA APARTE, con el valor real
--    de ESCALATE_SECRET (el mismo que cargaste en Edge Functions > Secrets), y NO guardar ese
--    texto en ningun archivo. Para rotarlo, repetir con el valor nuevo (actualiza si ya existe).
--
--   do $$
--   declare v_id uuid;
--   begin
--     select id into v_id from vault.secrets where name = 'escalate_secret';
--     if v_id is null then
--       perform vault.create_secret('PEGAR-AQUI-EL-SECRETO', 'escalate_secret');
--     else
--       perform vault.update_secret(v_id, 'PEGAR-AQUI-EL-SECRETO');
--     end if;
--   end $$;
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 3. Programar (desprograma antes de reprogramar). Falla con un mensaje claro si falta el
--    secreto en Vault, en vez de dejar un cron que falla en silencio.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'escalate_secret') then
    raise exception 'Falta el secreto en Vault: ejecuta antes el paso 2 (vault.create_secret ... ''escalate_secret'')';
  end if;

  perform cron.unschedule(jobid) from cron.job where jobname in ('casco-escalate', 'casco-purge-cron-log');

  perform cron.schedule(
    'casco-escalate',
    '* * * * *',  -- cada minuto
    $job$
    select net.http_post(
      url     := 'https://zgfvhjpdzkohouktakvt.supabase.co/functions/v1/escalate',
      headers := jsonb_build_object(
                   'content-type', 'application/json',
                   'x-escalate-key', (select decrypted_secret from vault.decrypted_secrets
                                       where name = 'escalate_secret' limit 1)),
      body    := '{}'::jsonb,
      timeout_milliseconds := 20000
    );
    $job$
  );

  -- El historial de cron crece sin limite: conservar 7 dias.
  perform cron.schedule(
    'casco-purge-cron-log',
    '20 3 * * *',
    $job$delete from cron.job_run_details where end_time < now() - interval '7 days'$job$
  );
end $$;

-- ---------------------------------------------------------------------------
-- 4. Verificar (ejecutar a mano)
-- ---------------------------------------------------------------------------
-- select jobname, schedule, active from cron.job where jobname like 'casco-%';
-- Ultimas ejecuciones del cron (status = succeeded solo significa que se envio la peticion):
-- select status, return_message, start_time from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'casco-escalate')
--   order by start_time desc limit 5;
-- Respuesta real de la funcion (status_code 200 = bien, 401 = secreto distinto, 503 = falta webhook):
-- select status_code, content::text, created from net._http_response order by created desc limit 5;
--
-- Pausar / reanudar sin borrar:  update cron.job set active = false where jobname = 'casco-escalate';
-- Quitar del todo:               select cron.unschedule('casco-escalate');
