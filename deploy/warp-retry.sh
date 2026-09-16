#!/bin/bash
# Sonic VPN: повторная попытка регистрации WARP (Cloudflare режет 429 с этого IP).
# Cron: 0 4 * * 0 root /opt/warp-retry.sh  (раз в неделю)
# При успехе — дописать wireguard-выход в мост вручную (см. PROJECT_STATE).
export SSHPASS=$(grep -E '^XUI_REMOTE_PASSWORD=' /opt/sonicvpn/server/.env | cut -d= -f2)
R="sshpass -e ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no root@185.125.102.135"
if $R 'test -f /opt/wgcf-profile.conf'; then echo "warp already registered"; exit 0; fi
OUT=$($R 'cd /opt && wgcf register --accept-tos 2>&1 | tail -2')
echo "$OUT"
echo "$OUT" | grep -qi "429" && echo "still rate-limited, will retry next week" || echo "REGISTER-ATTEMPTED-check manually"
