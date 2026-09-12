#!/usr/bin/env bash
# Диагностика RU-сервера: почему сайт не доходит до 3x-ui + авто-фикс
# Аргумент: $1 = реальный Public Key (с DE)
set +e
NEW_PUB="${1:-}"
PANEL="185.125.102.135:20461"
PPATH="/3dtIfnbTYAw5E0rNtB"

echo "=== proxy env ==="
env | grep -i proxy || echo "none"

echo "=== curl https (as .env XUI_BASE) ==="
curl -sk -o /dev/null -w 'https code: %{http_code}\n' --max-time 8 "https://$PANEL$PPATH/"
echo "=== curl http ==="
curl -s -o /dev/null -w 'http  code: %{http_code}\n' --max-time 8 "http://$PANEL$PPATH/"
echo "=== curl https csrf ==="
curl -sk --max-time 8 "https://$PANEL$PPATH/csrf-token" | head -c 120; echo
echo "=== curl http csrf ==="
curl -s --max-time 8 "http://$PANEL$PPATH/csrf-token" | head -c 120; echo

cd /opt/sonicvpn/server 2>/dev/null || { echo "no /opt/sonicvpn/server"; exit 1; }
echo "=== node fetch HTTPS (undici rejectUnauthorized:false — как в xui.js) ==="
node -e '
const { Agent } = require("undici");
const a = new Agent({ connect: { rejectUnauthorized: false } });
fetch("https://185.125.102.135:20461/3dtIfnbTYAw5E0rNtB/csrf-token", { dispatcher: a })
  .then(r => r.text())
  .then(t => console.log("NODE https OK:", t.slice(0, 100)))
  .catch(e => console.log("NODE https FAIL:", e.message, "| cause:", e.cause && (e.cause.code || e.cause.message)));
'
echo "=== node fetch HTTP ==="
node -e '
fetch("http://185.125.102.135:20461/3dtIfnbTYAw5E0rNtB/csrf-token")
  .then(r => r.text())
  .then(t => console.log("NODE http OK:", t.slice(0, 100)))
  .catch(e => console.log("NODE http FAIL:", e.message, "| cause:", e.cause && (e.cause.code || e.cause.message)));
'

echo "=== current .env XUI lines ==="
grep '^XUI' .env

HTTP_CSRF=$(curl -s --max-time 8 -o /dev/null -w '%{http_code}' "http://$PANEL$PPATH/csrf-token")
HTTPS_CSRF=$(curl -sk --max-time 8 -o /dev/null -w '%{http_code}' "https://$PANEL$PPATH/csrf-token")
echo "csrf codes: http=$HTTP_CSRF https=$HTTPS_CSRF"

if [ "$HTTP_CSRF" = "200" ]; then
  echo ""
  echo "=== FIX: http works -> updating .env (XUI_BASE=http, real pubkey) ==="
  sed -i "s#^XUI_BASE=.*#XUI_BASE=http://$PANEL$PPATH#" .env
  if [ -n "$NEW_PUB" ]; then
    sed -i "s#^XUI_PUB_KEY=.*#XUI_PUB_KEY=$NEW_PUB#" .env
    echo "pubkey set, len=${#NEW_PUB}"
  fi
  grep '^XUI' .env
  pm2 restart sonicvpn >/dev/null 2>&1
  sleep 3
  echo "health: $(curl -s --max-time 5 http://127.0.0.1:3000/api/health)"
  TS=$(date +%s)
  REG=$(curl -s --max-time 90 -X POST http://127.0.0.1:3000/api/register -H 'Content-Type: application/json' -d "{\"username\":\"diag$TS\",\"password\":\"12345678\"}")
  echo "register: $(printf '%s' "$REG" | head -c 160)"
  J=/tmp/diag_$$.jar
  curl -s -c "$J" --max-time 10 -X POST http://127.0.0.1:3000/api/login -H 'Content-Type: application/json' -d "{\"username\":\"diag$TS\",\"password\":\"12345678\"}" >/dev/null
  DEV=$(curl -s --max-time 10 -b "$J" http://127.0.0.1:3000/api/devices | grep -oE '"id":[0-9]+' | head -1 | grep -oE '[0-9]+')
  echo "device id: $DEV"
  curl -s --max-time 90 -b "$J" "http://127.0.0.1:3000/api/devices/$DEV" | grep -oE 'vless://[^"]*' | head -1 | head -c 160; echo
  rm -f "$J"
  # убираем тестового юзера через админ-токен
  AT=$(grep '^ADMIN_TOKEN=' .env | cut -d= -f2)
  UROW=$(curl -s --max-time 10 -H "x-admin-token: $AT" "http://127.0.0.1:3000/api/admin/users?search=diag$TS")
  DIAGUID=$(printf '%s' "$UROW" | grep -oE '"id":[0-9]+' | head -1 | grep -oE '[0-9]+')
  if [ -n "$DIAGUID" ]; then
    curl -s --max-time 30 -X DELETE -H "x-admin-token: $AT" "http://127.0.0.1:3000/api/admin/users/$DIAGUID" >/dev/null && echo "diag user cleaned up"
  fi
  echo "=== DONE ==="
else
  echo ""
  echo "=== NO AUTO-FIX: http csrf not 200 (see codes above) ==="
fi
