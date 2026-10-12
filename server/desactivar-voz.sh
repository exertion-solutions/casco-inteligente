#!/bin/sh
# Revierte activar-voz.sh: detiene y quita el contenedor coturn y cierra sus puertos en ufw.
# NO toca mediamtx ni caddy. Idempotente. Ejecutar como root en la consola del VPS.
# El TURN_SECRET se CONSERVA en .env a proposito: docker-compose.yml lo exige (${TURN_SECRET:?})
# y sin el, ningun comando docker compose (ni mediamtx ni caddy) funcionaria.
# Uso:  sh desactivar-voz.sh        (CASCO_DIR=/otra/ruta para otra carpeta)
set -eu

DIR="${CASCO_DIR:-/root/casco/server}"
fail() { echo "ERROR: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || fail "ejecutar como root."
command -v docker >/dev/null 2>&1 || fail "docker no esta instalado."
if docker compose version >/dev/null 2>&1; then DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"
else fail "no se encontro 'docker compose'."; fi
[ -d "$DIR" ] || fail "no existe $DIR (usar CASCO_DIR=<ruta>)."
cd "$DIR"

echo ">> Quitando coturn"
if docker ps -a --format '{{.Names}}' | grep -q coturn; then
  $DC rm -sf coturn
else
  echo "   coturn no existe (nada que quitar)"
fi

echo ">> Cerrando puertos TURN en ufw"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q 'Status: active'; then
  ufw delete allow 3478/udp >/dev/null 2>&1 || true
  ufw delete allow 3478/tcp >/dev/null 2>&1 || true
  ufw delete allow 49160:49200/udp >/dev/null 2>&1 || true
  echo "   reglas 3478 y 49160:49200 quitadas"
fi

echo ">> Estado"
docker ps --format '   {{.Names}}: {{.Status}}'
free -m | sed -n '1,2p'
cat <<'MSG'

Voz desactivada en el VPS. Para que el visor no la ofrezca: VOICE_ENABLED: false en web/config.js.
Reactivar: sh activar-voz.sh
MSG
