#!/usr/bin/env bash
# v4: обновить код сайта (git), получить РЕАЛЬНЫЙ ключ из панели 3x-ui,
#     починить .env, перезапустить, проверить цепочку E2E с сервера.
set +e
PANEL="185.125.102.135:20461"
PPATH="/3dtIfnbTYAw5E0rNtB"
PUSER="12345678"
PPASS="12345678"

echo "=== update site code (/opt/sonicvpn) from git ==="
git -C /opt/sonicvpn fetch -q origin arena/01a05219-vpnstar && \
  git -C /opt/sonicvpn reset --hard -q origin/arena/01a05219-vpnstar && \
  git -C /opt/sonicvpn log --oneline -1
cd /opt/sonicvpn/server || { echo "no /opt/sonicvpn/server"; exit 1; }
npm install --no-audit --no-fund --loglevel=error >/dev/null 2>&1
grep -n "ufetch" src/vpn/xui.js | head -2

echo ""
echo "=== real public key from the panel (login via https from RU) ==="
J=/tmp/panel_$$.jar
rm -f "$J"
CSRFTOK=$(curl -sk -c "$J" --max-time 8 "https://$PANEL$PPATH/csrf-token" | grep -oE '"obj":"[^"]+"' | head -1 | cut -d'"' -f4)
echo "csrf token: ${CSRFTOK:0:12}..."
LOGIN=$(curl -sk -b "$J" -c "$J" --max-time 8 -X POST "https://$PANEL$PPATH/login" \
  -H "X-CSRF-Token: $CSRFTOK" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$PUSER\",\"password\":\"$PPASS\"}")
echo "login: $(printf '%s' "$LOGIN" | head -c 100)"
LINKS=$(curl -sk -b "$J" --max-time 10 "https://$PANEL$PPATH/panel/api/clients/links/sonic-main")
NEW_PUB=$(printf '%s' "$LINKS" | grep -oE 'pbk=[A-Za-z0-9+/=]+' | head -1 | sed 's/^pbk=//')
rm -f "$J"
echo "real pubkey from panel: $NEW_PUB (len ${#NEW_PUB})"

if [ ${#NEW_PUB} -lt 40 ]; then
  echo "❌ Не удалось получить реальный ключ из панели — авто-фикс отменён"
  echo "   (возможно, сработал login-limiter панели: 5 попыток / 5 минут)"
  exit 1
fi

echo ""
echo "=== fix .env: XUI_PUB_KEY = real key (XUI_BASE=https остаётся — панель на https) ==="
sed -i "s#^XUI_PUB_KEY=.*#XUI_PUB_KEY=$NEW_PUB#" .env
grep '^XUI_BASE=\|^XUI_PUB_KEY=' .env

pm2 restart sonicvpn >/dev/null 2>&1
sleep 3
echo "health: $(curl -s --max-time 5 http://127.0.0.1:3000/api/health)"

echo ""
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
echo "vless link: $(printf '%s' "$L" | head -c 170)..."
case "$L" in
  *"$NEW_PUB"*) echo "✅ РЕАЛЬНАЯ ССЫЛКА: ключ совпадает, цепочка сайт->3x-ui работает" ;;
  *) echo "❌ Ссылка всё ещё не реальная (демо или пустая) — смотрите pm2 logs" ;;
esac

AT=$(grep '^ADMIN_TOKEN=' .env | cut -d= -f2)
UROW=$(curl -s --max-time 10 -H "x-admin-token: $AT" "http://127.0.0.1:3000/api/admin/users?search=diag$TS")
DIAGUID=$(printf '%s' "$UROW" | grep -oE '"id":[0-9]+' | head -1 | grep -oE '[0-9]+')
if [ -n "$DIAGUID" ]; then
  curl -s --max-time 30 -X DELETE -H "x-admin-token: $AT" "http://127.0.0.1:3000/api/admin/users/$DIAGUID" >/dev/null && echo "diag user cleaned up"
fi
echo "=== DONE ==="
