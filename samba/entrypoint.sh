#!/bin/sh
# Crée le compte de lecture du partage et lance Samba au premier plan.
set -eu

: "${SMB_USER:=altium}"
: "${SMB_PASSWORD:?SMB_PASSWORD doit être défini dans .env}"
: "${SMB_SHARE:=altium-lib}"
: "${SMB_WORKGROUP:=WORKGROUP}"
export SMB_USER SMB_SHARE SMB_WORKGROUP

sed -e "s|\${SMB_USER}|$SMB_USER|g" -e "s|\${SMB_SHARE}|$SMB_SHARE|g" -e "s|\${SMB_WORKGROUP}|$SMB_WORKGROUP|g" \
    /etc/samba/smb.conf.tpl > /etc/samba/smb.conf

if ! id "$SMB_USER" >/dev/null 2>&1; then
  useradd -M -s /usr/sbin/nologin "$SMB_USER"
fi
printf '%s\n%s\n' "$SMB_PASSWORD" "$SMB_PASSWORD" | smbpasswd -a -s "$SMB_USER" >/dev/null

mkdir -p /data/lib
exec smbd --foreground --no-process-group --debug-stdout
