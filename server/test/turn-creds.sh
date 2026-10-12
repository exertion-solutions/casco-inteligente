#!/usr/bin/env bash
# Genera credenciales TURN temporales (TURN REST API, HMAC-SHA1) con el mismo formato JSON
# que la Edge Function turn-credentials. Necesita openssl (Linux, Mac, Git Bash).
# Uso (en el VPS, carpeta server/):   ./test/turn-creds.sh [usuario] [ttl_segundos]
# El secreto se toma de $TURN_SECRET o de ../.env (nunca se imprime).
set -eu
USER_NAME="${1:-test}"
TTL="${2:-3600}"
ENV_FILE="$(dirname "$0")/../.env"
get() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | tr -d '\r"' || true; }
SECRET="${TURN_SECRET:-$(get TURN_SECRET)}"
HOST="${TURN_HOST:-$(get TURN_HOST)}"; HOST="${HOST:-${PUBLIC_IP:-$(get PUBLIC_IP)}}"
[ -n "$SECRET" ] || { echo "Falta TURN_SECRET (variable de entorno o .env)" >&2; exit 1; }
[ -n "$HOST" ]   || { echo "Falta TURN_HOST o PUBLIC_IP (variable de entorno o .env)" >&2; exit 1; }
case "$USER_NAME" in *[!A-Za-z0-9_-]*|"") echo "usuario: solo letras, numeros, _ y -" >&2; exit 1 ;; esac

EXP=$(( $(date +%s) + TTL ))
USERNAME="$EXP:$USER_NAME"
CRED=$(printf '%s' "$USERNAME" | openssl dgst -sha1 -hmac "$SECRET" -binary | openssl base64 -A)
printf '{"urls":["stun:%s:3478","turn:%s:3478?transport=udp","turn:%s:3478?transport=tcp"],"username":"%s","credential":"%s","ttl":%s}\n' \
  "$HOST" "$HOST" "$HOST" "$USERNAME" "$CRED" "$TTL"
