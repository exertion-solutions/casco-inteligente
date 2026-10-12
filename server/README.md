# Servidor de video del Vigía · Casco Inteligente

Guia para instalar tu propio servidor de video (MediaMTX + HTTPS automatico con Caddy) en un VPS.
No necesitas saber programar: solo copiar y pegar comandos.

```
Casco --RTMP (1935)--> [ VPS: MediaMTX (+ffmpeg) ] --WebRTC (443 + 8189)--> Visor web
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

El script instala Docker, configura el firewall (22 solo desde tu IP, 80, 443, 1935, 8189, 3478, 49160-49200), fail2ban, y levanta todo. Puedes correrlo de nuevo sin problema.

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

La version de MediaMTX esta fijada (`1.21.2-ffmpeg`; usar siempre la variante `-ffmpeg`, trae ffmpeg para el audio). Para actualizar: editar `image: bluenviron/mediamtx:...-ffmpeg` en `docker-compose.yml` por la version nueva (ver https://github.com/bluenviron/mediamtx/releases), y:

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

- Solo 22 (tu IP), 80, 443, 1935, 8189 y TURN (3478, 49160-49200/udp) estan abiertos. API y metrics de MediaMTX estan apagados.
- Solo existen streams `ingest/<id>` (entrada con audio) y `live/<id>`; cualquier otra ruta se rechaza.
- RTSP de MediaMTX escucha solo en `127.0.0.1` dentro del contenedor (relay de audio); no se publica ni es alcanzable desde fuera.
- Cada conexion se valida contra Supabase (usuario autenticado y rol correcto).
- RTMP en claro lleva el token en la URL (vence en 1 hora): aceptable para el piloto. Mejora futura: RTMPS.
- El archivo `.env` no se sube al repo (esta en `.gitignore`). No lo compartas.
- Nota: Docker publica sus puertos saltandose ufw; por eso el compose solo publica los puertos listados arriba. coturn usa red host (si pasa por ufw).
- TURN: credenciales temporales (1 h), sin acceso a redes privadas (`denied-peer-ip`) y con cuotas; ver seccion 10.

## 10. Voz en vivo (TURN)

**Para que sirve.** La voz supervisor <-> casco usa WebRTC. El casco va por 4G detras de CGNAT: la conexion directa
casi nunca se logra y, sin un servidor TURN que retransmita el audio, **no hay audio**. `coturn` (contenedor `coturn`,
imagen fijada `coturn/coturn:4.18.0-r0`) hace de STUN (descubrir IP) y TURN (relay). Las credenciales son temporales:
la Edge Function `turn-credentials` las firma con `TURN_SECRET` y vencen en 1 hora.

| Puerto | Protocolo | Uso |
|---|---|---|
| 3478 | UDP y TCP | STUN/TURN (señalizacion y relay hacia el cliente) |
| 49160-49200 | UDP | Puertos de relay (un par por llamada; 41 alcanzan de sobra) |

Sin TLS en esta etapa (no se abre 5349). Usa `network_mode: host` (recomendado por la imagen oficial para rangos de
puertos) y no choca con MediaMTX (1935, 8189) ni Caddy (80, 443). `install.sh` abre todo en `ufw`.
**Si tu proveedor tiene firewall en el panel, abre tambien 3478 UDP/TCP y 49160-49200 UDP alli.**

### Activar la voz en un VPS que ya corre el video (sin `install.sh`)

Para un VPS donde MediaMTX y Caddy ya funcionan (carpeta `/root/casco/server`) y NO tiene coturn. El script
`activar-voz.sh` solo levanta el contenedor `coturn`: no reinicia ni toca `mediamtx` ni `caddy`. Es idempotente
(se puede correr dos veces). Para revertir: `desactivar-voz.sh`.

**Paso a paso (sin conocimientos tecnicos):**

1. Entra a https://my.vultr.com > **Products** > tu servidor > boton **View Console** (arriba a la derecha). Se abre una
   pantalla negra: logueate como `root` con la clave del servidor (al escribirla no se ve nada; es normal).
2. En la consola pega y ejecuta (Enter al final):
   ```
   cd /root/casco/server && curl -fsSL https://raw.githubusercontent.com/exertion-solutions/casco-inteligente/main/server/activar-voz.sh -o activar-voz.sh && sh activar-voz.sh --descargar
   ```
   Si el repo ya esta clonado y actualizado (`git pull`), alcanza con `sh activar-voz.sh`.
   El modo `--descargar` baja `docker-compose.yml` y `turnserver.conf` de GitHub, **imprime el sha256 de cada archivo** (comparalo con
   `Get-FileHash server\docker-compose.yml` en tu PC si queres verificar) y guarda una copia `*.bak-<fecha>` si cambia algo.
   Alternativa sin internet en el VPS: subir los dos archivos con `scp docker-compose.yml turnserver.conf root@216.238.110.97:/root/casco/server/` y correr `sh activar-voz.sh`.
3. El script comprueba la memoria (aborta si quedan menos de 150 MB disponibles, sin cambiar nada), genera el secreto,
   abre los puertos en `ufw`, levanta coturn y muestra `docker ps`. Si todo sale bien, termina con un bloque
   "SIGUIENTE PASO" y, en la **ultima linea**, `TURN_SECRET=<texto largo>`.
4. Seleccionar con el mouse **solo el texto que va despues del `=`** de esa ultima linea y copiarlo (en la consola de Vultr: boton
   derecho > Copy, o Ctrl+Shift+C).
5. Supabase: https://supabase.com/dashboard > tu proyecto > **Edge Functions** > **Secrets** > **Add new secret**. Crear dos:
   `TURN_SECRET` (lo copiado) y `TURN_HOST` (`216.238.110.97`).
6. Supabase > **Edge Functions** > **Deploy a new function** > **Via Editor**, nombre `turn-credentials`, pegar el contenido de
   `supabase/functions/turn-credentials/index.ts` > **Deploy**. Luego abrir la funcion > **Details** y **desactivar "Verify JWT"**.
   (Con CLI: `supabase functions deploy turn-credentials --no-verify-jwt --project-ref zgfvhjpdzkohouktakvt`.)
7. Abrir en el panel de Vultr (Products > Firewall, si hay un grupo asignado al servidor) los puertos 3478 TCP/UDP y 49160-49200 UDP.
8. Probar (desde otra PC): `bash test/test-turn.sh 216.238.110.97` y el relay segun "Probar" mas abajo.
9. **Ultimo paso, a mano**: en `web/config.js` poner `VOICE_ENABLED: true` y publicar la web (subir el cambio a GitHub; ver `docs/PROTOCOLO-VOZ.md`).
   El script no lo hace.

Notas: el `TURN_SECRET` se guarda en `/root/casco/server/.env` (permiso 600) y **no** se borra al desactivar, porque
`docker-compose.yml` lo exige para cualquier comando. Si el script dice "no hay memoria", cerrar procesos o subir el plan del VPS
(coturn usa ~15-25 MB). Para volver atras: `sh desactivar-voz.sh` y `VOICE_ENABLED: false`.

### Cargar el secreto en la Edge Function (pasos para no tecnicos)
1. Conectate: `ssh root@IP_DEL_VPS`
2. `cd casco/server && grep TURN_SECRET .env` -> muestra `TURN_SECRET=<texto largo>`. Copia solo lo que va despues del `=`.
3. En Supabase: *Edge Functions > Secrets* (o `supabase secrets set TURN_SECRET=<texto>`): crear `TURN_SECRET` con ese valor.
   Opcional: `TURN_HOST` (por defecto la IP publica del VPS; el casco no resuelve sslip.io).
4. No lo pegues en chats, mails ni en el repo. Si se filtra: borrar la linea `TURN_SECRET=` de `.env`, correr
   `sudo bash install.sh --admin-ip ...` (genera uno nuevo) y volver a cargarlo en Supabase.

### Probar
Desde **otra** maquina (no el VPS):

```bash
# 1) STUN responde por UDP y TCP (no prueba el relay)
bash test/test-turn.sh IP_DEL_VPS

# 2) Credencial temporal (en el VPS, carpeta server/). Imprime JSON como la Edge Function:
bash test/turn-creds.sh            # usuario "test", vence en 1 h
# one-liner equivalente, sin script:
U="$(( $(date +%s) + 3600 )):test"; echo "username=$U"; \
  echo "credential=$(printf %s "$U" | openssl dgst -sha1 -hmac "$(sed -n 's/^TURN_SECRET=//p' .env)" -binary | openssl base64 -A)"
```

3) Relay real: abrir https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/ , borrar los servidores de
la lista, agregar `turn:IP_DEL_VPS:3478?transport=udp` con el `username` y `credential` del paso 2, y pulsar
*Gather candidates*. Debe aparecer al menos un candidato **`relay`** (tipo `relay`, IP = la del VPS, puerto 49160-49200).
Si solo salen `host`/`srflx`, el relay NO funciona (ver fallos). Alternativa por consola:
`turnutils_uclient -u "<username>" -w "<credential>" -p 3478 IP_DEL_VPS` (paquete `coturn-utils`/`coturn`).

### Logs y fallos comunes
`docker compose logs -f --tail 50 coturn`

| Sintoma | Causa probable | Solucion |
|---|---|---|
| `test-turn.sh` falla en UDP pero TCP ok | UDP 3478 bloqueado por el proveedor o ufw | Abrir 3478/udp en panel y `ufw`; algunos proveedores filtran UDP: consultar |
| STUN responde pero no hay candidato `relay` | Rango 49160-49200/udp cerrado, o `PUBLIC_IP` mal | Abrir el rango en ufw **y** en el panel; revisar `PUBLIC_IP` en `.env` y reiniciar: `docker compose up -d --force-recreate coturn` |
| `relay` con IP privada / audio mudo | `external-ip` incorrecto (VPS con NAT 1:1 como Oracle/AWS/GCP: la IP publica no esta en la interfaz) | `PUBLIC_IP` debe ser la IP publica real; con NAT 1:1 coturn necesita `external-ip=<publica>/<privada>`: editar la linea en `docker-compose.yml` |
| `401 Unauthorized` / `Cannot find credentials` en logs | `TURN_SECRET` distinto entre `.env` y Edge Function, o reloj desfasado | Recargar el mismo secreto; `timedatectl` en el VPS (NTP activo); el `username` debe ser `<exp>:<usuario>` con `exp` futuro |
| Dos clientes en la misma red/VPS no se oyen | Hairpin NAT: el relay no puede enviar a la IP publica propia (esta en `denied-peer-ip` a proposito) | Probar desde redes distintas; entre dos equipos de la misma LAN la conexion es directa |
| `403 Forbidden IP` en logs | El peer cae en un rango denegado (privado/loopback) | Esperado: el relay no debe alcanzar la red interna |
| `Allocation Quota Reached` (486) | Mas de 4 allocations por usuario o 20 en total | Subir `user-quota` / `total-quota` en `turnserver.conf` y recrear coturn |
| coturn no arranca | Opcion invalida para la version | `docker compose logs coturn`; en 4.18 `no-cli` y `no-dtls` ya no existen |

### Costos de trafico
El audio es Opus ~32 kbps por sentido (~40-50 kbps con cabeceras IP/UDP/RTP). Con relay, el servidor recibe y reenvia
ambos sentidos: ~100 kbps de salida por llamada ~ **45 MB por hora de llamada** (~20 MB por sentido). Un VPS comun trae
1-2 TB/mes: sobra. Solo se usa relay cuando no hay camino directo; el video (MediaMTX) es aparte. Topes:
`max-bps=64000` B/s por sesion y `bps-capacity=500000` B/s total.

### Actualizar coturn
Cambiar la etiqueta en `docker-compose.yml` (`coturn/coturn:<version>-r<N>`, ver
https://hub.docker.com/r/coturn/coturn/tags), revisar las notas de version por opciones eliminadas y:
`docker compose pull coturn && docker compose up -d coturn`.

## 11. Audio del casco

**Problema.** El casco envia video H.264 + audio AAC por RTMP. El navegador (WebRTC/WHEP) solo reproduce Opus o G.711 y MediaMTX
no transcodifica. Solucion: el casco publica en `ingest/<id>` y un `ffmpeg` dentro del contenedor lo republica en `live/<id>`
con el **video copiado** (sin recodificar) y el **audio en Opus mono 24 kbps / 48 kHz**. El visor no cambia: sigue leyendo
`https://<dominio>/live/<id>/whep`.

```
Casco --RTMP--> ingest/<id> (H.264+AAC) --ffmpeg (relay-audio.sh)--> live/<id> (H.264+Opus) --WHEP--> Visor
Casco viejo (solo video) --RTMP--> live/<id> ------------------------------------------------^   (sigue funcionando)
```

| Pieza | Donde | Que hace |
|---|---|---|
| `mediamtx.yml` -> `paths` `~^ingest/<id>$` | servidor | `runOnAvailable: sh /relay-audio.sh` + `runOnAvailableRestart: yes` (arranca cuando el casco empieza a publicar, termina cuando corta, reintenta cada 5 s si falla) |
| `relay-audio.sh` | montado en el contenedor | valida el `<id>`, toma el JWT del casco de la query y ejecuta ffmpeg con baja latencia (`-fflags +nobuffer`, `-flags +low_delay`, `-muxdelay 0`, `-flush_packets 1`) |
| imagen `bluenviron/mediamtx:1.21.2-ffmpeg` | `docker-compose.yml` | Alpine + ffmpeg (con libopus) |
| RTSP en `127.0.0.1:8554` | solo dentro del contenedor | canal interno entre MediaMTX y ffmpeg; no se publica |

**Que ruta usa el casco.** `rtmp://<dominio>:1935/ingest/<id>?user=device&pass=<JWT>` (video+audio). El casco anterior, que
publica solo video en `live/<id>`, sigue funcionando sin cambios.

**Autorizacion (importante).** El relay NO tiene permisos propios: reusa el mismo JWT del casco (`pass=` / `token=` de la
query de `ingest/<id>`), asi que **todo pasa por la Edge Function `media-auth`** y no hay ninguna ruta sin autenticar
(`authHTTPExclude` solo filtra por accion y path, no por IP, por eso no se usa). La funcion debe permitir al rol `device`:

| Accion | Path | Quien |
|---|---|---|
| `publish` | `ingest/<su device_id>` | el casco (nueva regla) |
| `read` | `ingest/<su device_id>` | el mismo casco, porque ffmpeg lee con su JWT (nueva regla) |
| `publish` | `live/<su device_id>` | el casco / su relay (regla actual) |
| `read` | `live/<id>` | solo `viewer`/`admin` (regla actual); los visores NUNCA leen `ingest/` |

Sin la regla de `read` en `ingest/`, ffmpeg recibe 401 y en los logs aparece `401`/`authentication failed` cada 5 s.
El JWT dura 1 h pero solo se valida al conectar; la transmision del casco esta limitada a 10 min, asi que un reinicio
del relay siempre ocurre con el token vigente.

**Consumo estimado (1 vCPU / ~950 MB).** Video copiado: ~0 CPU. Audio mono 24 kbps: ~1-3 % de un vCPU y ~40-60 MB de RAM
por casco transmitiendo (el contenedor tiene tope `mem_limit: 400m`, `cpus: 0.8`). Sin cascos: ~40 MB de MediaMTX.
Con 1-3 cascos simultaneos sobra margen; coturn y Caddy no se ven afectados.

**Ver los logs de ffmpeg.** Salen mezclados con los de MediaMTX (nivel `warning`):

```bash
cd casco/server
docker compose logs -f --tail 80 mediamtx
docker compose logs --tail 200 mediamtx | grep -i -E "runOnAvailable|ffmpeg|ingest/|live/|opus"
docker compose exec mediamtx ps | grep ffmpeg     # ffmpeg vivo mientras el casco transmite
```

Un arranque sano muestra, para `ingest/<id>`, "stream is available" con las pistas (H264, MPEG-4 Audio) y despues para
`live/<id>` "(H264, Opus)".

**Probar sin casco.** Modo prueba + `bash test/test-audio.sh live.tudominio.com` (ver `test/`): publica testsrc + sine por
RTMP a `ingest/test` y comprueba por WHEP que `live/test` ofrece H264 y Opus.

### Problemas comunes (audio)

| Sintoma | Causa probable | Solucion |
|---|---|---|
| El visor ve video pero sin audio | El casco publica en `live/<id>` (ruta vieja, solo video) o no manda audio | Confirmar que usa `ingest/<id>`; ver en logs si `ingest/<id>` trae pista de audio |
| `ingest/<id>` esta online pero `live/<id>` no existe | ffmpeg no arranca o recibe 401 | Logs (arriba). 401 = falta la regla `read` de `ingest/` en `media-auth` o JWT vencido. `executable file not found` = no se esta usando la imagen `-ffmpeg` (`docker compose images`) |
| ffmpeg se reinicia en bucle cada 5 s | Fallo repetido (auth, codec de audio no soportado, `relay-audio.sh` con finales de linea CRLF) | Leer el error de ffmpeg en los logs; el script debe tener LF (el repo lo fuerza con `.gitattributes`) |
| `relay-audio: ... no envio pass= ni token=` | El casco publico sin credenciales en la query | Revisar la URL de ingest del casco |
| Audio desfasado respecto al video | Reloj del audio del casco con deriva, o picos de red | Agregar `-af aresample=async=1:first_pts=0` antes de `-c:a` en `relay-audio.sh`; revisar que el casco manda AAC-LC 44.1/48 kHz |
| Audio entrecortado / "robotico" | CPU saturada del VPS | `docker stats`; subir `-b:a` a 32k o liberar CPU; no usar `-ar` menor a 48000 |
| Latencia de audio mayor que la del video | Buffer del navegador al sincronizar | Es normal ~100-300 ms; el relay agrega < 100 ms |
| `unknown encoder 'libopus'` | Imagen no es la `-ffmpeg` oficial | Volver a `bluenviron/mediamtx:1.21.2-ffmpeg` y `docker compose pull && docker compose up -d` |
