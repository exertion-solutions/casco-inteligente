# Casco Inteligente

Alertas y fotos del casco (rd_aqm6816, Android 10) en un visor web con login.

```
Casco (app agente)  ->  Supabase (Auth + Storage + Realtime)  ->  GitHub Pages (visor)
 SOS (F11), fotos        eventos + media privada, RLS             login, alerta SOS en vivo
```

El agente **no toca la camara**: convive con RundeCap (que sigue reportando a caps.runde.pro).
Observa `CapPicture`/`CapCamera` de RundeCap y detecta el SOS por teclado.

## Estructura
| Carpeta | Contenido |
|---|---|
| `web/` | Visor estatico (GitHub Pages). `config.js` lleva URL + anon key (publicas por diseno) |
| `supabase/schema.sql` | Tablas, RLS, bucket privado, realtime |
| `android/` | App agente (Java, sin dependencias externas) |
| `tools/` | `capturar-teclas.ps1`, `instalar-agente.ps1` |
| `docs/TECLAS.md` | Mapa de botones del casco |

## Puesta en marcha
1. **Supabase**: crear proyecto, ejecutar `supabase/schema.sql` en SQL Editor.
   En *Authentication > Providers > Email* desactivar "Allow new users to sign up".
2. **Usuarios** (Authentication > Users > Add user): uno por casco y uno por supervisor.
   Asignar roles con las sentencias comentadas al final de `schema.sql`.
3. **Web**: poner `SUPABASE_URL` y `SUPABASE_ANON_KEY` en `web/config.js`.
   GitHub > Settings > Pages > Source: **GitHub Actions**. Push a `main` despliega.
4. **Agente**: compilar el APK (JDK 17 + Android SDK + Gradle: `cd android; gradle assembleDebug`),
   crear `config.local.json` (ver `android/app/src/main/java/ar/exertion/casco/Config.java`) y correr
   `tools/instalar-agente.ps1 -Config config.local.json`.

## Seguridad
- Repo publico: **ningun secreto** versionado. `config.local.json` esta en `.gitignore`.
- La `anon key` es publica; el acceso lo limita RLS por `app_metadata.role` (`device` solo inserta, `viewer` solo lee).
- Nunca usar la `service_role` key en web ni en el casco.
- Videos > 25 MB: se registra el evento sin subir el archivo.
