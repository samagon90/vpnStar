#!/usr/bin/env bash
# v10: Тест туннеля изнутри сервера.
#      1) смотрим outbounds/routing/dns в конфиге xray
#      2) создаём временного клиента, запускаем xray-клиент на самом сервере
#         (vless+reality -> 127.0.0.1:443) и гоняем через него http-запрос.
#      TUNNEL_OK  = сервер шлёт трафик в интернет, проблема на клиенте (DNS/телефон)
#      TUNNEL_FAIL= сервер не прогоняет трафик (конфиг/маршрутизация)
set +e
XP=/usr/local/x-ui/bin/xray-linux-amd64
BASE="https://127.0.0.1:20461/3dtIfnbTYAw5E0rNtB"
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
JAR=/tmp/panel_$$.jar
rm -f "$JAR"

api() {
  local m="$1" p="$2" d="${3:-}"
  case "$m" in
    POST)
      curl -ks -b "$JAR" -H "User-Agent: $UA" -H "X-CSRF-Token: $CSRF" \
        -H 'Content-Type: application/json' -X POST "$BASE$p" -d "$d"
      ;;
    DEL)
      curl -ks -b "$JAR" -H "User-Agent: $UA" -H "X-CSRF-Token: $CSRF" -X DELETE "$BASE$p"
      ;;
    *)
      curl -ks -b "$JAR" -H "User-Agent: $UA" "$BASE$p"
      ;;
  esac
}

login() {
  rm -f "$JAR"
  CSRF=$(curl -ks -c "$JAR" --max-time 8 "$BASE/csrf-token" | jq -r '.obj // empty' 2>/dev/null)
  curl -ks -b "$JAR" -c "$JAR" --max-time 8 -X POST "$BASE/login" \
    -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
    -d '{"username":"12345678","password":"12345678"}' -o /dev/null
}

echo "=== server xray config: outbounds / routing / dns ==="
jq -c '.outbounds // "none"' /usr/local/x-ui/bin/config.json 2>/dev/null | head -c 600; echo
jq -c '.routing // "no routing section"' /usr/local/x-ui/bin/config.json 2>/dev/null | head -c 400; echo
jq -c '.dns // "no dns section"' /usr/local/x-ui/bin/config.json 2>/dev/null | head -c 200; echo

login
LIST=$(api GET /panel/api/inbounds/list)
PUB=$(printf '%s' "$LIST" | jq -r '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.protocol=="vless")] | .[0] | (.streamSettings | if type=="object" then . else (try fromjson catch {}) end).realitySettings.publicKey // empty')
SNI=$(printf '%s' "$LIST" | jq -r '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.protocol=="vless")] | .[0] | (.streamSettings | if type=="object" then . else (try fromjson catch {}) end).realitySettings.serverNames[0] // empty')
SID=$(printf '%s' "$LIST" | jq -r '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.protocol=="vless")] | .[0] | (.streamSettings | if type=="object" then . else (try fromjson catch {}) end).realitySettings.shortIds[0] // empty')
INB_ID=$(printf '%s' "$LIST" | jq -r '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.protocol=="vless")] | .[0].id // empty')
echo "client params: pbk=$PUB sni=$SNI sid=$SID inbound=$INB_ID"
[ ${#PUB} -ge 40 ] || { echo "TUNNEL_FAIL: no pbk"; exit 0; }

TS=$(date +%s)
REF="diagtest-$TS"
api POST /panel/api/clients/add "{\"client\":{\"email\":\"$REF\",\"flow\":\"xtls-rprx-vision\",\"limitIp\":1,\"totalGB\":0,\"enable\":true},\"inboundIds\":[$INB_ID]}" | head -c 120; echo
sleep 1
TUUD=$(api GET /panel/api/clients/get/"$REF" | jq -r '.obj.client.uuid // empty')
echo "test client uuid: $TUUD"
[ ${#TUUD} -ge 30 ] || { echo "TUNNEL_FAIL: no test client uuid"; exit 0; }

cat > /tmp/diag-client.json <<EOF
{
  "log": { "loglevel": "warning" },
  "inbounds": [
    { "tag": "test-in", "listen": "127.0.0.1", "port": 10080, "protocol": "mixed", "settings": { "udp": false } }
  ],
  "outbounds": [
    {
      "tag": "vpn",
      "protocol": "vless",
      "settings": { "vnext": [ { "address": "127.0.0.1", "port": 443, "users": [ { "id": "$TUUD", "flow": "xtls-rprx-vision", "encryption": "none" } ] } ] },
      "streamSettings": { "network": "tcp", "security": "reality", "realitySettings": { "serverName": "$SNI", "fingerprint": "chrome", "publicKey": "$PUB", "shortId": "$SID", "show": false } }
    },
    { "tag": "direct", "protocol": "freedom" }
  ]
}
EOF

echo "=== launching test xray client (vless+reality -> 127.0.0.1:443) ==="
$XP -c /tmp/diag-client.json > /tmp/diag-client.log 2>&1 &
CPID=$!
sleep 3
kill -0 "$CPID" 2>/dev/null || { echo "TUNNEL_FAIL: test xray died:"; head -5 /tmp/diag-client.log; exit 0; }

echo "=== proxy tests through the tunnel ==="
R1=$(curl -s --max-time 15 -x http://127.0.0.1:10080 http://example.com -o /dev/null -w 'http: %{http_code} %{time_total}s')
R2=$(curl -sk --max-time 15 -x http://127.0.0.1:10080 https://www.google.com/generate_204 -o /dev/null -w 'https204: %{http_code} %{time_total}s')
R3=$(curl -sk --max-time 15 -x http://127.0.0.1:10080 https://www.youtube.com -o /dev/null -w 'youtube: %{http_code} %{time_total}s')
echo "1) $R1"
echo "2) $R2"
echo "3) $R3"
[ -s /tmp/diag-client.log ] && { echo "--- xray client log:"; head -10 /tmp/diag-client.log; }

kill "$CPID" 2>/dev/null
{ api DEL "/panel/api/clients/del/$REF" | grep -q '"success":true' || api POST "/panel/api/clients/del/$REF" | grep -q '"success":true'; } && echo "test client deleted" || echo "test client $REF остался в панели (вредный, limitIp=1)"

case "$R1$R2$R3" in
  *200*|*204*) echo "TUNNEL_OK: сервер прогоняет трафик в интернет — проблема на клиенте (телефон/DNS)" ;;
  *) echo "TUNNEL_FAIL: сервер НЕ прогоняет трафик — смотрим конфиг выше" ;;
esac
