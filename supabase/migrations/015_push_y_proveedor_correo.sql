-- Avisos: push del navegador (Web Push, VAPID) + correo por proveedor HTTP (Brevo / Resend), sin SMTP. ADITIVA sobre 014. Idempotente.
-- Ver docs/PROTOCOLO-AVISOS.md. Ejecutar en Supabase > SQL Editor (despues de 014).
--
--   push_subscriptions : una fila por dispositivo (endpoint). Cada usuario (viewer/admin/auditor) lee y borra SOLO las suyas; admin lee todas.
--                        Se dan de alta / actualizan SOLO por la rpc push_subscribe (security definer: reasigna el dispositivo al usuario que lo activa).
--                        La Edge Function las lee con service_role y borra las que devuelven 404/410.
--   notify_config      : + vapid_public / vapid_private (el par ECDSA P-256 lo genera la funcion con {bootstrap_push:true}; la privada
--                        no tiene acceso por API), + email_provider / email_api_key (write-only) / email_from / email_from_name.
--   notify_push_key()  : devuelve vapid_public a viewer/admin/auditor (lo necesita el navegador para suscribirse).
--   notify_set_email() : solo admin; valida y guarda el proveedor; nunca devuelve la clave.
--   notify_log.results : resultado por destinatario {"<correo>": {ok, ch, d}, "push": {sent, failed, gone}}; la funcion solo reintenta
--                        los destinatarios que fallaron (el job de 014 reintenta cada minuto, maximo 5 intentos).
-- ¡No guardar claves ni correos reales en este archivo (el repo es publico)!

-- ===========================================================================
-- 1. notify_config: VAPID y proveedor de correo
-- ===========================================================================
alter table public.notify_config add column if not exists vapid_public     text;
alter table public.notify_config add column if not exists vapid_private    text;
alter table public.notify_config add column if not exists email_provider   text;
alter table public.notify_config add column if not exists email_api_key    text;
alter table public.notify_config add column if not exists email_from       text;
alter table public.notify_config add column if not exists email_from_name  text;

do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'notify_config_email_provider_ck') then
    alter table public.notify_config add constraint notify_config_email_provider_ck
      check (email_provider is null or email_provider in ('brevo','resend'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'notify_config_email_from_ck') then
    alter table public.notify_config add constraint notify_config_email_from_ck
      check (email_from is null or (length(email_from) <= 254 and email_from ~ '^[A-Za-z0-9._%+''-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'notify_config_email_from_name_ck') then
    alter table public.notify_config add constraint notify_config_email_from_name_ck
      check (email_from_name is null or (length(email_from_name) <= 100 and email_from_name !~ '[[:cntrl:]]'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'notify_config_email_api_key_ck') then
    alter table public.notify_config add constraint notify_config_email_api_key_ck
      check (email_api_key is null or (length(email_api_key) between 10 and 300 and email_api_key !~ '[[:space:]]'));
  end if;
end $do$;

-- Los grants de 014 por columna no incluyen estas columnas: ni el admin las lee ni las escribe por la API (solo las rpc).
grant select, update on public.notify_config to service_role;

-- ===========================================================================
-- 2. notify_log: resultado por destinatario
-- ===========================================================================
alter table public.notify_log add column if not exists results jsonb not null default '{}'::jsonb;

-- ===========================================================================
-- 3. push_subscriptions
-- ===========================================================================
create table if not exists public.push_subscriptions (
  endpoint     text primary key check (endpoint ~ '^https://[^[:space:]]+$' and length(endpoint) <= 1000),
  user_id      uuid not null default auth.uid(),
  p256dh       text not null check (length(p256dh) between 20 and 200),
  auth         text not null check (length(auth) between 8 and 100),
  ua           text check (ua is null or length(ua) <= 200),
  min_severity text not null default 'alta' check (min_severity in ('critica','alta','media')),
  created_at   timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon;
revoke all on public.push_subscriptions from authenticated;
grant select, delete on public.push_subscriptions to authenticated;
grant update (min_severity) on public.push_subscriptions to authenticated;
grant select, delete on public.push_subscriptions to service_role;

drop policy if exists push_sub_select on public.push_subscriptions;
create policy push_sub_select on public.push_subscriptions
  for select to authenticated
  using (public.jwt_role() = 'admin'
         or (public.jwt_role() in ('viewer','auditor') and user_id = auth.uid()));

drop policy if exists push_sub_update on public.push_subscriptions;
create policy push_sub_update on public.push_subscriptions
  for update to authenticated
  using (public.jwt_role() in ('viewer','admin','auditor') and user_id = auth.uid())
  with check (public.jwt_role() in ('viewer','admin','auditor') and user_id = auth.uid());

drop policy if exists push_sub_delete on public.push_subscriptions;
create policy push_sub_delete on public.push_subscriptions
  for delete to authenticated
  using (public.jwt_role() in ('viewer','admin','auditor') and user_id = auth.uid());

-- Alta / actualizacion de un dispositivo. El endpoint es unico: si otro usuario ya lo tenia (mismo navegador, otra cuenta) pasa al que lo activa.
create or replace function public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_ua text, p_min text)
returns boolean
language plpgsql security definer set search_path = '' as $fn$
declare u uuid := auth.uid();
begin
  if coalesce(public.jwt_role(), '') not in ('viewer','admin','auditor') or u is null then
    raise exception 'push_subscribe: rol no autorizado' using errcode = '42501';
  end if;
  if (select count(*) from public.push_subscriptions where user_id = u and endpoint <> p_endpoint) >= 10 then
    raise exception 'push_subscribe: maximo 10 dispositivos por usuario' using errcode = '54000';
  end if;
  insert into public.push_subscriptions (endpoint, user_id, p256dh, auth, ua, min_severity)
  values (p_endpoint, u, p_p256dh, p_auth, left(p_ua, 200), coalesce(nullif(p_min, ''), 'alta'))
  on conflict (endpoint) do update
     set user_id = u, p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua, min_severity = excluded.min_severity;
  return true;
end $fn$;
revoke all on function public.push_subscribe(text, text, text, text, text) from public, anon;
grant execute on function public.push_subscribe(text, text, text, text, text) to authenticated;

-- ===========================================================================
-- 4. Clave publica VAPID (la usa el navegador para suscribirse)
-- ===========================================================================
create or replace function public.notify_push_key() returns text
language plpgsql stable security definer set search_path = '' as $fn$
begin
  if coalesce(public.jwt_role(), '') not in ('viewer','admin','auditor') then
    raise exception 'notify_push_key: rol no autorizado' using errcode = '42501';
  end if;
  return (select vapid_public from public.notify_config where id = 1);
end $fn$;
revoke all on function public.notify_push_key() from public, anon;
grant execute on function public.notify_push_key() to authenticated;

-- ===========================================================================
-- 5. Proveedor de correo (solo admin; la clave es de solo escritura)
-- ===========================================================================
-- p_provider vacio = quitar proveedor (borra clave y remitente). p_api_key vacio = conservar la guardada (para cambiar solo el remitente).
create or replace function public.notify_set_email(p_provider text, p_api_key text, p_from text, p_from_name text)
returns boolean
language plpgsql security definer set search_path = '' as $fn$
declare
  pr text := nullif(lower(btrim(coalesce(p_provider, ''))), '');
  k  text := nullif(btrim(coalesce(p_api_key, '')), '');
  f  text := nullif(lower(btrim(coalesce(p_from, ''))), '');
  n  text := nullif(btrim(coalesce(p_from_name, '')), '');
  cur text;
begin
  if coalesce(public.jwt_role(), '') <> 'admin' then
    raise exception 'notify_set_email: solo un admin' using errcode = '42501';
  end if;
  if pr is null then
    update public.notify_config set email_provider = null, email_api_key = null, email_from = null, email_from_name = null where id = 1;
    return false;
  end if;
  if pr not in ('brevo','resend') then
    raise exception 'notify_set_email: proveedor invalido (brevo o resend)' using errcode = '22023';
  end if;
  select email_api_key into cur from public.notify_config where id = 1;
  k := coalesce(k, cur);
  if k is null or length(k) not between 10 and 300 or k ~ '[[:space:]]' then
    raise exception 'notify_set_email: falta la clave de API (10 a 300 caracteres, sin espacios)' using errcode = '22023';
  end if;
  if f is null or length(f) > 254 or f !~ '^[A-Za-z0-9._%+''-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' then
    raise exception 'notify_set_email: remitente invalido' using errcode = '22023';
  end if;
  if n is not null and (length(n) > 100 or n ~ '[[:cntrl:]]') then
    raise exception 'notify_set_email: nombre del remitente invalido' using errcode = '22023';
  end if;
  update public.notify_config
     set email_provider = pr, email_api_key = k, email_from = f, email_from_name = n
   where id = 1;
  return true;
end $fn$;
revoke all on function public.notify_set_email(text, text, text, text) from public, anon;
grant execute on function public.notify_set_email(text, text, text, text) to authenticated;

-- ===========================================================================
-- 6. notify_status (reemplaza la de 014; mismos campos + push/correo)
-- ===========================================================================
create or replace function public.notify_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $fn$
declare
  r   text := public.jwt_role();
  u   uuid := auth.uid();
  c   public.notify_config%rowtype;
  res jsonb;
begin
  if coalesce(r, '') not in ('viewer','admin','auditor') then
    raise exception 'notify_status: rol no autorizado' using errcode = '42501';
  end if;
  select * into c from public.notify_config where id = 1;
  res := jsonb_build_object(
    'ready', coalesce(c.enabled, false) and coalesce(c.webhook_secret, '') <> '',
    'push_ok', coalesce(c.vapid_public, '') <> '',
    'my_devices', (select count(*) from public.push_subscriptions where user_id = u));
  if r = 'admin' then
    res := res || jsonb_build_object(
      'enabled', coalesce(c.enabled, false),
      'secret_ok', coalesce(c.webhook_secret, '') <> '',
      'channel_ok', coalesce(c.webhook_url, '') <> '',
      'from_ok', coalesce(c.resend_from, '') <> '',
      'email_ok', coalesce(c.email_provider, '') <> '' and coalesce(c.email_api_key, '') <> '' and coalesce(c.email_from, '') <> '',
      'email_provider', c.email_provider,
      'email_from', c.email_from,
      'email_from_name', c.email_from_name,
      'push_devices', (select count(*) from public.push_subscriptions),
      'recipients', (select count(*) from public.notify_recipients where active),
      'remind_after_s', c.remind_after_s,
      'cooldown_s', c.cooldown_s);
  end if;
  return res;
end $fn$;
revoke all on function public.notify_status() from public, anon;
grant execute on function public.notify_status() to authenticated;
