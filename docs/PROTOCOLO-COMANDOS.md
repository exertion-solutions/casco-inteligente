# Tanda 4: comandos a pedido, configuracion remota, alertas nuevas, roles y reportes

Fuente de verdad para Supabase, Web y Android. Complementa PROTOCOLO-VIDEO/VOZ/GEO/CENTRO. Fuera de alcance (decision del usuario):
gases, signos vitales, SIP/PTT, llamadas grupales, tareas, escalamiento (Teams apagado).

## 1. Comandos a pedido (supervisor -> casco)
Tabla `public.device_commands`:
`id uuid pk default gen_random_uuid()`, `device_id text not null` (formato ^[A-Za-z0-9_-]{1,64}$), `action text not null check in
('photo','torch_on','torch_off','restart_agent','ping')`, `params jsonb not null default '{}'` (objeto, <= 1 KB),
`requested_by uuid default auth.uid()`, `requested_by_email text default jwt email`, `created_at timestamptz default now()` (servidor).
- INSERT: `viewer`/`admin` (grants por columna: device_id, action, params). `restart_agent` solo `admin`. Rate limit 10/min por usuario.
  Sin UPDATE ni DELETE.
- SELECT: viewer/admin todo; `device` solo filas con su device_id y de los ultimos 2 min.
- Publicada en Realtime. El casco las lee con el poll existente (3 s) o por Realtime; dedupe por `id` (persistente).
Tabla `public.device_command_acks`: `command_id uuid references device_commands on delete cascade`, `device_id text`, `ok boolean`, `detail text` (<= 200),
`created_at default now()`; PK (command_id, device_id). INSERT: `device` con su device_id; SELECT: viewer/admin. Publicada en Realtime.
- `photo`: el casco saca una foto (camara libre; si hay transmision de video activa usa el ultimo cuadro o responde ok=false
  detail='camara ocupada'), la sube a `casco-media/<device_id>/<ts>.jpg` e inserta `events(type='photo', media_path, payload={"cmd":"<command_id>"})`,
  luego ack ok=true.
- `torch_on` / `torch_off`: linterna (CameraManager.setTorchMode). Si la camara esta ocupada: ack ok=false detail='camara ocupada'.
- `restart_agent`: el agente se reinicia (stopSelf + relanzar por AlarmManager). `ping`: ack inmediato (prueba de enlace, con `payload.rtt` opcional).

## 2. Eventos nuevos (events.type; ampliar events_type_check)
`not_worn` (casco sin usar > N s segun proximidad), `inactive` (inmovil > N s con el casco puesto: ver 4), `equip`
(`payload.kind` in bat_low|bat_crit|no_signal|temp|storage, `payload.level`), `fall_cancel` (cuenta regresiva cancelada por el operario).
- Requieren atencion (Atender con nota): `not_worn`, `inactive`. Informativos y registrados: `equip`, `fall_cancel`.
- Rate limit por (casco, tipo): 30/min como el resto. El casco emite `equip` una vez por episodio (histeresis).

## 3. Configuracion remota por casco
Tabla `public.device_config`: `device_id text pk`, `config jsonb not null default '{}'` (objeto <= 2 KB, claves permitidas:
`fall_g_threshold`, `inactivity_s`, `not_worn_s`, `heartbeat_s`, `location_s`, `location_s_alert`, `stream_audio`, `voice_commands`,
`broadcast_volume`, `torch_allowed`), `updated_by uuid`, `updated_at timestamptz`.
- INSERT/UPDATE: `admin`. SELECT: viewer/admin; `device` solo su fila. Publicada en Realtime. El casco la lee al iniciar y cada 5 min
  (con ETag/updated_at) y aplica lo permitido con validacion de rangos; la config local es el respaldo.

## 4. Alertas de casco no puesto e inmovilidad
- `not_worn_s` (default 120): sensor de proximidad/orientacion indica casco apoyado sin movimiento -> evento `not_worn` una vez por episodio.
- `inactivity_s` (default 0 = apagado; recomendado 300): con el casco puesto y sin movimiento -> aviso por voz al operario a los 60 s
  y evento `inactive` si no hay respuesta (cualquier movimiento o boton cancela).

## 5. Roles (RLS)
| Accion | viewer | admin |
|---|---|---|
| Ver todo, atender alertas (event_acks), stream_commands, `photo`/`torch_*`/`ping`, mensajes (`broadcasts.kind='mensaje'`) | si | si |
| Evacuacion (`broadcasts.kind='evacuacion'`) | no | si |
| Alta/edicion/baja de devices, people, groups, assignments | no | si |
| Crear/editar/baja de geofences y geo_points | no | si |
| device_config, `restart_agent` | no | si |
La cuenta del usuario propietario (jorge_e_castro@hotmail.com) se promueve a admin con SQL. La UI oculta lo que el rol no puede.

## 6. Reportes e historial
- Vista `public.incident_report` (security_invoker): una fila por alerta (sos, fall, geofence que requiere atencion, not_worn, inactive)
  con: event_id, created_at, device_id, nombre/persona (join devices/people_full no: solo nombre del casco), type, payload resumido,
  lat/lng, acked_at, acked_by_email, note, `tta_s` (segundos hasta atender). Acceso viewer/admin.
- Web: pestaña "Reportes": filtros (rango de fechas, casco, tipo, atendidas/pendientes), tabla paginada (keyset por created_at, 50 por pagina),
  exportar CSV (BOM UTF-8, separador ';', fechas dd/mm/aaaa HH:mm en hora Argentina) y "Imprimir / PDF" con hoja de estilos de impresion.
- Historial: mismos filtros y paginacion.

## 7. Web (resumen de pantallas nuevas)
Por casco en Centro/En vivo: botones "Sacar foto", "Linterna: encender/apagar", "Probar enlace" (ping, muestra rtt) con estado
(pendiente/ok/error del ack) y la foto resultante en una tira de miniaturas. Admin: "Configuración del casco" (formulario con
rangos y validacion), "Reiniciar agente" con confirmacion. Cascos detectados sin registrar -> boton "Registrar". Mensaje a "Todos":
confirmacion y largo minimo 5; boton "Reenviar a los que no confirmaron". Topes de memoria para feed/mapas.

## 8. Notas de implementacion en Supabase (migracion 010)
Archivos: `supabase/migrations/010_comandos_config_roles.sql`, `supabase/promover_admin.sql`, pruebas en `supabase/tests/rls_test.sql`.
- **Ack de comando**: el casco puede confirmar un comando suyo de hasta **10 min** (la foto puede tardar en subir), aunque lo lea solo durante 2 min.
  Un casco dado de baja no confirma (`device_is_active`); `sos` y `fall` siguen aceptandose siempre (migracion 009). El cliente debe insertar el ack con
  `Prefer: return=minimal` y tratar 409/23505 (ya registrado) como exito. Rate limit de acks: 30/min por casco.
- **device_config**: la base valida **claves y tipos** (numero: `fall_g_threshold`, `inactivity_s`, `not_worn_s`, `heartbeat_s`, `location_s`,
  `location_s_alert`, `broadcast_volume`; booleano: `stream_audio`, `voice_commands`, `torch_allowed`). Los **rangos** los valida el casco. No hay DELETE:
  guardar `{}` para volver a la config local. `updated_by`/`updated_at` los fija el servidor. Upsert (`on conflict (device_id)`) permitido para admin.
- **Roles**: ademas de las policies, el trigger `aa_admin_only_trg` bloquea cualquier escritura de quien no sea admin en devices, people, groups,
  assignments, geofences, geo_points y device_config; `broadcasts` con `kind='evacuacion'` y comando `restart_agent` tambien exigen admin. Errores: 42501.
  El visor debe ocultar esos controles segun `app_metadata.role`.
- **incident_report** (security_invoker): columnas `event_id, created_at, device_id, device_name, type, payload, lat, lng, acked_at, acked_by_email, note, tta_s`.
  `payload` es un resumen (geocerca: `zone_name, kind, action`; resto: `reason`). Geocerca incluida solo si requiere Atender
  (restringida/enter, permitida/exit, peligro/enter). Paginar por keyset (`created_at` desc, `event_id`); el filtro de rango y casco va en la consulta.
- **Retencion** (`casco_purge`): comandos y acks 7 dias; `equip` y `fall_cancel` 90 dias; `not_worn` e `inactive` 1 ano (como sos/fall).
- **Fuera de esta migracion**: la Edge Function `escalate` sigue escalando solo `sos`, `fall` y `geofence`; escalar `not_worn`/`inactive` requiere ampliar su filtro.

## 9. Archivar eventos (migracion 011)
- Tabla `public.event_archive(event_id pk -> events on delete cascade, archived_by, archived_by_email, archived_at, reason <= 200)`.
  INSERT (archivar) y DELETE (desarchivar): solo `admin`; SELECT: viewer/admin; el casco no la ve; sin UPDATE. Insertar solo `event_id` y `reason`.
- Solo se archiva un evento ya atendido (fila en `event_acks`) o informativo; una alerta pendiente (sos, fall, not_worn, inactive, geocerca que requiere
  Atender) falla con codigo 22023 y el mensaje "la alerta esta pendiente de atender". 60 archivados por minuto por usuario (54000).
- `incident_report.archived_at` (null si no esta archivado); la vista NO excluye archivados: el visor filtra. Publicada en Realtime.
- Aviso de seguridad de las migraciones: los triggers admin-only dejan pasar una sesion directa de base de datos SIN JWT (SQL Editor, fixtures) y
  `service_role`; viewer, device, anon y authenticated sin rol quedan bloqueados.
