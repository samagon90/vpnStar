#!/usr/bin/env bash
# v12: ДЕПЛОЙ кода (git), рестарт, E2E: ссылка БЕЗ encryption=, с реальным pbk и UUID;
#      + внешний зонд RU -> DE:443 (достижим ли 443 извне).
set +e
NEW_PUB="${1:-}"
DE_IP=185.125.102.135

echo "=== update site code (/opt/sonicvpn) from git ==="
git -C /opt/sonicvpn fetch -q origin arena/01a05219-vpnstar && \
  git -C /opt/sonicvpn reset --hard -q origin/arena/01a05219-vpnstar && \
  git -C /opt/sonicvpn log --oneline -1
cd /opt/sonicvpn/server || { echo "RU_FAIL: no /opt/sonicvpn/server"; exit 1; }
npm install --no-audit --no-fund --loglevel=error >/dev/null 2>&1
grep -c "encryption=none" src/vpn/xui.js >/dev/null 2>&1 && echo "RU_FAIL: encryption=none ЕЩЁ ЕСТЬ в xui.js" || echo "xui.js: encryption=none отсутствует (фикс на месте)"

[ -n "$NEW_PUB" ] && sed -i "s#^XUI_PUB_KEY=.*#XUI_PUB_KEY=$NEW_PUB#" .env
pm2 restart sonicvpn >/dev/null 2>&1
sleep 3
echo "health: $(curl -s --max-time 5 http://127.0.0.1:3000/api/health)"

echo "=== E2E: register diag user -> device -> vless link ==="
TS=$(date +%s)
REG=$(curl -s --max-time 120 -X POST http://127.0.0.1:3000/api/register -H 'Content-Type: application/json' \
  -d "{\"username\":\"diag$TS\",\"password\":\"12345678\"}")
echo "register: $(printf '%s' "$REG" | head -c 120)"
J2=/tmp/diag_$$.jar
curl -s -c "$J2" --max-time 10 -X POST http://127.0.0.1:3000/api/login -H 'Content-Type: application/json' \
  -d "{\"username\":\"diag$TS\",\"password\":\"12345678\"}" >/dev/null
DEV=$(curl -s --max-time 10 -b "$J2" http://127.0.0.1:3000/api/devices | grep -oE '"id":[0-9]+' | head -1 | grep -oE '[0-9]+')
L=$(curl -s --max-time 120 -b "$J2" "http://127.0.0.1:3000/api/devices/$DEV" | grep -oE 'vless://[^"]*' | head -1)
rm -f "$J2"
echo "vless link: $(printf '%s' "$L" | head -c 260)..."

case "$L" in
  *encryption=*) echo "RU_FAIL: в ссылке ЕСТЬ encryption= — код не обновился?";;
  *)
    case "$L" in
      *"$NEW_PUB"*)
        if printf '%s' "$L" | grep -qE '^vless://[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}@'; then
          echo "RU_OK: ссылка без encryption=, с реальным ключом и UUID"
        else
          echo "RU_FAIL: ключ есть, UUID некорректный: $(printf '%s' "$L" | head -c 80)"
        fi ;;
      *) echo "RU_FAIL: ключ не тот: $(printf '%s' "$L" | grep -oE 'pbk=[A-Za-z0-9+/=_-]*' | head -1)" ;;
    esac ;;
esac

echo "=== внешний зонд: RU -> DE:443 (SNI=amd.com) ==="
curl -sk --resolve amd.com:443:$DE_IP --max-time 10 https://amd.com/ -o /dev/null -w 'external probe DE:443: %{http_code} (200/301/403 = достижимо извне)\n'

AT=$(grep '^ADMIN_TOKEN=' .env | cut -d= -f2)
UROW=$(curl -s --max-time 10 -H "x-admin-token: $AT" "http://127.0.0.1:3000/api/admin/users?search=diag$TS")
DIAGUID=$(printf '%s' "$UROW" | grep -oE '"id":[0-9]+' | head -1 | grep -oE '[0-9]+')
if [ -n "$DIAGUID" ]; then
  curl -s --max-time 30 -X DELETE -H "x-admin-token: $AT" "http://127.0.0.1:3000/api/admin/users/$DIAGUID" >/dev/null && echo "diag user cleaned up"
fi
echo "=== DONE ==="
