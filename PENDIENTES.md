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
- Verificar que un servicio de accesibilidad recibe KEYCODE_F11 sin que RundeCap lo pierda.
- Verificar lectura de /sdcard/Android/data/com.tencent.liteav.demo/files desde otra app (Android 10, targetSdk 28).
