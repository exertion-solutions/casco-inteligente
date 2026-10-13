# PENDIENTES

## Hecho
- Diagnostico del casco por ADB (SIM Claro x2, DNS privado corregido, hora automatica, RundeCap en whitelist de bateria).
- Mapa de teclas: SOS = KEY_F11, camara = KEY_F10 (ver docs/TECLAS.md).
- Esqueleto del proyecto: web (visor + login), supabase/schema.sql, agente Android (fuentes), scripts, workflow de Pages.

## Pendiente (en orden)
1. (Hecho) Teclas: SOS=F11, camara=F10, microfono=F12. Falta confirmar que la larga de camara graba video y la de microfono guarda audio (CapRecord).
2. Crear proyecto Supabase; pasar URL + anon key (NO service_role); ejecutar supabase/schema.sql.
3. Crear usuarios casco (role=device) y supervisor (role=viewer).
4. Instalar JDK 17 + Android SDK (cmdline-tools, platform 29, build-tools) y compilar `gradle assembleDebug`.
5. `tools/instalar-agente.ps1 -Config config.local.json` y probar: SOS -> evento en el visor; foto -> imagen en el visor.
6. Activar GitHub Pages (Source: GitHub Actions) y verificar la URL en vivo.

## Riesgos abiertos
- RundeCap BORRA la foto de CapPicture tras subirla a su plataforma (la carpeta cambio a las 21:38 y quedo vacia). El agente debe copiar/subir apenas ocurra CLOSE_WRITE; si pierde la carrera, plan B: leer MediaStore/DCIM o interceptar con inotify mas temprano (CREATE).
- Pulsaciones largas de camara (F10) y microfono (F12) no dejaron archivos en CapCamera/CapRecord: probablemente se transmiten sin guardar local.
- Verificar que un servicio de accesibilidad recibe KEYCODE_F11 sin que RundeCap lo pierda.
- Verificar lectura de /sdcard/Android/data/com.tencent.liteav.demo/files desde otra app (Android 10, targetSdk 28).

## Sensores (relevado por ADB)
- Acelerometro, giroscopio, magnetometro, barometro, luz y proximidad (MTK) + fusionados AOSP.
- RundeCap ya detecta caida (TYPE_FALL_SOS / doFallSos / gSensorListener) y la reporta a su plataforma.
- Agente: FallDetector (caida libre + impacto) publica evento `fall`. Calibrar umbrales con pruebas reales.

## Estado 2026-10-11 (noche)
- Supabase aplicado: ejecutar-todo.sql (funciones=2, tablas=3, bucket=1, trigger=1), roles (casco 4132=device, supervisor=viewer), sign-ups desactivados.
- Edge Function media-auth desplegada (Verify JWT OFF) + secreto MEDIA_AUTH_SECRET cargado (digest verificado). Responde 401 a todo lo invalido.
- Pendiente: contratar VPS + dominio, correr server/install.sh con MEDIA_AUTH_URL (secreto en media-auth-secret.local.txt, ignorado por git).
- Luego: LIVE_HOST en web/config.js; piloto en casco 4132 (instalar APK nuevo, pm disable-user RundeCap). Revertir: pm enable com.tencent.liteav.demo.

## Estado 2026-10-12 (madrugada)
- VPS Vultr Sao Paulo 216.238.110.97 (vc2-1c-1gb, USD 7.50/mes, Ubuntu 24.04). Dominio: 216-238-110-97.sslip.io (HTTPS Let's Encrypt OK).
- MediaMTX 1.21.2 + Caddy en Docker. Fix: montar CA raiz en MediaMTX (auth HTTP a Supabase fallaba por x509). WHEP sin credenciales/token invalido => 401 (cadena Supabase operativa).
- Visor: LIVE_MODE "runde" (Camara en vivo abre caps.runde.pro); panel de video propio oculto hasta que el casco transmita a LIVE_HOST. Panel de estado de cascos por heartbeat, banner de pendientes, metadatos y accesibilidad.
- Casco 4132: sigue con RundeCap + agente v0 (SOS/foto/caida). La app con video NO esta instalada (decision: no desactivar RundeCap sin supervision).
- Acceso SSH del asistente: llave ~/.ssh/casco_vps autorizada en root del VPS. REVOCAR al terminar: borrar la linea 'claude-casco-vps' de /root/.ssh/authorized_keys.

## Para activar video propio (cuando haya supervision)
1. adb install de android/app/build/outputs/apk/debug/app-debug.apk (tools/instalar-agente.ps1) con stream_host=216-238-110-97.sslip.io en config.
2. pm disable-user --user 0 com.tencent.liteav.demo (revertir: pm enable).
3. web/config.js: LIVE_MODE "own". Probar Iniciar en el visor.

## Estado 2026-10-12 03:07 UTC: VIDEO PROPIO ACTIVO (piloto casco 4132)
- Cadena verificada en servidor: RTMP del casco -> MediaMTX (live/4132, H264) -> WebRTC al visor (peer connection established).
- RundeCap PAUSADO en el casco: pm disable-user --user 0 com.tencent.liteav.demo. Revertir: pm enable com.tencent.liteav.demo.
- Casco usa stream_host=216.238.110.97 (IP directa): el casco NO resuelve *.sslip.io. El visor usa 216-238-110-97.sslip.io (HTTPS).
- Fixes de servidor: CA raiz montada en MediaMTX; webrtcAllowOrigins con el origen del visor (lista vacia = 403 a todo navegador).
- Visor: LIVE_MODE "own"; config.js versionado (?v=) contra cache.
- Pendiente: probar SOS fisico (auto 120 s), medir latencia real, RTMPS, rotar MEDIA_AUTH_SECRET, revocar llave SSH del asistente.

## Estado 2026-10-12 (tarde-noche): tanda 3 + rediseño
- Repo: Android tanda 3 (salud, ordenes, audio AAC en ingest/), Supabase 004-007, servidor (coturn, relay), visor con Centro/Equipos/Mapa/Grabacion (333e97b).
- Supabase REAL: migraciones 004 (rtc_signals), 005 (centro), 006 (geo), 007 (equipos) APLICADAS; 15 tablas en public, RLS activo.
- Rediseño "Plano de levantamiento" (impeccable): contrato en .impeccable/surfaces/web-index-html.md; split index.html/app.css/app.js en curso (agente), luego DESIGN.md.
- SIN desplegar: Edge Functions turn-credentials y escalate (escalate queda apagada), coturn y relay ffmpeg en el VPS, TURN_SECRET.
- APK v0.3.0 compilado (android/app/build/outputs/apk/debug/app-debug.apk), NO instalado en el casco: instalar sin force-stop, re-habilitar accesibilidad, stream_audio=false hasta probar el relay.
- Siguiente comando: `tools/instalar-agente.ps1 -Config config.local.json` (con el casco por USB) y luego VOICE_ENABLED=true en web/config.js tras desplegar turn-credentials + coturn.
- Cargar a mano en Supabase IMEI/ICCID reales del 4132 (no al repo).
- Al final: /ponytail:ponytail-review y /ponytail:ponytail; revocar llave SSH claude-casco-vps; rotar MEDIA_AUTH_SECRET.

## Cierre 2026-10-12: rediseño publicado + review ponytail
- Visor rediseñado en vivo (e497c54, DESIGN.md 85fd09c). URL en vivo verificada: login carga, 0 errores de consola.
- Review ponytail: out/ponytail-review.md (20 hallazgos, ~-500 lineas). Descartados a proposito: regla de estacion (movimiento firma), confirmacion doble de evacuacion (seguridad), canvas de recorte (object-view-box fallo en prueba real).
- Deuda aceptada para despues (sin riesgo): helper saveRow/patch en app.js, Files.copy en Android, unificar safeEqual en funciones, borrar group_members (fase 2) en 007, PS1 Leaflet por <script defer>.
- Proximo: instalar APK 0.3.0 con casco por USB, desplegar turn-credentials + coturn, activar VOICE_ENABLED, probar de punta a punta con el casco.

## Estado 2026-10-12 (noche): Vigia v0.7.0
- Marca "Vigia · Casco Inteligente" con logo (web/img, launcher Android). Visor: foto/linterna/ping a pedido, config remota (admin), Reportes CSV/PDF, Historial con Archivar (admin), pestaña Comandos, roles admin/viewer.
- Supabase aplicado: 004-011. Cuenta del propietario = admin (re-loguear). Secreto MEDIA_AUTH_SECRET rotado; llave SSH del asistente revocada y borrada.
- Casco 4132 (APK 0.7.0): voz por comandos activa (Vosk es, palabra "casco"), comandos a pedido, config remota, alertas casco sin usar/inmovil, audio en el video (relay ffmpeg +22 dB), geocercas con histeresis, GPS (ultima posicion conocida).
- Pruebas RLS contra la base real: 774 casos, 32 "fallos" = artefactos (el casco 4132 real ya existe en devices -> fixtures duplican pkey; limite de 30 heartbeats/min). Sin fallos de seguridad reales.
- Pendiente del usuario: ejecutar server/activar-voz.sh en la consola del VPS (voz bidireccional) y poner VOICE_ENABLED=true; probar a viva voz los comandos; calibrar umbrales de caida/inmovilidad; evaluar cierre de SSH (instalar llave propia antes).
- Pendiente tecnico: aplicar recortes ponytail (out/ponytail-audit.md); borrar archivos huerfanos de Storage en la purga; reemplazar bootaudio del casco (ingles) solo con OK explicito (riesgo dm-verity).

## Estado 2026-10-12 (tarde): VPS recuperado, voz bidireccional, estabilidad de video
- Acceso al VPS recuperado por modo rescate (Finnix) con permiso del usuario: llave del asistente `claude-casco-vps-2` en /root/.ssh/authorized_keys (revocar: `sh vps-soporte.sh --revocar` o borrar la linea). Contraseña de root cambiada (guardada en vps-root-password.local.txt, ignorado por git).
- Voz bidireccional ACTIVA: coturn corriendo (3478, 49160-49200/udp abiertos), secretos TURN_SECRET/TURN_HOST en Supabase, funcion turn-credentials desplegada (Verify JWT off), VOICE_ENABLED=true. Falta probar con micrófono real del navegador.
- Video: cortes RTMP por uplink 4G inestable (RSRP -104 dBm): casco bajado a 480x360 @12 fps @300 kbps. Revisar si hace falta mas ajuste o ABR.
- Ver en vivo ante alerta: espera 120 s, reenvia start cada 20 s, boton Reintentar.
- Pendiente: ver prueba hablada de comandos y llamada; sitio .sslip.io; cerrar SSH a IP admin cuando haya llave propia del usuario.

## PWA / service worker (deploy)
- En CADA deploy de web/: subir `CACHE_VERSION` en web/sw.js (ej. `vigia-2026-10-13a` -> `vigia-2026-10-14a`) y el `?v=` de app.css/config.js/app.js en index.html. Sin eso los usuarios pueden ver el shell viejo.
- El SW no cachea supabase.co, sslip.io, /auth, /storage ni cross-origin (CDN leaflet/supabase-js/fuentes/tiles).

## Estado 2026-10-13: tandas de mejora
- Tanda A + PWA: HECHA (commit 939e53e).
- Tanda B: en curso (agente editando web/*).
- Tanda C: PENDIENTE: push/email de alertas, gestion de usuarios en la UI, SLA de respuesta, informe por turno, pasar lista (evacuacion).
- Tanda D (limpieza segura fuera de web/): hecha, ver out/tanda-d.md. Sin tocar: mediamtx.yml, activar/desactivar-voz.sh, vps-soporte.sh, rescate-vps.sh, relay-audio.sh, migraciones, android/.
- IMPORTANTE: subir `CACHE_VERSION` de web/sw.js (y el `?v=` en index.html) en CADA deploy de web/.

## Estado 2026-10-13 (tanda C)
- Hecho y publicado: tanda A (confiabilidad), PWA, tanda B (severidades/a11y), tanda C (asistencia remota registrada, constancias EPP y capacitacion, auditoria + rol auditor, hash SHA-256 de media, guia de comandos corregida). Commit 4c9d0f8.
- Migracion 013 APLICADA en la base real (verificado: 7 objetos, 2 funciones, 11 politicas). Contrato en docs/PROTOCOLO-ASISTENCIA.md.
- Agente 0.8.0 (hash de media) compilado: android/app/build/outputs/apk/debug/app-debug.apk. FALTA instalarlo en el casco: tools\instalar-agente.ps1 -Config config.local.json con el casco por USB.
- Probar en vivo con sesion iniciada: pestanas Asistencia, Constancias, Auditoria; "Verificar integridad" (requiere fotos nuevas con el agente 0.8.0).
- Para tener rol auditor: crear usuario y setear app_metadata.role='auditor' (ver supabase/promover_admin.sql como modelo).
- Pendiente: Res. SIC 16/2025 excluye equipos Ex del reglamento electrico; certificado del casco es chino (no IECEx/ATEX) -> aceptacion del cliente; cargador/fuente necesitan certificacion de seguridad electrica; homologacion de radio (ENACOM) y bandas LTE: verificar.
- Pendiente: ponytail (recortes de tools/ y server/ no aplicados), escalamiento push/email/WhatsApp, usuarios en la UI, informe por turno, pasar lista en evacuacion, grabacion en servidor.

## Avisos de alertas (2026-10-13)
- Aplicado en la base real: migraciones 013, 014 y 015. Funcion Edge `notify` desplegada (JWT del gateway desactivado: valida su propia clave). Destinatarios cargados por SQL (no estan en el repo).
- Falta configurar en el visor (Constancias > Empleador > Avisos): proveedor de correo (Brevo o Resend, clave de API write-only), activar push en cada dispositivo, activar los avisos y enviar prueba.
- Sin probar en real: envio por Brevo/Resend, push real (Android/Windows/iPhone PWA), pg_net/pg_cron en produccion.
- Nota: el editor de funciones de Supabase se cuelga al pegar codigo grande; desactivar diagnosticos de monaco (setDiagnosticsOptions) antes de setValue.
