# Servidor de video del Casco Inteligente

Guia para instalar tu propio servidor de video (MediaMTX + HTTPS automatico con Caddy) en un VPS.
No necesitas saber programar: solo copiar y pegar comandos.

```
Casco --RTMP (1935)--> [ VPS: MediaMTX ] --WebRTC (443 + 8189)--> Visor web
                              |
                              +--> pregunta a Supabase (media-auth) si cada conexion esta permitida
```

## 1. Que VPS contratar

| Requisito | Minimo |
|---|---|
| Sistema | Ubuntu 22.04 o 24.04 LTS (limpio) |
| CPU / RAM / disco | 1 vCPU, 1 GB RAM, 10 GB |
| Red | IPv4 publica fija |
| Ubicacion | Sao Paulo o Buenos Aires (menor latencia) |
| Trafico | 1 casco a 800 kbps ~ 350 MB/hora; cada visor suma otro tanto |

Importante al contratar: que NO bloquee el puerto 1935 saliente/entrante ni UDP (la mayoria no lo hace; preguntalo si dudas).

## 2. Apuntar un dominio al VPS

Necesitas un dominio o subdominio, por ejemplo `live.tudominio.com`.

1. En el panel de tu proveedor de dominio (donde lo compraste) entra a "DNS" / "Zona DNS".
2. Crea un registro **A**: nombre `live`, valor = la IP publica del VPS, TTL 300.
3. Espera 5-30 minutos. Comprobacion desde cualquier PC: `nslookup live.tudominio.com` debe mostrar la IP del VPS.

Si usas Cloudflare: poner la nube en **gris** (solo DNS). La nube naranja rompe RTMP y WebRTC.

## 3. Instalar

Conectate al VPS por SSH (`ssh root@IP_DEL_VPS`) y pega:

```bash
git clone <URL_DE_ESTE_REPO> casco && cd casco/server
cp .env.example .env
nano .env        # completar las 3 variables (ver tabla), guardar con Ctrl+O, Enter, Ctrl+X
sudo bash install.sh --admin-ip <TU_IP_PUBLICA>
```

Tu IP publica: abri https://ifconfig.me desde tu PC. Si tu IP cambia seguido usa `--admin-ip any` (SSH queda abierto a todos, protegido por fail2ban).

| Variable (.env) | Que poner |
|---|---|
| `LIVE_DOMAIN` | El dominio del paso 2, sin `https://` (ej. `live.tudominio.com`) |
| `PUBLIC_IP` | La IP publica del VPS |
| `MEDIA_AUTH_URL` | URL de la Edge Function `media-auth` de Supabase (la da quien configura Supabase) |
| `ALLOWED_ORIGIN` | Ya viene puesto: `https://exertion-solutions.github.io` |

El script instala Docker, configura el firewall (22 solo desde tu IP, 80, 443, 1935, 8189), fail2ban, y levanta todo. Puedes correrlo de nuevo sin problema.

## 4. Verificar

Reemplaza `live.tudominio.com`:

```bash
# 1) HTTPS responde (debe decir "no encontrado" con codigo 404 y candado valido)
curl -i https://live.tudominio.com/

# 2) CORS para el visor (todo debe decir OK)
bash test/test-cors.sh live.tudominio.com
```

Desde Windows: `.\test\test-cors.ps1 -Dominio live.tudominio.com`.

**Prueba de video completa (sin la Edge Function).** En el VPS, en la carpeta `server/`:

```bash
# Modo prueba: usuario "test", clave "prueba-casco-1234" (solo para probar)
docker compose -f docker-compose.yml -f test/docker-compose.override.test.yml up -d
```

Desde tu PC (necesita ffmpeg) publica un video de prueba generado:

```bash
ffmpeg -re -f lavfi -i testsrc=size=640x480:rate=15 -c:v libx264 -profile:v baseline -preset veryfast -tune zerolatency -g 30 -b:v 800k -an -f flv "rtmp://live.tudominio.com:1935/live/test?user=test&pass=prueba-casco-1234"
```

Para verlo: pagina del navegador no autenticada no sirve (WHEP necesita cabecera de usuario). Verificacion rapida desde otra consola:

```bash
curl -i -X POST https://live.tudominio.com/live/test/whep -u test:prueba-casco-1234 -H "Content-Type: application/sdp" --data-binary "v=0"
```

Una respuesta 400 (SDP invalido) significa que el servidor y el stream existen y la clave fue aceptada; 401 = credenciales mal; 404 = nadie esta publicando. Para ver el video real usa el visor del proyecto.

Al terminar, **volver al modo normal**:

```bash
docker compose up -d --force-recreate
```

## 5. Ver logs

```bash
cd casco/server
docker compose logs -f --tail 50 mediamtx   # video y autenticacion
docker compose logs -f --tail 50 caddy      # HTTPS y certificados
docker compose ps                           # estado
```
(Ctrl+C para salir.)

## 6. Actualizar

La version de MediaMTX esta fijada (`1.21.2`). Para actualizar: editar `image: bluenviron/mediamtx:...` en `docker-compose.yml` por la version nueva (ver https://github.com/bluenviron/mediamtx/releases), y:

```bash
docker compose pull && docker compose up -d
```

Actualizaciones del sistema: `sudo apt update && sudo apt -y upgrade`.

## 7. Costos estimados

| Concepto | Costo aprox. |
|---|---|
| VPS 1 vCPU / 1 GB (Sudamerica) | USD 5-8 por mes |
| Dominio | USD 10-15 por ano (o subdominio de uno que ya tengas: gratis) |
| Certificado HTTPS | Gratis (Let's Encrypt) |
| Software (MediaMTX, Caddy, Docker) | Gratis |

## 8. Problemas comunes

| Sintoma | Causa probable | Solucion |
|---|---|---|
| El casco no conecta por RTMP | El proveedor bloquea el puerto 1935 | Abrirlo en el firewall del panel del proveedor (no solo ufw); si no se puede, pedir soporte o cambiar de proveedor |
| Se conecta pero el visor queda en "conectando" / negro | UDP bloqueado en el VPS o en la red del visor | Abrir 8189 UDP y TCP en el panel del proveedor; el servidor ya ofrece TCP 8189 como respaldo; confirmar `PUBLIC_IP` correcta |
| `caddy` no emite el certificado | El dominio no apunta al VPS, o 80/443 cerrados | `nslookup` del dominio, abrir 80 y 443 en el panel; ver `docker compose logs caddy`; no reintentar sin parar: Let's Encrypt limita intentos |
| El navegador dice "CORS" / "blocked by CORS policy" | `ALLOWED_ORIGIN` mal escrito (debe ser exacto, sin `/` final) | Corregir `.env`, `docker compose up -d --force-recreate`, correr `test/test-cors.sh` |
| 401 en el visor o el casco | JWT vencido, rol incorrecto, o Edge Function sin acceso | `docker compose logs mediamtx` ver `authentication failed`; probar la funcion; ver nota de `verify_jwt` en el informe |
| Cloudflare con nube naranja | El proxy de Cloudflare no pasa RTMP/UDP | Poner el registro en "solo DNS" (gris) |
| Mucha latencia (> 2 s) | Red del casco, o keyframe muy espaciado | Perfil del casco: keyframe cada 2 s (`-g` = 2 x fps) |
| `docker: permission denied` | Usuario sin permisos | Usar `sudo docker ...` |

## 9. Seguridad (resumen)

- Solo 22 (tu IP), 80, 443, 1935 y 8189 estan abiertos. API y metrics de MediaMTX estan apagados.
- Solo existen streams `live/<id>`; cualquier otra ruta se rechaza.
- Cada conexion se valida contra Supabase (usuario autenticado y rol correcto).
- RTMP en claro lleva el token en la URL (vence en 1 hora): aceptable para el piloto. Mejora futura: RTMPS.
- El archivo `.env` no se sube al repo (esta en `.gitignore`). No lo compartas.
- Nota: Docker publica sus puertos saltandose ufw; por eso el compose solo publica los puertos listados arriba.
