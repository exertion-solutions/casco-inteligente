#!/bin/sh
# Relay de audio: lee ingest/<id> (H.264 + AAC del casco) y republica live/<id>
# con el video copiado y el audio en Opus mono (lo unico que el navegador/WHEP reproduce).
# Lo lanza MediaMTX (runOnAvailable) con las variables MTX_PATH, MTX_QUERY y RTSP_PORT.
# Usa el MISMO JWT con que el casco publico en ingest/<id>: la autorizacion la sigue
# resolviendo media-auth; no hay ninguna excepcion de autenticacion para loopback.
set -eu

ID="${MTX_PATH#ingest/}"
case "$ID" in
  ''|*[!A-Za-z0-9_-]*) echo "relay-audio: id invalido: $ID" >&2; exit 1 ;;
esac

# El casco publica con ?user=device&pass=<JWT> (o ?token=<JWT>). MTX_QUERY llega url-encoded.
TOKEN="$(printf '%s' "${MTX_QUERY:-}" | tr '&' '\n' | grep -E '^(pass|token)=' | head -n 1 | cut -d= -f2-)"
if [ -z "$TOKEN" ]; then
  echo "relay-audio: el publisher de ingest/$ID no envio pass= ni token= en la query" >&2
  exit 1
fi

BASE="rtsp://127.0.0.1:${RTSP_PORT:-8554}"

# Entrada: sin buffer y sondeo corto. Salida: audio Opus mono 24 kbps, video sin tocar.
# -map "0:a:0?" => si el casco no manda audio, igual se republica el video.
exec ffmpeg -hide_banner -nostdin -nostats -loglevel warning \
  -fflags +nobuffer -flags +low_delay -analyzeduration 1000000 -probesize 500000 \
  -rtsp_transport tcp -i "$BASE/ingest/$ID?token=$TOKEN" \
  -map 0:v:0 -map "0:a:0?" \
  -c:v copy \
  -c:a libopus -application lowdelay -b:a 24k -ar 48000 -ac 1 \
  -muxdelay 0 -flush_packets 1 \
  -f rtsp -rtsp_transport tcp "$BASE/live/$ID?token=$TOKEN"
