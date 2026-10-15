# Visor en vigia.exertionai.com

Pasar el visor de `https://exertion-solutions.github.io/casco-inteligente/` a `https://vigia.exertionai.com/`.
Ventajas: URL de marca, y el visor queda en su propio origen, separado del sitio comercial (`www.exertionai.com`).

> **Orden importante.** El servidor de video solo acepta un origen (`ALLOWED_ORIGIN`). Entre el paso 3 y el paso 4 el
> video y la voz fallan. Hacé esos dos pasos seguidos, en un momento sin supervisores mirando, y con el DNS ya propagado.

## 1. DNS (donde esté el DNS de exertionai.com, p. ej. Hostinger)

| Tipo | Nombre | Destino | TTL |
|---|---|---|---|
| `CNAME` | `vigia` | `exertion-solutions.github.io` | 300 |

- Hostinger: hPanel → Dominios → `exertionai.com` → DNS / servidores de nombres → Administrar registros DNS.
- No cargar registros `A` para `vigia`. No usar proxy de Cloudflare (nube naranja) si hubiera uno.
- Comprobar: `nslookup vigia.exertionai.com` debe responder `exertion-solutions.github.io`.

## 2. (Recomendado) Verificar el dominio en GitHub

Evita que otra cuenta reclame el subdominio. Organización `exertion-solutions` → Settings → Pages → *Add a domain*:
GitHub pide un registro `TXT` (`_github-pages-challenge-exertion-solutions.exertionai.com`). Cargarlo en el mismo panel de DNS.

## 3. GitHub Pages y servidor de video (seguidos)

**3a. GitHub:** repo `casco-inteligente` → Settings → Pages → *Custom domain* = `vigia.exertionai.com` → Save.
Esperar el chequeo de DNS (hasta unos minutos) y tildar **Enforce HTTPS**. El despliegue es por GitHub Actions: el archivo
`CNAME` no se usa, el dominio se define solo en esta pantalla.

**3b. VPS:** editar `server/.env`:

```
ALLOWED_ORIGIN=https://vigia.exertionai.com
```

y en `server/mediamtx.yml`:

```yaml
webrtcAllowOrigins: ['https://vigia.exertionai.com']
```

Aplicar: `docker compose up -d --force-recreate`. Escribir el origen **exacto, sin `/` final**.

## 4. Verificar

1. CORS del servidor de video: `server/test/test-cors.sh <LIVE_DOMAIN> https://vigia.exertionai.com` (o `test-cors.ps1 -Origen https://vigia.exertionai.com`). Debe responder 204 con `Access-Control-Allow-Origin: https://vigia.exertionai.com`.
2. Abrir `https://vigia.exertionai.com`, iniciar sesión, **Iniciar** el video de un casco y probar **Hablar**.
3. `https://exertion-solutions.github.io/casco-inteligente/` debe redirigir solo al subdominio.

## 5. Supabase

Authentication → URL Configuration: agregar `https://vigia.exertionai.com` a *Site URL* y a *Redirect URLs* (lo usan los correos de
restablecer contraseña). El ingreso con correo y contraseña no depende de esto.

## 6. Qué cambia para las personas

- **Sesión:** el subdominio es otro origen: hay que volver a iniciar sesión una vez.
- **Aplicación instalada:** quien instaló el visor como app debe desinstalarla y volver a instalarla desde el subdominio.
- **Preferencias locales** (por ejemplo el giro de imagen recordado por casco) se pierden una vez.
- Los marcadores viejos siguen funcionando por la redirección.

## Volver atrás

Quitar el dominio personalizado en Settings → Pages, devolver `ALLOWED_ORIGIN` y `webrtcAllowOrigins` a
`https://exertion-solutions.github.io`, y `docker compose up -d --force-recreate`.
