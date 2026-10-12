-- Centro de mando: escalamiento y ordenes a cascos (evacuacion/mensajes).
-- Ver docs/PROTOCOLO-CENTRO.md secciones 2 y 4. (La grabacion es solo en el navegador: no hay tablas de clips.)
-- Idempotente. Ejecutar en Supabase > SQL Editor (despues de schema.sql, 002, 003 y 004).
--
-- Resumen de permisos (la anon key es publica; toda la seguridad esta aqui):
--   escalation_rules : viewer/admin leen; SOLO admin inserta/actualiza (sin DELETE: se desactiva con enabled=false).
--   escalations      : viewer/admin leen; nadie escribe via API. La escribe la Edge Function `escalate`
--                      con service_role (ver nota abajo).
--   broadcasts       : viewer/admin insertan (kind,message,device_ids,repeat) y leen; device lee solo los
--                      de los ultimos 2 min dirigidos a el (device_ids null o que lo incluya). Sin UPDATE/DELETE.
--   broadcast_acks   : device inserta SOLO con su device_id y SOLO de broadcasts que puede ver; viewer/admin leen.
--   Todos los campos de autoria/fecha (created_at, created_by, created_by_email, played_at)
--   los fija un trigger SECURITY DEFINER desde el JWT; el cliente no puede falsearlos.
--
-- Nota service_role (tabla escalations): la funcion `escalate` la lanza pg_cron sin ningun usuario, asi que
-- no hay un JWT de supervisor con el cual escribir. Usa SUPABASE_SERVICE_ROLE_KEY, que Supabase INYECTA en el
-- entorno de la Edge Function: nunca esta en el repo, ni en el cliente, ni se copia a mano. Se justifica porque
-- (1) la tabla es un log de sistema que ningun usuario debe poder escribir (si un viewer pudiera insertar una
-- fila "ok=true" silenciaria la escalacion de una alerta real) y (2) la funcion esta protegida por un secreto
-- de cabecera comparado en tiempo constante y falla cerrada. La funcion solo toca 4 tablas (ver README).

-- ---------------------------------------------------------------------------
-- events.type: ampliar con 'location' y 'geofence' (docs/PROTOCOLO-GEO.md).
-- NOT VALID: no revalida filas viejas, si valida toda fila nueva.
-- (schema.sql ya trae la misma lista; se repite aqui para bases creadas antes.)
-- ---------------------------------------------------------------------------
alter table public.events drop constraint if exists events_type_check;
alter table public.events add constraint events_type_check
  check (type in ('sos','photo','video','heartbeat','fall','location','geofence')) not valid;

-- ===========================================================================
-- 1. escalation_rules  (regla global; editable solo por admin)
-- ===========================================================================
create table if not exists public.escalation_rules (
  id               uuid primary key default gen_random_uuid(),
  after_seconds    integer not null default 60
                   check (after_seconds between 0 and 3600),
  channel          text not null default 'teams' check (channel in ('teams')),
  enabled          boolean not null default false,
  -- Placeholders: {tipo} {device_id} {motivo} {edad} {mapa}
  message_template text not null
                   default 'ALERTA {tipo} sin atender: casco {device_id}. {motivo}. Hace {edad}. {mapa}'
                   check (length(message_template) between 1 and 500
                          and message_template !~ '[[:cntrl:]]'),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  updated_by       uuid
);

-- Trigger: fija updated_at/updated_by y limita a 10 reglas (cada regla habilitada puede
-- generar una notificacion por alerta: tope contra spam al webhook).
create or replace function public.escalation_rules_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  if tg_op = 'INSERT' then
    new.created_at := now();
    if (select count(*) from public.escalation_rules) >= 10 then
      raise exception 'escalation_rules: maximo 10 reglas' using errcode = '54000';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.escalation_rules_guard() from public, anon, authenticated;

drop trigger if exists escalation_rules_guard_trg on public.escalation_rules;
create trigger escalation_rules_guard_trg before insert or update on public.escalation_rules
  for each row execute function public.escalation_rules_guard();

alter table public.escalation_rules enable row level security;
revoke all on public.escalation_rules from anon;
revoke all on public.escalation_rules from authenticated;
grant select on public.escalation_rules to authenticated;
grant insert (after_seconds, channel, enabled, message_template) on public.escalation_rules to authenticated;
grant update (after_seconds, channel, enabled, message_template) on public.escalation_rules to authenticated;

drop policy if exists esc_rules_select on public.escalation_rules;
create policy esc_rules_select on public.escalation_rules
  for select to authenticated
  using (public.jwt_role() in ('viewer','admin'));

drop policy if exists esc_rules_insert_admin on public.escalation_rules;
create policy esc_rules_insert_admin on public.escalation_rules
  for insert to authenticated
  with check (public.jwt_role() = 'admin');

drop policy if exists esc_rules_update_admin on public.escalation_rules;
create policy esc_rules_update_admin on public.escalation_rules
  for update to authenticated
  using (public.jwt_role() = 'admin')
  with check (public.jwt_role() = 'admin');

-- Regla por defecto: 60 s, Teams, DESACTIVADA hasta configurar el webhook (SETUP.md paso 11).
-- Id fijo para que re-ejecutar no duplique ni pise cambios del admin.
insert into public.escalation_rules (id, after_seconds, channel, enabled)
values ('00000000-0000-4000-8000-0000000000e1', 60, 'teams', false)
on conflict (id) do nothing;

-- ===========================================================================
-- 2. escalations  (log + anti-duplicado; PK = event_id + rule_id)
-- ===========================================================================
create table if not exists public.escalations (
  event_id uuid not null references public.events(id) on delete cascade,
  rule_id  uuid not null references public.escalation_rules(id) on delete cascade,
  sent_at  timestamptz not null default now(),
  ok       boolean not null default false,
  detail   text check (detail is null or length(detail) <= 500),  -- nunca la URL del webhook
  primary key (event_id, rule_id)
);
create index if not exists escalations_sent_idx on public.escalations (sent_at desc);

alter table public.escalations enable row level security;
revoke all on public.escalations from anon;
revoke all on public.escalations from authenticated;
grant select on public.escalations to authenticated;
-- service_role (Edge Function escalate) ya suele tener todo por defecto en Supabase; se explicita.
grant select, insert, update on public.escalations to service_role;
grant select on public.escalation_rules to service_role;
grant select on public.events to service_role;
grant select on public.event_acks to service_role;

drop policy if exists escalations_select on public.escalations;
create policy escalations_select on public.escalations
  for select to authenticated
  using (public.jwt_role() in ('viewer','admin'));
-- Sin policies ni grants de INSERT/UPDATE/DELETE para authenticated.

-- ===========================================================================
-- 3. broadcasts  (evacuacion y mensajes del supervisor, texto a voz)
-- ===========================================================================
create table if not exists public.broadcasts (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('evacuacion','mensaje')),
  -- Vacio permitido solo en evacuacion (el casco dice "Dirijase al punto de reunion").
  message          text not null default ''
                   check (length(message) <= 200 and message !~ '[[:cntrl:]]'
                          and (kind = 'evacuacion' or length(btrim(message)) > 0)),
  -- null = todos los cascos; si no, 1..100 device_id validos y sin nulos.
  device_ids       text[]
                   check (device_ids is null
                          or (cardinality(device_ids) between 1 and 100
                              and array_position(device_ids, null::text) is null
                              and array_to_string(device_ids, ',')
                                  ~ '^[A-Za-z0-9_-]{1,64}(,[A-Za-z0-9_-]{1,64})*$')),
  repeat           integer not null default 3 check (repeat between 1 and 5),
  created_by       uuid not null default auth.uid(),
  created_by_email text not null default coalesce(auth.jwt() ->> 'email', ''),
  created_at       timestamptz not null default now()
);
create index if not exists broadcasts_created_idx on public.broadcasts (created_at desc);
create index if not exists broadcasts_user_idx    on public.broadcasts (created_by, created_at desc);

-- Trigger: rol viewer/admin, autoria y fecha desde el servidor, 6/min por usuario.
-- El advisory lock serializa por usuario: sin el, dos inserciones concurrentes
-- podrian ver ambas "5" y pasar de 6.
create or replace function public.broadcasts_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare u uuid := auth.uid();
begin
  if coalesce(public.jwt_role(), '') not in ('viewer','admin') or u is null then
    raise exception 'broadcasts: rol no autorizado' using errcode = '42501';
  end if;
  new.created_at       := now();
  new.created_by       := u;
  new.created_by_email := coalesce(auth.jwt() ->> 'email', '');
  perform pg_advisory_xact_lock(hashtextextended('broadcasts:' || u::text, 0));
  if (select count(*) from public.broadcasts b
       where b.created_by = u and b.created_at > now() - interval '1 minute') >= 6 then
    raise exception 'rate limit: demasiadas ordenes por minuto' using errcode = '54000';
  end if;
  return new;
end $$;
revoke all on function public.broadcasts_guard() from public, anon, authenticated;

drop trigger if exists broadcasts_guard_trg on public.broadcasts;
create trigger broadcasts_guard_trg before insert on public.broadcasts
  for each row execute function public.broadcasts_guard();

alter table public.broadcasts enable row level security;
revoke all on public.broadcasts from anon;
revoke all on public.broadcasts from authenticated;
grant select on public.broadcasts to authenticated;
grant insert (kind, message, device_ids, repeat) on public.broadcasts to authenticated;

drop policy if exists broadcasts_insert_viewer on public.broadcasts;
create policy broadcasts_insert_viewer on public.broadcasts
  for insert to authenticated
  with check (public.jwt_role() in ('viewer','admin') and created_by = auth.uid());

drop policy if exists broadcasts_select_viewer on public.broadcasts;
create policy broadcasts_select_viewer on public.broadcasts
  for select to authenticated
  using (public.jwt_role() in ('viewer','admin'));

drop policy if exists broadcasts_select_device on public.broadcasts;
create policy broadcasts_select_device on public.broadcasts
  for select to authenticated
  using (public.jwt_role() = 'device'
         and public.jwt_device_id() is not null
         and created_at > now() - interval '2 minutes'
         and (device_ids is null or public.jwt_device_id() = any (device_ids)));

-- ===========================================================================
-- 4. broadcast_acks  ("recibido por 3 de 3 cascos")
-- ===========================================================================
create table if not exists public.broadcast_acks (
  broadcast_id uuid not null references public.broadcasts(id) on delete cascade,
  device_id    text not null check (device_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  played_at    timestamptz not null default now(),
  primary key (broadcast_id, device_id)   -- un ack por casco y orden (idempotente)
);
create index if not exists broadcast_acks_device_idx on public.broadcast_acks (device_id, played_at desc);

-- Trigger: played_at = now() y tope 30 acks/min por casco.
create or replace function public.broadcast_acks_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.played_at := now();
  if (select count(*) from public.broadcast_acks a
       where a.device_id = new.device_id
         and a.played_at > now() - interval '1 minute') >= 30 then
    raise exception 'rate limit: demasiados acks de %', new.device_id using errcode = '54000';
  end if;
  return new;
end $$;
revoke all on function public.broadcast_acks_guard() from public, anon, authenticated;

drop trigger if exists broadcast_acks_guard_trg on public.broadcast_acks;
create trigger broadcast_acks_guard_trg before insert on public.broadcast_acks
  for each row execute function public.broadcast_acks_guard();

alter table public.broadcast_acks enable row level security;
revoke all on public.broadcast_acks from anon;
revoke all on public.broadcast_acks from authenticated;
grant select on public.broadcast_acks to authenticated;
grant insert (broadcast_id, device_id) on public.broadcast_acks to authenticated;

-- Solo con su device_id y solo de una orden que ese casco puede ver (vigente y dirigida a el).
-- El EXISTS repite las condiciones de broadcasts_select_device para no depender de que
-- esa policy no cambie.
-- Cliente: insertar con Prefer: return=minimal (el device no puede leer lo que inserta) y
-- tratar 409/23505 (ya registrado) como exito.
drop policy if exists bcack_insert_device on public.broadcast_acks;
create policy bcack_insert_device on public.broadcast_acks
  for insert to authenticated
  with check (
    public.jwt_role() = 'device'
    and public.jwt_device_id() is not null
    and broadcast_acks.device_id = public.jwt_device_id()
    and exists (
      select 1 from public.broadcasts b
       where b.id = broadcast_acks.broadcast_id
         and b.created_at > now() - interval '2 minutes'
         and (b.device_ids is null or broadcast_acks.device_id = any (b.device_ids))
    )
  );

drop policy if exists bcack_select_viewer on public.broadcast_acks;
create policy bcack_select_viewer on public.broadcast_acks
  for select to authenticated
  using (public.jwt_role() in ('viewer','admin'));

-- ===========================================================================
-- Tiempo real para el visor (idempotente; respeta RLS)
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['broadcasts','broadcast_acks'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime'
                     and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Retencion opcional (requiere pg_cron; Database > Extensions > pg_cron):
-- select cron.schedule('casco-purge-broadcasts', '45 3 * * *',
--   $$delete from public.broadcasts where created_at < now() - interval '90 days'$$);
-- select cron.schedule('casco-purge-escalations', '50 3 * * *',
--   $$delete from public.escalations where sent_at < now() - interval '90 days'$$);
-- ---------------------------------------------------------------------------
