-- Avisos por correo de alertas (SOS, caida, zonas, sin movimiento) aunque nadie mire el panel.
-- Ver docs/PROTOCOLO-AVISOS.md (contrato y despliegue). Idempotente. Ejecutar en Supabase > SQL Editor (despues de 013).
--
-- Flujo:
--   1. Un casco inserta un evento critico/alto  ->  trigger AFTER INSERT en events  ->  pg_net llama a la Edge Function `notify`
--      con el secreto en la cabecera x-notify-secret  ->  la funcion arma el correo y lo manda (webhook o Resend).
--   2. pg_cron cada minuto (notify_reminders): alertas criticas/altas SIN atender (sin fila en event_acks) pasados
--      remind_after_s segundos  ->  un recordatorio por evento. Tambien reintenta envios que quedaron en error.
--   La funcion respeta cooldown_s (un aviso del mismo tipo por casco cada cooldown_s) y es idempotente por (event_id, kind).
--
-- Seguridad:
--   * notify_config / notify_recipients: SOLO admin (RLS + aa_admin_only_trg de 010). webhook_secret no tiene grant de
--     SELECT ni UPDATE para nadie via API: se carga desde el SQL Editor (ver avisos_config.EJEMPLO.sql). Los correos de los
--     destinatarios tampoco son legibles por viewer/auditor/device.
--   * notify_status() (security definer): viewer/admin/auditor saben si el aviso esta activado; solo admin ve el detalle.
--   * El trigger NUNCA bloquea el insert de un evento: todo va envuelto en exception when others (solo emite un warning).
--   * notify_log: la escribe la Edge Function (service_role). Admin la lee.
--
-- Severidad (misma que sevOf de web/app.js): 3 critica (sos, fall), 2 alta (inactive, geofence peligro/enter),
-- 1 media (not_worn, geofence restringida/enter, permitida/exit). El trigger avisa desde nivel media; cada destinatario
-- elige desde que nivel quiere recibir (min_severity, por defecto 'alta'). Los recordatorios solo para criticas/altas.
-- ¡No guardar correos reales ni secretos en este archivo (el repo es publico)!

-- ===========================================================================
-- 0. Extensiones (si no se pueden crear desde SQL: Database > Extensions > activar pg_net y pg_cron)
-- ===========================================================================
do $do$
begin
  create extension if not exists pg_net with schema extensions;
exception when others then
  raise notice 'pg_net no disponible (%): activarla en Database > Extensions; sin ella no salen avisos', sqlerrm;
end $do$;

do $do$
begin
  create extension if not exists pg_cron;
exception when others then
  raise notice 'pg_cron no disponible (%): activarla en Database > Extensions; sin ella no hay recordatorios', sqlerrm;
end $do$;

-- ===========================================================================
-- 1. notify_config (fila unica)
-- ===========================================================================
create table if not exists public.notify_config (
  id             integer primary key default 1 check (id = 1),
  enabled        boolean not null default false,
  webhook_secret text,
  webhook_url    text check (webhook_url is null or (webhook_url ~ '^https://[^[:space:]]+$' and length(webhook_url) <= 500)),
  resend_from    text check (resend_from is null or (length(resend_from) between 3 and 200 and resend_from !~ '[[:cntrl:]]')),
  remind_after_s integer not null default 180 check (remind_after_s between 30 and 86400),
  cooldown_s     integer not null default 300 check (cooldown_s between 0 and 86400),
  updated_at     timestamptz not null default now()
);
-- (por si la tabla se creo con una version anterior de esta migracion)
alter table public.notify_config add column if not exists webhook_url text
  check (webhook_url is null or (webhook_url ~ '^https://[^[:space:]]+$' and length(webhook_url) <= 500));
alter table public.notify_config add column if not exists resend_from text
  check (resend_from is null or (length(resend_from) between 3 and 200 and resend_from !~ '[[:cntrl:]]'));
insert into public.notify_config (id) values (1) on conflict (id) do nothing;

create or replace function public.notify_config_touch() returns trigger
language plpgsql security definer set search_path = '' as $fn$
begin
  new.updated_at := now();
  return new;
end $fn$;
revoke all on function public.notify_config_touch() from public, anon, authenticated;

drop trigger if exists notify_config_touch_trg on public.notify_config;
create trigger notify_config_touch_trg before update on public.notify_config
  for each row execute function public.notify_config_touch();

drop trigger if exists aa_admin_only_trg on public.notify_config;
create trigger aa_admin_only_trg before insert or update on public.notify_config
  for each row execute function public.admin_only_guard();

alter table public.notify_config enable row level security;
revoke all on public.notify_config from anon;
revoke all on public.notify_config from authenticated;
-- Sin webhook_secret, webhook_url ni resend_from en SELECT: el admin no los lee por la API. webhook_secret tampoco se escribe
-- (lo genera notify_bootstrap o se carga desde el SQL Editor); webhook_url y resend_from el admin SI los escribe (solo escritura).
grant select (id, enabled, remind_after_s, cooldown_s, updated_at) on public.notify_config to authenticated;
grant update (enabled, remind_after_s, cooldown_s, webhook_url, resend_from) on public.notify_config to authenticated;
grant select on public.notify_config to service_role;

drop policy if exists notify_config_select_admin on public.notify_config;
create policy notify_config_select_admin on public.notify_config
  for select to authenticated using (public.jwt_role() = 'admin');

drop policy if exists notify_config_update_admin on public.notify_config;
create policy notify_config_update_admin on public.notify_config
  for update to authenticated
  using (public.jwt_role() = 'admin')
  with check (public.jwt_role() = 'admin');
-- Sin INSERT ni DELETE via API: la fila (id = 1) ya existe.

-- ===========================================================================
-- 2. notify_recipients
-- ===========================================================================
create table if not exists public.notify_recipients (
  email        text primary key
               check (email = lower(email) and length(email) <= 254
                      and email ~ '^[A-Za-z0-9._%+''-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
  active       boolean not null default true,
  min_severity text not null default 'alta' check (min_severity in ('critica','alta','media')),
  created_at   timestamptz not null default now()
);

drop trigger if exists aa_admin_only_trg on public.notify_recipients;
create trigger aa_admin_only_trg before insert or update on public.notify_recipients
  for each row execute function public.admin_only_guard();

alter table public.notify_recipients enable row level security;
revoke all on public.notify_recipients from anon;
revoke all on public.notify_recipients from authenticated;
grant select on public.notify_recipients to authenticated;
grant insert (email, active, min_severity) on public.notify_recipients to authenticated;
grant update (active, min_severity) on public.notify_recipients to authenticated;
grant delete on public.notify_recipients to authenticated;
grant select on public.notify_recipients to service_role;

drop policy if exists notify_rec_select_admin on public.notify_recipients;
create policy notify_rec_select_admin on public.notify_recipients
  for select to authenticated using (public.jwt_role() = 'admin');

drop policy if exists notify_rec_insert_admin on public.notify_recipients;
create policy notify_rec_insert_admin on public.notify_recipients
  for insert to authenticated with check (public.jwt_role() = 'admin');

drop policy if exists notify_rec_update_admin on public.notify_recipients;
create policy notify_rec_update_admin on public.notify_recipients
  for update to authenticated
  using (public.jwt_role() = 'admin')
  with check (public.jwt_role() = 'admin');

drop policy if exists notify_rec_delete_admin on public.notify_recipients;
create policy notify_rec_delete_admin on public.notify_recipients
  for delete to authenticated using (public.jwt_role() = 'admin');

-- ===========================================================================
-- 3. notify_log (idempotencia + registro de resultado). La escribe la Edge Function (service_role).
-- ===========================================================================
create table if not exists public.notify_log (
  id         bigint generated always as identity primary key,
  event_id   uuid not null references public.events(id) on delete cascade,
  kind       text not null check (kind in ('inmediato','recordatorio')),
  status     text not null default 'enviando' check (status in ('enviando','ok','error')),
  attempts   integer not null default 1,
  channel    text,
  recipients integer,
  detail     text,
  sent_at    timestamptz not null default now(),
  unique (event_id, kind)
);
create index if not exists notify_log_retry_idx on public.notify_log (sent_at) where status <> 'ok';

alter table public.notify_log enable row level security;
revoke all on public.notify_log from anon;
revoke all on public.notify_log from authenticated;
grant select on public.notify_log to authenticated;
grant select, insert, update on public.notify_log to service_role;

drop policy if exists notify_log_select_admin on public.notify_log;
create policy notify_log_select_admin on public.notify_log
  for select to authenticated using (public.jwt_role() = 'admin');

-- Reserva atomica (evento, tipo). true = este proceso debe enviar. false = ya enviado, o lo tiene otro proceso.
-- Un envio en error o colgado ('enviando' hace mas de 60 s) se retoma hasta 5 intentos.
create or replace function public.notify_claim(p_event uuid, p_kind text) returns boolean
language plpgsql security definer set search_path = '' as $fn$
declare n integer;
begin
  insert into public.notify_log (event_id, kind) values (p_event, p_kind)
  on conflict (event_id, kind) do update
     set status = 'enviando', attempts = public.notify_log.attempts + 1, sent_at = now(), detail = 'reintento'
   where public.notify_log.status in ('error','enviando')
     and public.notify_log.sent_at < now() - interval '60 seconds'
     and public.notify_log.attempts < 5;
  get diagnostics n = row_count;
  return n = 1;
end $fn$;
revoke all on function public.notify_claim(uuid, text) from public, anon, authenticated;
grant execute on function public.notify_claim(uuid, text) to service_role;

-- ===========================================================================
-- 4. Severidad, llamada a la funcion y trigger
-- ===========================================================================
create or replace function public.notify_severity(p_type text, p_payload jsonb) returns integer
language sql immutable set search_path = '' as $fn$
  select case
    when p_type in ('sos','fall') then 3
    when p_type = 'inactive' then 2
    when p_type = 'not_worn' then 1
    when p_type = 'geofence' then
      case when p_payload ->> 'kind' = 'peligro'     and p_payload ->> 'action' = 'enter' then 2
           when p_payload ->> 'kind' = 'restringida' and p_payload ->> 'action' = 'enter' then 1
           when p_payload ->> 'kind' = 'permitida'   and p_payload ->> 'action' = 'exit'  then 1
           else 0 end
    else 0 end
$fn$;
revoke all on function public.notify_severity(text, jsonb) from public, anon, authenticated;

-- Unico lugar con la URL de la funcion (el ref del proyecto ya figura en cron_escalate.sql).
create or replace function public.notify_post(p_secret text, p_body jsonb) returns void
language plpgsql security definer set search_path = '' as $fn$
begin
  perform net.http_post(
    url     := 'https://zgfvhjpdzkohouktakvt.supabase.co/functions/v1/notify',
    headers := jsonb_build_object('content-type', 'application/json', 'x-notify-secret', p_secret),
    body    := p_body,
    timeout_milliseconds := 10000
  );
end $fn$;
revoke all on function public.notify_post(text, jsonb) from public, anon, authenticated;

create or replace function public.notify_on_event() returns trigger
language plpgsql security definer set search_path = '' as $fn$
declare c public.notify_config%rowtype;
begin
  begin
    if public.notify_severity(new.type, new.payload) >= 1 then
      select * into c from public.notify_config where id = 1;
      if found and c.enabled and coalesce(c.webhook_secret, '') <> '' then
        perform public.notify_post(c.webhook_secret,
          jsonb_build_object('event_id', new.id, 'kind', 'inmediato'));
      end if;
    end if;
  exception when others then
    raise warning 'notify_on_event: % (el evento se guardo igual)', sqlerrm;
  end;
  return null;
end $fn$;
revoke all on function public.notify_on_event() from public, anon, authenticated;

drop trigger if exists notify_events_trg on public.events;
create trigger notify_events_trg after insert on public.events
  for each row when (new.type in ('sos','fall','geofence','inactive','not_worn'))
  execute function public.notify_on_event();

-- ===========================================================================
-- 5. Recordatorios y reintentos (pg_cron, cada minuto)
-- ===========================================================================
create or replace function public.notify_reminders() returns integer
language plpgsql security definer set search_path = '' as $fn$
declare c public.notify_config%rowtype; r record; n integer := 0;
begin
  select * into c from public.notify_config where id = 1;
  if not found or not c.enabled or coalesce(c.webhook_secret, '') = '' then return 0; end if;
  for r in
    (select e.id as event_id, 'recordatorio'::text as kind
       from public.events e
      where e.type in ('sos','fall','geofence','inactive')
        and public.notify_severity(e.type, e.payload) >= 2
        and e.created_at <= now() - make_interval(secs => c.remind_after_s)
        and e.created_at >  now() - interval '60 minutes'
        and not exists (select 1 from public.event_acks a where a.event_id = e.id)
        and not exists (select 1 from public.notify_log l where l.event_id = e.id and l.kind = 'recordatorio')
      order by e.created_at limit 20)
    union all
    (select l.event_id, l.kind
       from public.notify_log l
      where l.status in ('error','enviando')
        and l.attempts < 5
        and l.sent_at <  now() - interval '90 seconds'
        and l.sent_at >  now() - interval '30 minutes'
        and not exists (select 1 from public.event_acks a where a.event_id = l.event_id)
      order by l.sent_at limit 20)
  loop
    begin
      perform public.notify_post(c.webhook_secret,
        jsonb_build_object('event_id', r.event_id, 'kind', r.kind));
      n := n + 1;
    exception when others then
      raise warning 'notify_reminders: %', sqlerrm;
    end;
  end loop;
  return n;
end $fn$;
revoke all on function public.notify_reminders() from public, anon, authenticated;

do $do$
begin
  if to_regnamespace('cron') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname = 'casco-notify-reminders';
    perform cron.schedule('casco-notify-reminders', '* * * * *', 'select public.notify_reminders()');
  else
    raise notice 'pg_cron no disponible: no se programo casco-notify-reminders (habilitar pg_cron y volver a ejecutar esta migracion)';
  end if;
exception when others then
  raise notice 'no se pudo programar casco-notify-reminders: %', sqlerrm;
end $do$;

-- ===========================================================================
-- 6. Estado para el visor (viewer/admin/auditor); el detalle solo lo ve admin
-- ===========================================================================
create or replace function public.notify_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $fn$
declare
  r   text := public.jwt_role();
  c   public.notify_config%rowtype;
  res jsonb;
begin
  if coalesce(r, '') not in ('viewer','admin','auditor') then
    raise exception 'notify_status: rol no autorizado' using errcode = '42501';
  end if;
  select * into c from public.notify_config where id = 1;
  res := jsonb_build_object('ready', coalesce(c.enabled, false) and coalesce(c.webhook_secret, '') <> '');
  if r = 'admin' then
    res := res || jsonb_build_object(
      'enabled', coalesce(c.enabled, false),
      'secret_ok', coalesce(c.webhook_secret, '') <> '',
      'channel_ok', coalesce(c.webhook_url, '') <> '',
      'from_ok', coalesce(c.resend_from, '') <> '',
      'recipients', (select count(*) from public.notify_recipients where active),
      'remind_after_s', c.remind_after_s,
      'cooldown_s', c.cooldown_s);
  end if;
  return res;
end $fn$;
revoke all on function public.notify_status() from public, anon;
grant execute on function public.notify_status() to authenticated;

-- ===========================================================================
-- 7. Puesta en marcha sin variables en el panel: clave generada en la base y canal guardado desde el visor (solo admin)
-- ===========================================================================
-- notify_bootstrap(): si webhook_secret esta vacio lo genera (2 uuid v4 = 64 hex de CSPRNG, sin depender de pgcrypto).
-- Idempotente. Devuelve true si la clave existe al terminar; NUNCA devuelve el valor.
create or replace function public.notify_bootstrap() returns boolean
language plpgsql security definer set search_path = '' as $fn$
begin
  if coalesce(public.jwt_role(), '') <> 'admin' then
    raise exception 'notify_bootstrap: solo un admin' using errcode = '42501';
  end if;
  update public.notify_config
     set webhook_secret = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
   where id = 1 and coalesce(webhook_secret, '') = '';
  return exists (select 1 from public.notify_config where id = 1 and coalesce(webhook_secret, '') <> '');
end $fn$;
revoke all on function public.notify_bootstrap() from public, anon;
grant execute on function public.notify_bootstrap() to authenticated;

-- notify_set_channel(url): guarda la URL del canal (Power Automate / Make / Zapier). Vacio = quitar. Solo https, <= 500.
create or replace function public.notify_set_channel(p_url text) returns boolean
language plpgsql security definer set search_path = '' as $fn$
declare u text := nullif(btrim(coalesce(p_url, '')), '');
begin
  if coalesce(public.jwt_role(), '') <> 'admin' then
    raise exception 'notify_set_channel: solo un admin' using errcode = '42501';
  end if;
  if u is not null and (u !~ '^https://[^[:space:]]+$' or length(u) > 500) then
    raise exception 'notify_set_channel: la URL debe empezar con https:// y tener hasta 500 caracteres' using errcode = '22023';
  end if;
  update public.notify_config set webhook_url = u where id = 1;
  return u is not null;
end $fn$;
revoke all on function public.notify_set_channel(text) from public, anon;
grant execute on function public.notify_set_channel(text) to authenticated;
grant select (webhook_secret, webhook_url, resend_from) on public.notify_config to service_role;
