#!/usr/bin/env bash
# Verifica que coturn responde: STUN Binding Request (UDP y TCP 3478), sin credenciales.
# Uso: ./test/test-turn.sh <host_o_ip> [puerto]     (solo bash: usa /dev/udp y /dev/tcp)
# Un exito significa que el puerto esta abierto y coturn vivo. NO prueba el relay
# (49160-49200/udp ni las credenciales): para eso usar test/turn-creds.sh + Trickle ICE.
set -u
HOST="${1:?uso: $0 <host_o_ip> [puerto]}"
PORT="${2:-3478}"
command -v od >/dev/null || { echo "falta od"; exit 1; }

# Binding Request: tipo 0x0001, largo 0, magic cookie 0x2112A442, 12 bytes de transaction id.
REQ='\x00\x01\x00\x00\x21\x12\xa4\x42\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c'
ok=0

# Lee 2 bytes del descriptor $1 con el builtin read (max 3 s) y los devuelve en hex.
rd2() { local r=""; IFS= read -r -t 3 -N 2 r <&"$1" || true; printf '%s' "$r" | od -An -tx1 | tr -d ' \n'; }

check() { # $1 = nombre, $2 = primeros 2 bytes de la respuesta en hex
  case "$2" in
    0101) echo "OK    $1: STUN Binding Success Response (0x0101)" ;;
    *) echo "FALLA $1: sin respuesta valida (${2:-vacio})"; ok=1 ;;
  esac
}

# UDP
if exec 3<>"/dev/udp/$HOST/$PORT" 2>/dev/null; then
  printf "$REQ" >&3
  check "udp/$PORT" "$(rd2 3)"
  exec 3<&- 3>&-
else
  echo "FALLA udp/$PORT: no se pudo abrir el socket"; ok=1
fi

# TCP
if exec 4<>"/dev/tcp/$HOST/$PORT" 2>/dev/null; then
  printf "$REQ" >&4
  check "tcp/$PORT" "$(rd2 4)"
  exec 4<&- 4>&-
else
  echo "FALLA tcp/$PORT: no conecta (puerto cerrado o firewall)"; ok=1
fi

[ $ok = 0 ] && echo "TODO OK" || echo "HAY FALLAS (UDP bloqueado, firewall del proveedor o coturn caido: docker compose logs coturn)"
exit $ok
