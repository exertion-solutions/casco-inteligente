#!/bin/sh
# RESCATE del VPS (autorizado por el usuario). Ejecutar en el shell de la ISO "SystemRescue" de Vultr.
# Monta el disco del servidor, agrega la llave SSH del asistente a root y desmonta. No borra ni cambia nada mas.
set -u
KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFvErVSBF53b6j2uZHL/HY5hNjDtVPubrI4LL7IuaqQc claude-casco-vps-2'
mkdir -p /mnt/vps
OK=0
for DEV in $(lsblk -pnro NAME,TYPE,FSTYPE | awk '$2=="part" && ($3=="ext4"||$3=="xfs"||$3=="btrfs"){print $1}'); do
  mount "$DEV" /mnt/vps 2>/dev/null || continue
  if [ -f /mnt/vps/etc/os-release ] && grep -qi ubuntu /mnt/vps/etc/os-release && [ -d /mnt/vps/root ]; then
    mkdir -p /mnt/vps/root/.ssh && chmod 700 /mnt/vps/root/.ssh
    grep -qF "claude-casco-vps-2" /mnt/vps/root/.ssh/authorized_keys 2>/dev/null || echo "$KEY" >> /mnt/vps/root/.ssh/authorized_keys
    chmod 600 /mnt/vps/root/.ssh/authorized_keys
    sync
    echo "OK: llave agregada en $DEV (/root/.ssh/authorized_keys)"
    grep -c . /mnt/vps/root/.ssh/authorized_keys | sed 's/^/lineas en authorized_keys: /'
    OK=1
    umount /mnt/vps
    break
  fi
  umount /mnt/vps 2>/dev/null
done
[ "$OK" = 1 ] && echo ">> LISTO. Ahora en Vultr: Settings > Custom ISO > Detach (el servidor reinicia desde su disco)." || echo "ERROR: no encontre el disco de Ubuntu. Mandale al asistente la salida de: lsblk -f"
