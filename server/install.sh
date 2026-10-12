#!/usr/bin/env bash
# Instalador del servidor de video (Ubuntu 22.04/24.04 limpio). Se puede correr varias veces.
# Uso:  sudo ./install.sh --admin-ip <TU_IP_PUBLICA>     (o --admin-ip any para no restringir SSH)
set -euo pipefail

ADMIN_IP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --admin-ip) ADMIN_IP="${2:-}"; shift 2 ;;
    *) echo "Argumento desconocido: $1"; exit 1 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "Ejecutar con sudo:  sudo ./install.sh --admin-ip <TU_IP>"; exit 1; }
[ -n "$ADMIN_IP" ] || { echo "Falta --admin-ip. Ejemplo: sudo ./install.sh --admin-ip 200.1.2.3"; exit 1; }
if [ "$ADMIN_IP" != "any" ] && ! [[ "$ADMIN_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
  echo "--admin-ip debe ser una IPv4 (ej. 200.1.2.3) o la palabra any"; exit 1
fi

cd "$(dirname "$(readlink -f "$0")")"

# --- .env ---
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Se creo .env. Editalo (nano .env), completa LIVE_DOMAIN, PUBLIC_IP y MEDIA_AUTH_URL y volve a correr este script."
  exit 1
fi
set -a; . ./.env; set +a
for v in LIVE_DOMAIN PUBLIC_IP MEDIA_AUTH_URL; do
  [ -n "${!v:-}" ] || { echo "Falta $v en .env"; exit 1; }
done
case "$MEDIA_AUTH_URL" in https://*) ;; *) echo "MEDIA_AUTH_URL debe empezar con https://"; exit 1 ;; esac

echo ">> Paquetes base"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl ufw fail2ban dnsutils

echo ">> Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

echo ">> Firewall (ufw)"
ufw default deny incoming
ufw default allow outgoing
if [ "$ADMIN_IP" = "any" ]; then
  ufw allow 22/tcp
else
  ufw allow from "$ADMIN_IP" to any port 22 proto tcp
fi
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 1935/tcp
ufw allow 8189/udp
ufw allow 8189/tcp
ufw --force enable

echo ">> fail2ban (SSH)"
cat > /etc/fail2ban/jail.d/casco.local <<'EOF'
[sshd]
enabled = true
maxretry = 5
findtime = 10m
bantime = 1h
EOF
systemctl enable fail2ban
systemctl restart fail2ban

echo ">> Chequeo de DNS"
DNS_IP="$(dig +short A "$LIVE_DOMAIN" | tail -1 || true)"
if [ "$DNS_IP" != "$PUBLIC_IP" ]; then
  echo "AVISO: $LIVE_DOMAIN resuelve a '${DNS_IP:-nada}' y PUBLIC_IP es '$PUBLIC_IP'."
  echo "       Sin el registro A correcto, Caddy no podra emitir el certificado HTTPS."
fi

echo ">> Levantando MediaMTX + Caddy"
docker compose pull
docker compose up -d
sleep 5

cat <<EOF

================ RESUMEN ================
Dominio:        https://$LIVE_DOMAIN
Visor (WHEP):   https://$LIVE_DOMAIN/live/<id>/whep
Ingest (RTMP):  rtmp://$LIVE_DOMAIN:1935/live/<id>
Firewall:       22 (solo $ADMIN_IP), 80, 443, 1935, 8189/udp, 8189/tcp
Contenedores:
$(docker compose ps --format 'table {{.Name}}\t{{.Status}}')

Verificacion:
  docker compose logs --tail 30 caddy       # buscar "certificate obtained"
  docker compose logs --tail 30 mediamtx    # buscar "listener opened"
  curl -i https://$LIVE_DOMAIN/             # debe responder 404 "no encontrado"
  ./test/test-cors.sh $LIVE_DOMAIN          # CORS del visor
  sudo ufw status
=========================================
EOF
