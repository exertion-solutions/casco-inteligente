#!/bin/sh
# Soporte remoto del VPS (autorizado por el usuario): (1) autoriza la llave del asistente, (2) diagnostico del video, (3) voz.
# Ejecutar como root en la CONSOLA del VPS. Idempotente. Revocar la llave: sh vps-soporte.sh --revocar
set -u
KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFvErVSBF53b6j2uZHL/HY5hNjDtVPubrI4LL7IuaqQc claude-casco-vps-2'
mkdir -p /root/.ssh && chmod 700 /root/.ssh
if [ "${1:-}" = "--revocar" ]; then
  grep -v "claude-casco-vps-2" /root/.ssh/authorized_keys > /root/.ssh/ak.tmp 2>/dev/null; cat /root/.ssh/ak.tmp > /root/.ssh/authorized_keys; rm -f /root/.ssh/ak.tmp
  echo "llave del asistente REVOCADA"; exit 0
fi
grep -qF "claude-casco-vps-2" /root/.ssh/authorized_keys 2>/dev/null || echo "$KEY" >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
echo ">> llave autorizada"
{ date; free -m; df -h / | tail -1; docker ps --format '{{.Names}} {{.Status}}'; echo; docker logs --since 20m casco-video-mediamtx-1 2>&1 | grep -v 'WebRTC\] \[session' | tail -40; } > /root/diag.txt 2>&1
echo ">> diagnostico guardado en /root/diag.txt"
echo ">> LISTO. Avisale al asistente."
