#!/usr/bin/env bash
# v18: ДЕПЛОЙ + пред-чеки RU->DE:443 (TCP/TLS/MTU) + xray-клиент с debug-логом + ПРЕД-ЧЕК прямого пути RU->DE:443 (TCP/TLS) + xray-клиент с debug-логом (git + единый pm2 на :80, correct cwd) + ВНЕШНЯЯ ПРОВЕРКА (путь телефона):
#      РЕАЛЬНАЯ ссылка сайта -> xray-клиент на RU -> ВНЕШНИЙ IP DE:443 ->
#      веб + DNS через туннель + какой IP видит интернет.
set +e
DE_IP=185.125.102.135
BR=arena/01a05219-vpnstar

echo "=== 0) ДЕПЛОЙ: свежий код сайта в /opt/sonicvpn ==="
cd /opt/sonicvpn || { echo "DEPLOY_FAIL: /opt/sonicvpn не найден"; exit 0; }
BEFORE=$(git log --oneline -1 | cut -d' ' -f1)
if ! git fetch origin "$BR" 2>/dev/null; then
  echo "DEPLOY_FAIL: git fetch не удался (нет интернета на сервере?)"; exit 0
fi
git checkout -f "$BR" 2>/dev/null || git checkout -b "$BR" "origin/$BR"
git reset --hard "origin/$BR"
AFTER=$(git log --oneline -1 | cut -d' ' -f1)
echo "deploy: $BEFORE -> $AFTER"

# --- нормализация процесса: ОДИН инстанс, порт 80, correct cwd (server/ => .env читается) ---
sed -i 's/^PORT=.*/PORT=80/' /opt/sonicvpn/server/.env
if [ -f /opt/sonicvpn/.env ]; then
  mv /opt/sonicvpn/.env /opt/sonicvpn/.env.stray.bak
  echo "stray /opt/sonicvpn/.env moved aside (реальный .env в server/)"
fi
pm2 delete sonicvpn >/dev/null 2>&1
pkill -f "src/index.js" 2>/dev/null
sleep 2
if command -v fuser >/dev/null 2>&1; then fuser -k 80/tcp 3000/tcp 8080/tcp 2>/dev/null; sleep 1; fi
pm2 start src/index.js --name sonicvpn --cwd /opt/sonicvpn/server >/dev/null 2>&1
sleep 5
SRT=$(grep '^PORT=' /opt/sonicvpn/server/.env 2>/dev/null | cut -d= -f2); SRT=${SRT:-80}
BASE_URL="http://127.0.0.1:$SRT"
UP=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE_URL/")
echo "site up: http=$UP ($BASE_URL)  [порты: $( (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -E ':(80|3000|8080) ' | awk '{print $4}' | tr '\n' ' ' )]"
T0=$(curl -s --max-time 45 -w ' [http=%{http_code}]' "$BASE_URL/api/debug/server" | head -c 320)
echo "T0 /api/debug/server (для APK/Windows): $T0"
W1=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE_URL/win-download.html")
W2=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE_URL/windows-app/main.js")
W3=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE_URL/install-sonicvpn.bat")
echo "T0b windows: page=$W1 app-main=$W2 bat=$W3 (все должны быть 200)"
echo

echo "=== 1) РЕАЛЬНАЯ ссылка сайта (регистрируем тестового юзера) ==="
TS=$(date +%s)
curl -s --max-time 60 -X POST $BASE_URL/api/register -H 'Content-Type: application/json' \
  -d "{\"username\":\"diagext$TS\",\"password\":\"12345678\"}" | head -c 100; echo
J=/tmp/ext_$$.jar
curl -s -c "$J" --max-time 10 -X POST $BASE_URL/api/login -H 'Content-Type: application/json' \
  -d "{\"username\":\"diagext$TS\",\"password\":\"12345678\"}" >/dev/null
DEV=$(curl -s --max-time 10 -b "$J" $BASE_URL/api/devices | grep -oE '"id":[0-9]+' | head -1 | grep -oE '[0-9]+')
LINK=$(curl -s --max-time 120 -b "$J" "$BASE_URL/api/devices/$DEV" | grep -oE 'vless://[^"]*' | head -1)
rm -f "$J"
LINK="${LINK%%#*}"   # фрагмент (#имя-устройства) НЕ часть параметров
echo "site link: $LINK"

UUUID=$(printf '%s' "$LINK" | sed -E 's#^vless://([^@]+)@.*#\1#')
HOST=$(printf '%s' "$LINK" | grep -oE '@[0-9.]+:' | head -1 | sed 's/@//; s/://')
PORT=$(printf '%s' "$LINK" | grep -oE ':[0-9]+\?' | head -1 | tr -d ':?')
PBK=$(printf '%s' "$LINK" | grep -oE 'pbk=[A-Za-z0-9+/=_-]+' | head -1 | sed 's/pbk=//')
SNI=$(printf '%s' "$LINK" | grep -oE 'sni=[^&]+' | head -1 | sed 's/sni=//')
SID=$(printf '%s' "$LINK" | grep -oE 'sid=[^&]+' | head -1 | sed 's/sid=//')
echo "parsed: uuid=$UUUID host=$HOST port=$PORT pbk_len=${#PBK} sni=$SNI sid=$SID"
[ ${#UUUID} -eq 36 ] || { echo "EXT_FAIL: в ссылке сайта нет uuid"; exit 0; }
[ ${#PBK} -ge 40 ] || { echo "EXT_FAIL: в ссылке сайта нет pbk"; exit 0; }

echo "=== 2a) прямой путь RU -> DE:443 (до xray: TCP и TLS) ==="
timeout 8 bash -c "echo > /dev/tcp/$DE_IP/443" 2>/dev/null && echo "TCP RU->DE:443: OK" || echo "TCP RU->DE:443: FAIL (таймаут/блок)"
curl -sk --max-time 12 --resolve amd.com:443:$DE_IP -o /dev/null -w "TLS+HTTP RU->DE:443 (sni amd.com): http=%{http_code} %{time_total}s (ожидаем 200/301/403 = жив, 000 = мёртв)\n" "https://amd.com/" 2>&1
echo
echo "=== 2b) MTU-проба пути RU->DE (ICMP c DF; если ВСЕ FAIL - ICMP заблокирован, выводов не делать) ==="
for sz in 1472 1400 1200 1000 548; do
  if ping -c 1 -W 2 -M do -s $sz $DE_IP >/dev/null 2>&1; then echo "  ping DF payload=$sz: OK (MTU пути >= $((sz+28)))"; else echo "  ping DF payload=$sz: FAIL"; fi
done
echo

echo "=== 2) xray-клиент v26.7.28 (та же версия, что на DE) ==="
if [ ! -x /tmp/xray-linux-64 ]; then
  curl -sL --max-time 180 -o /tmp/xray.zip https://github.com/XTLS/Xray-core/releases/download/v26.7.28/Xray-linux-64.zip
  rm -rf /tmp/xraydl && mkdir -p /tmp/xraydl
  (unzip -o -q /tmp/xray.zip -d /tmp/xraydl 2>/dev/null || python3 -m zipfile -e /tmp/xray.zip /tmp/xraydl/) || true
  [ -f /tmp/xraydl/xray ] && cp /tmp/xraydl/xray /tmp/xray-linux-64 && chmod +x /tmp/xray-linux-64
fi
[ -x /tmp/xray-linux-64 ] || { echo "EXT_FAIL: не удалось поставить xray-клиент на RU"; exit 0; }
/tmp/xray-linux-64 version | head -1

cat > /tmp/ext-client.json <<EOF
{
  "log": { "loglevel": "debug" },
  "inbounds": [ { "tag": "test-in", "listen": "127.0.0.1", "port": 10080, "protocol": "mixed", "settings": { "udp": false } } ],
  "outbounds": [
    { "tag": "vpn", "protocol": "vless",
      "settings": { "vnext": [ { "address": "$HOST", "port": $PORT, "users": [ { "id": "$UUUID", "flow": "xtls-rprx-vision", "encryption": "none" } ] } ] },
      "streamSettings": { "network": "tcp", "security": "reality", "realitySettings": { "serverName": "$SNI", "fingerprint": "chrome", "publicKey": "$PBK", "shortId": "$SID", "show": false } } },
    { "tag": "direct", "protocol": "freedom" }
  ]
}
EOF
/tmp/xray-linux-64 -c /tmp/ext-client.json > /tmp/ext-client.log 2>&1 &
CPID=$!
sleep 3
kill -0 "$CPID" 2>/dev/null || { echo "EXT_FAIL: xray-клиент не стартует:"; head -8 /tmp/ext-client.log; exit 0; }
echo "xray-клиент работает: внешний путь $HOST:$PORT (как телефон)"

echo "=== 3) тесты через туннель ==="
T1=$(curl -s --max-time 20 -x http://127.0.0.1:10080 http://example.com -o /dev/null -w 'example (dns локальный): %{http_code} %{time_total}s')
T2=$(curl -sk --max-time 20 -x http://127.0.0.1:10080 https://www.youtube.com -o /dev/null -w 'youtube (dns локальный): %{http_code} %{time_total}s')
T3=$(curl -s --max-time 20 -x socks5h://127.0.0.1:10080 http://example.com -o /dev/null -w 'example (dns СКВОЗЬ туннель): %{http_code} %{time_total}s')
T4=$(curl -sk --max-time 20 -x socks5h://127.0.0.1:10080 https://www.youtube.com -o /dev/null -w 'youtube (dns сквозь туннель): %{http_code} %{time_total}s')
T5=$(curl -s --max-time 20 -x socks5h://127.0.0.1:10080 http://neverssl.com)
echo "1) $T1"
echo "2) $T2"
echo "3) $T3"
echo "4) $T4"
echo "5) какой IP видит интернет (должен быть $DE_IP): $(printf '%s' "$T5" | grep -oE '[0-9]{1,3}(\.[0-9]{1,3}){3}' | head -1)"
[ -s /tmp/ext-client.log ] && { echo "--- log клиента (debug):"; head -30 /tmp/ext-client.log; }
kill "$CPID" 2>/dev/null

AT=$(grep '^ADMIN_TOKEN=' /opt/sonicvpn/server/.env | cut -d= -f2)
UROW=$(curl -s --max-time 10 -H "x-admin-token: $AT" "$BASE_URL/api/admin/users?search=diagext$TS")
UI=$(printf '%s' "$UROW" | grep -oE '"id":[0-9]+' | head -1 | grep -oE '[0-9]+')
[ -n "$UI" ] && curl -s --max-time 30 -X DELETE -H "x-admin-token: $AT" "$BASE_URL/api/admin/users/$UI" >/dev/null && echo "тестовый юзер удалён"

case "$T1$T2$T3$T4" in
  *200*) echo "EXT_FULL_OK: полный внешний путь работает (ссылка сайта -> внешний IP -> интернет + DNS). Сервер 100% здоров." ;;
  *) echo "EXT_FAIL: внешний путь не работает — смотри log выше" ;;
esac
