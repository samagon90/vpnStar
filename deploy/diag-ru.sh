#!/usr/bin/env bash
# v5: код с git, XUI_PUB_KEY из аргумента (реальный ключ с DE), рестарт, E2E.
set +e
NEW_PUB="${1:-}"
[ -n "$NEW_PUB" ] || { echo "RU_FAIL: no public key argument"; exit 1; }

echo "=== update site code (/opt/sonicvpn) from git ==="
git -C /opt/sonicvpn fetch -q origin arena/01a05219-vpnstar && \
  git -C /opt/sonicvpn reset --hard -q origin/arena/01a05219-vpnstar && \
  git -C /opt/sonicvpn log --oneline -1
cd /opt/sonicvpn/server || { echo "RU_FAIL: no /opt/sonicvpn/server"; exit 1; }
npm install --no-audit --no-fund --loglevel=error >/dev/null 2>&1

echo "=== fix .env: XUI_PUB_KEY (len ${#NEW_PUB}) ==="
sed -i "s#^XUI_PUB_KEY=.*#XUI_PUB_KEY=$NEW_PUB#" .env
grep '^XUI_BASE=\|^XUI_PUB_KEY=' .env

pm2 restart sonicvpn >/dev/null 2>&1
sleep 3
echo "health: $(curl -s --max-time 5 http://127.0.0.1:3000/api/health)"

echo "=== E2E: register diag user -> device -> vless link ==="
TS=$(date +%s)
REG=$(curl -s --max-time 120 -X POST http://127.0.0.1:3000/api/register -H 'Content-Type: application/json' \
  -d "{\"username\":\"diag$TS\",\"password\":\"12345678\"}")
echo "register: $(printf '%s' "$REG" | head -c 160)"
J2=/tmp/diag_$$.jar
curl -s -c "$J2" --max-time 10 -X POST http://127.0.0.1:3000/api/login -H 'Content-Type: application/json' \
  -d "{\"username\":\"diag$TS\",\"password\":\"12345678\"}" >/dev/null
DEV=$(curl -s --max-time 10 -b "$J2" http://127.0.0.1:3000/api/devices | grep -oE '"id":[0-9]+' | head -1 | grep -oE '[0-9]+')
L=$(curl -s --max-time 120 -b "$J2" "http://127.0.0.1:3000/api/devices/$DEV" | grep -oE 'vless://[^"]*' | head -1)
rm -f "$J2"
echo "vless link: $(printf '%s' "$L" | head -c 230)..."
case "$L" in
  *"$NEW_PUB"*)
    if printf '%s' "$L" | grep -qE '^vless://[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}@'; then
      echo "RU_OK: РЕАЛЬНАЯ ССЫЛКА — ключ и UUID на месте, цепочка работает"
    else
      echo "RU_FAIL: ключ есть, но UUID в ссылке некорректный: $(printf '%s' "$L" | head -c 80)"
    fi ;;
  *) echo "RU_FAIL: ссылка всё ещё не реальная — pm2 logs sonicvpn --nostream --lines 20" ;;
esac

AT=$(grep '^ADMIN_TOKEN=' .env | cut -d= -f2)
UROW=$(curl -s --max-time 10 -H "x-admin-token: $AT" "http://127.0.0.1:3000/api/admin/users?search=diag$TS")
DIAGUID=$(printf '%s' "$UROW" | grep -oE '"id":[0-9]+' | head -1 | grep -oE '[0-9]+')
if [ -n "$DIAGUID" ]; then
  curl -s --max-time 30 -X DELETE -H "x-admin-token: $AT" "http://127.0.0.1:3000/api/admin/users/$DIAGUID" >/dev/null && echo "diag user cleaned up"
fi
echo "=== DONE ==="
