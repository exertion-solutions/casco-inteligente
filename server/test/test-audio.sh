#!/usr/bin/env bash
# Prueba del relay de audio (ingest/<id> AAC -> live/<id> Opus). Correr desde tu PC con ffmpeg.
# Requiere el servidor en MODO PRUEBA (test/docker-compose.override.test.yml).
# Uso:  bash test/test-audio.sh live.tudominio.com [segundos]
set -u
HOST="${1:?Uso: bash test/test-audio.sh <dominio-del-servidor> [segundos]}"
SECS="${2:-25}"
CRED_USER=test; CRED_PASS=prueba-casco-1234; ID=test
for c in ffmpeg ffprobe curl; do command -v "$c" >/dev/null || { echo "Falta $c en el PATH"; exit 1; }; done

fail=0
ok()  { echo "OK    $*"; }
bad() { echo "FALLA $*"; fail=1; }

echo ">> Publicando video+audio de prueba (H.264 + AAC) por RTMP a ingest/$ID durante ${SECS}s"
ffmpeg -hide_banner -loglevel error -re \
  -f lavfi -i "testsrc=size=640x480:rate=15" -f lavfi -i "sine=frequency=440:sample_rate=44100" \
  -t "$SECS" -c:v libx264 -profile:v baseline -preset veryfast -tune zerolatency -g 30 -b:v 800k -pix_fmt yuv420p \
  -c:a aac -b:a 64k -ac 1 -f flv "rtmp://$HOST:1935/ingest/$ID?user=$CRED_USER&pass=$CRED_PASS" &
PUB=$!
trap 'kill $PUB 2>/dev/null' EXIT
sleep 8   # tiempo para que arranque ffmpeg en el servidor

kill -0 $PUB 2>/dev/null && ok "el publish RTMP a ingest/$ID sigue conectado" || bad "el publish RTMP a ingest/$ID termino antes de tiempo (puerto 1935 / credenciales)"

echo ">> Pidiendo WHEP a live/$ID con una oferta SDP que acepta H264 + Opus"
OFFER=$'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0 1\r\na=ice-ufrag:test\r\na=ice-pwd:testtesttesttesttesttest\r\na=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF\r\na=setup:actpass\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 0.0.0.0\r\na=mid:0\r\na=recvonly\r\na=rtcp-mux\r\na=rtpmap:96 H264/90000\r\na=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=mid:1\r\na=recvonly\r\na=rtcp-mux\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n'
TMP="$(mktemp)"
CODE="$(curl -s -o "$TMP" -w '%{http_code}' -X POST "https://$HOST/live/$ID/whep" \
  -u "$CRED_USER:$CRED_PASS" -H 'Content-Type: application/sdp' --data-binary "$OFFER")"
echo "   HTTP $CODE"
if [ "$CODE" = "201" ]; then
  ok "live/$ID existe y WHEP respondio 201 (la sesion se abandona sola)"
  grep -qi 'a=rtpmap:[0-9]* H264' "$TMP" && ok "la respuesta incluye video H264" || bad "la respuesta no incluye video H264"
  if grep -qi 'a=rtpmap:[0-9]* opus' "$TMP"; then ok "la respuesta incluye audio Opus (el relay funciona)"
  else bad "la respuesta NO incluye audio Opus: ffmpeg no esta republicando (ver docker compose logs mediamtx)"; fi
else
  bad "WHEP no dio 201 (404 = live/$ID no existe: el relay no publico; 401 = credenciales; 400 = oferta rechazada)"
fi
rm -f "$TMP"

echo ">> Informativo: ffprobe por RTMP a live/$ID (MediaMTX puede no entregar Opus por RTMP; no cuenta como falla)"
ffprobe -v error -timeout 10000000 -show_entries stream=codec_type,codec_name -of csv=p=0 \
  "rtmp://$HOST:1935/live/$ID?user=$CRED_USER&pass=$CRED_PASS" 2>&1 | sed 's/^/   /' || true

echo
[ "$fail" = 0 ] && echo "RESULTADO: OK" || { echo "RESULTADO: HAY FALLAS. En el VPS: docker compose logs --tail 60 mediamtx | grep -i -E 'ffmpeg|relay|ingest|live/'"; exit 1; }
