#!/usr/bin/env bash
# Uso: ./test-cors.sh <dominio> [origen]   (necesita curl; sirve en Linux, Mac y Git Bash)
set -u
DOM="${1:?uso: $0 <dominio> [origen]}"
ORIGIN="${2:-https://exertion-solutions.github.io}"
H=$(curl -sS -o /dev/null -D - -X OPTIONS "https://$DOM/live/test/whep" \
  -H "Origin: $ORIGIN" -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: authorization,content-type" | tr -d '\r') \
  || { echo "FALLO: no conecta con $DOM"; exit 1; }
echo "$H" | head -1
ok=0
chk() { echo "$H" | grep -iq "^$1:.*$2" && echo "OK    $1 ~ $2" || { echo "FALLA $1 (esperado: $2)"; ok=1; }; }
chk access-control-allow-origin "$ORIGIN"
chk access-control-allow-methods "POST"
chk access-control-allow-methods "PATCH"
chk access-control-allow-methods "DELETE"
chk access-control-allow-headers "authorization"
chk access-control-allow-headers "content-type"
echo "$H" | head -1 | grep -q " 204" || { echo "FALLA estado (esperado 204)"; ok=1; }
[ $ok = 0 ] && echo "TODO OK" || echo "HAY FALLAS"
exit $ok
