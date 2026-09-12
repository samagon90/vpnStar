#!/usr/bin/env bash
# v11: ВНЕШНИЙ тест туннеля: xray-клиент на RU -> 185.125.102.135:443 (как телефон).
#      Те же параметры, что в QR (pbk/sni/sid из панели), временный клиент.
set +e
DE_IP=185.125.102.135
BASE="https://$DE_IP:20461/3dtIfnbTYAw5E0rNtB"
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
JAR=/tmp/ext_$$.jar
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

echo "=== plain external probe: RU -> DE:443 (SNI=amd.com, без vless) ==="
curl -sk --resolve amd.com:443:$DE_IP --max-time 10 https://amd.com/ -o /dev/null -w 'plain probe: %{http_code} (200/301/403 = 443 достижима извне, Reality прокидывает)\n'

echo "=== downloading xray client v26.7.28 (как на DE) ==="
if [ ! -x /tmp/xray-linux-64 ]; then
  curl -sL --max-time 180 -o /tmp/xray.zip https://github.com/XTLS/Xray-core/releases/download/v26.7.28/Xray-linux-64.zip
  rm -rf /tmp/xraydl && mkdir -p /tmp/xraydl
  (unzip -o -q /tmp/xray.zip -d /tmp/xraydl 2>/dev/null || python3 -m zipfile -e /tmp/xray.zip /tmp/xraydl/) || true
  [ -f /tmp/xraydl/xray ] && cp /tmp/xraydl/xray /tmp/xray-linux-64 && chmod +x /tmp/xray-linux-64
fi
[ -x /tmp/xray-linux-64 ] || { echo "EXT_TUNNEL_FAIL: no xray client on RU"; exit 0; }
/tmp/xray-linux-64 version | head -1

login
LIST=$(api GET /panel/api/inbounds/list)
PUB=$(printf '%s' "$LIST" | jq -r '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.protocol=="vless")] | .[0] | (.streamSettings | if type=="object" then . else (try fromjson catch {}) end).realitySettings.publicKey // empty')
SNI=$(printf '%s' "$LIST" | jq -r '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.protocol=="vless")] | .[0] | (.streamSettings | if type=="object" then . else (try fromjson catch {}) end).realitySettings.serverNames[0] // empty')
SID=$(printf '%s' "$LIST" | jq -r '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.protocol=="vless")] | .[0] | (.streamSettings | if type=="object" then . else (try fromjson catch {}) end).realitySettings.shortIds[0] // empty')
INB_ID=$(printf '%s' "$LIST" | jq -r '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.protocol=="vless")] | .[0].id // empty')
echo "client params (как в QR): pbk=$PUB sni=$SNI sid=$SID"
[ ${#PUB} -ge 40 ] || { echo "EXT_TUNNEL_FAIL: no pbk"; exit 0; }

TS=$(date +%s)
REF="diagtest-$TS"
api POST /panel/api/clients/add "{\"client\":{\"email\":\"$REF\",\"flow\":\"xtls-rprx-vision\",\"limitIp\":1,\"totalGB\":0,\"enable\":true},\"inboundIds\":[$INB_ID]}" | head -c 100; echo
sleep 1
TUUD=$(api GET /panel/api/clients/get/"$REF" | jq -r '.obj.client.uuid // empty')
echo "test client uuid: $TUUD"
[ ${#TUUD} -ge 30 ] || { echo "EXT_TUNNEL_FAIL: no test client uuid"; exit 0; }

cat > /tmp/ext-client.json <<EOF
{
  "log": { "loglevel": "warning" },
  "inbounds": [
    { "tag": "test-in", "listen": "127.0.0.1", "port": 10080, "protocol": "mixed", "settings": { "udp": false } }
  ],
  "outbounds": [
    {
      "tag": "vpn",
      "protocol": "vless",
      "settings": { "vnext": [ { "address": "$DE_IP", "port": 443, "users": [ { "id": "$TUUD", "flow": "xtls-rprx-vision", "encryption": "none" } ] } ] },
      "streamSettings": { "network": "tcp", "security": "reality", "realitySettings": { "serverName": "$SNI", "fingerprint": "chrome", "publicKey": "$PUB", "shortId": "$SID", "show": false } }
    },
    { "tag": "direct", "protocol": "freedom" }
  ]
}
EOF

echo "=== launching xray client on RU: $DE_IP:443 (внешний путь, как телефон) ==="
/tmp/xray-linux-64 -c /tmp/ext-client.json > /tmp/ext-client.log 2>&1 &
CPID=$!
sleep 3
kill -0 "$CPID" 2>/dev/null || { echo "EXT_TUNNEL_FAIL: client xray died:"; head -5 /tmp/ext-client.log; exit 0; }

R1=$(curl -s --max-time 15 -x http://127.0.0.1:10080 http://example.com -o /dev/null -w 'http: %{http_code} %{time_total}s')
R2=$(curl -sk --max-time 15 -x http://127.0.0.1:10080 https://www.youtube.com -o /dev/null -w 'youtube: %{http_code} %{time_total}s')
echo "1) $R1"
echo "2) $R2"
[ -s /tmp/ext-client.log ] && { echo "--- client log:"; head -8 /tmp/ext-client.log; }

kill "$CPID" 2>/dev/null
{ api DEL "/panel/api/clients/del/$REF" | grep -q '"success":true' || api POST "/panel/api/clients/del/$REF" | grep -q '"success":true'; } && echo "test client deleted" || echo "test client $REF остался"

case "$R1$R2" in
  *200*|*204*) echo "EXT_TUNNEL_OK: внешний путь (чужой IP -> DE:443) работает — проблема в профиле/настройках телефона" ;;
  *) echo "EXT_TUNNEL_FAIL: внешний путь не работает — проблема между внешним миром и DE:443" ;;
esac
