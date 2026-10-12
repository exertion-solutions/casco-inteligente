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
