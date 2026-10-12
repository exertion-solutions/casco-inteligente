#!/bin/sh
# Activa la voz en vivo (coturn) en un VPS que ya corre MediaMTX + Caddy. Idempotente.
# NO toca mediamtx ni caddy: solo agrega/levanta el contenedor coturn.
# Ejecutar como root en la CONSOLA del VPS (ver server/README.md, seccion "Activar la voz").
#
# Uso:
#   sh activar-voz.sh                 usa los archivos que ya estan en la carpeta (subidos con scp/pegados)
#   sh activar-voz.sh --descargar     baja docker-compose.yml y turnserver.conf de GitHub (main)
#   CASCO_DIR=/otra/ruta sh activar-voz.sh      (por defecto /root/casco/server)
set -eu

DIR="${CASCO_DIR:-/root/casco/server}"
RAW="https://raw.githubusercontent.com/exertion-solutions/casco-inteligente/main/server"
PROJECT_REF="zgfvhjpdzkohouktakvt"
MIN_MB=150
DESCARGAR=0
for a in "$@"; do
  case "$a" in
    --descargar) DESCARGAR=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "Argumento desconocido: $a"; exit 1 ;;
  esac
done

fail() { echo "ERROR: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || fail "ejecutar como root (en la consola de Vultr ya lo sos)."
command -v docker >/dev/null 2>&1 || fail "docker no esta instalado: este VPS no tiene el servidor de video."
if docker compose version >/dev/null 2>&1; then DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"
else fail "no se encontro 'docker compose'."; fi
[ -d "$DIR" ] || fail "no existe $DIR (carpeta del servidor de video). Usar CASCO_DIR=<ruta>."
cd "$DIR"
[ -f .env ] || fail "falta $DIR/.env: el servidor de video no esta instalado (ver README)."

echo ">> 1/6 Memoria libre"
free -m | sed -n '1,2p'
AVAIL="$(free -m | awk '/^Mem:/ {print $7}')"
case "$AVAIL" in ''|*[!0-9]*) fail "no pude leer la memoria disponible (free -m)." ;; esac
[ "$AVAIL" -ge "$MIN_MB" ] || fail "solo hay $AVAIL MB disponibles (minimo $MIN_MB). No se hizo ningun cambio."
echo "   disponible: $AVAIL MB (minimo $MIN_MB): OK"

echo ">> 2/6 TURN_SECRET en .env"
chmod 600 .env
if grep -q '^TURN_SECRET=.\{16,\}' .env; then
  echo "   ya existe (no se cambia)"
else
  command -v openssl >/dev/null 2>&1 || fail "falta openssl (apt-get install -y openssl)."
  NEW="$(openssl rand -hex 32)"
  sed -i '/^TURN_SECRET=/d' .env
  [ -z "$(tail -c1 .env)" ] || echo >> .env
  echo "TURN_SECRET=$NEW" >> .env
  chmod 600 .env
  unset NEW
  echo "   generado y guardado en $DIR/.env"
fi
grep -q '^PUBLIC_IP=.\+' .env || fail "falta PUBLIC_IP en .env (la IP publica del VPS)."
PUBLIC_IP="$(sed -n 's/^PUBLIC_IP=//p' .env | tail -1)"

echo ">> 3/6 docker-compose.yml y turnserver.conf"
if [ "$DESCARGAR" -eq 1 ]; then
  command -v curl >/dev/null 2>&1 || fail "falta curl."
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  for f in docker-compose.yml turnserver.conf; do
    curl -fsSL "$RAW/$f" -o "$TMP/$f" || fail "no pude bajar $RAW/$f"
    [ -s "$TMP/$f" ] || fail "$f llego vacio."
    echo "   $f  sha256=$(sha256sum "$TMP/$f" | cut -d' ' -f1)"
  done
  grep -q 'coturn:' "$TMP/docker-compose.yml" || fail "el docker-compose.yml descargado no tiene coturn."
  for f in docker-compose.yml turnserver.conf; do
    if [ -f "$f" ] && cmp -s "$f" "$TMP/$f"; then
      echo "   $f: ya es igual (sin cambios)"
    else
      [ ! -f "$f" ] || cp -p "$f" "$f.bak-$(date +%Y%m%d%H%M%S)"
      cp "$TMP/$f" "$f"
      echo "   $f: actualizado (copia anterior: $f.bak-*)"
    fi
  done
else
  for f in docker-compose.yml turnserver.conf; do
    [ -f "$f" ] || fail "falta $DIR/$f. Subilo con scp, pegalo con nano, o corre: sh activar-voz.sh --descargar"
    echo "   $f  sha256=$(sha256sum "$f" | cut -d' ' -f1)"
  done
  grep -q 'coturn:' docker-compose.yml || fail "docker-compose.yml no tiene el servicio coturn: usa la version nueva del repo (--descargar)."
fi
$DC config -q || fail "docker-compose.yml no valida (revisar .env)."

echo ">> 4/6 Firewall (ufw)"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q 'Status: active'; then
  ufw allow 3478/udp >/dev/null
  ufw allow 3478/tcp >/dev/null
  ufw allow 49160:49200/udp >/dev/null
  echo "   abiertos 3478/udp, 3478/tcp, 49160:49200/udp"
else
  echo "   ufw no esta activo: nada que abrir aca."
fi
echo "   RECORDA: si Vultr tiene Firewall en el panel (Products > Firewall), abrir lo mismo alli."

echo ">> 5/6 Levantando SOLO coturn"
$DC up -d coturn
sleep 5

echo ">> 6/6 Verificacion"
docker ps --filter name=coturn --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
if ! docker ps --filter name=coturn --filter status=running --format '{{.Names}}' | grep -q coturn; then
  $DC logs --tail 30 coturn || true
  fail "coturn no quedo corriendo (ver logs arriba). mediamtx y caddy no se tocaron."
fi
if command -v ss >/dev/null 2>&1; then
  if ss -lun | grep -q ':3478 '; then echo "   UDP 3478 escuchando: OK"
  else echo "   AVISO: no veo UDP 3478 todavia (docker compose logs coturn)."; fi
fi
free -m | sed -n '1,2p'
docker ps --format '   {{.Names}}: {{.Status}}'

SECRET="$(sed -n 's/^TURN_SECRET=//p' .env | tail -1)"
cat <<MSG

=============== SIGUIENTE PASO (Supabase) ===============
1) Supabase > Edge Functions > Secrets > Add new secret. Crear DOS secretos:
     TURN_HOST   = $PUBLIC_IP
     TURN_SECRET = (la linea de abajo, solo lo que va despues del =)
2) Desplegar la funcion turn-credentials (sin "Verify JWT"). Con CLI, desde la carpeta del repo en tu PC:
     supabase functions deploy turn-credentials --no-verify-jwt --project-ref $PROJECT_REF
   Desde el dashboard: Edge Functions > Deploy a new function > Via Editor > nombre turn-credentials >
   pegar supabase/functions/turn-credentials/index.ts > Deploy > desactivar "Verify JWT".
3) Recien ahora: poner VOICE_ENABLED: true en web/config.js (ver docs/PROTOCOLO-VOZ.md).
=========================================================
MSG
echo "TURN_SECRET=$SECRET"
