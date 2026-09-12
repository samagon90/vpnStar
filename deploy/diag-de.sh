#!/usr/bin/env bash
# v13: ЧИНим DNS через туннель:
#  - панель хранит ШАБЛОН конфига xray (POST /panel/api/xray/update, form-поля)
#  - добавляем: dns.servers (1.1.1.1/8.8.8.8) + правило network=dns -> dns-out
#    + outbound protocol=dns. Тогда ВСЕ DNS-запросы из туннеля (даже к
#    приватным DNS провайдера телефона) отвечает сам сервер.
#  - проверка: тестовый клиент + curl через socks5h (DNS идёт СКВОЗЬ туннель).
set +e
XP=/usr/local/x-ui/bin/xray-linux-amd64
BASE="https://127.0.0.1:20461/3dtIfnbTYAw5E0rNtB"
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
JAR=/tmp/panel_$$.jar
rm -f "$JAR"

csrf_get() {
  rm -f "$JAR"
  CSRF=$(curl -ks -c "$JAR" --max-time 8 "$BASE/csrf-token" | jq -r '.obj // empty' 2>/dev/null)
  curl -ks -b "$JAR" -c "$JAR" --max-time 8 -X POST "$BASE/login" \
    -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
    -d '{"username":"12345678","password":"12345678"}' -o /dev/null
}

json_get() { curl -ks -b "$JAR" -H "User-Agent: $UA" "$BASE$1"; }
json_post() { curl -ks -b "$JAR" -H "User-Agent: $UA" -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' -X POST "$BASE$1" ${2:+-d "$2"}; }

csrf_get
echo "=== GET xray config template ==="
TPL_RESP=$(json_get /panel/api/xray/)
printf '%s' "$TPL_RESP" | head -c 300; echo
# шаблон может лежать в obj.config / obj.jsonConfig / obj (строка)
TPL=$(printf '%s' "$TPL_RESP" | jq -r '.obj.config // .obj.jsonConfig // (if (.obj|type)=="string" then .obj else empty end) // empty')
[ -z "$TPL" ] && TPL=$(printf '%s' "$TPL_RESP" | jq -r '.config // .jsonConfig // empty')
echo "template len: ${#TPL}"
[ ${#TPL} -lt 100 ] && { echo "DNS_FAIL: cannot read template. raw:"; printf '%s' "$TPL_RESP" | head -c 600; echo; exit 0; }
echo "$TPL" > /tmp/tpl.json
jq -c 'keys' /tmp/tpl.json
echo "dns now: $(jq -c '.dns // "ABSENT"' /tmp/tpl.json)"

jq '
  .dns = {"servers": ["1.1.1.1", "8.8.8.8"]}
  | .outbounds = ((.outbounds // []) | map(select(.tag != "dns-out"))) + [{"tag":"dns-out","protocol":"dns"}]
  | .routing.rules = [{"network":"dns","outboundTag":"dns-out","type":"field"}]
     + ((.routing.rules // []) | map(select((.outboundTag // "") != "dns-out")))
' /tmp/tpl.json > /tmp/tpl-new.json || { echo "DNS_FAIL: jq modify error"; exit 0; }
jq -c '.dns, .routing.rules[0:2], (.outbounds[-1])' /tmp/tpl-new.json

echo "=== SAVE template (form fields) ==="
S1=$(curl -ks -b "$JAR" -H "User-Agent: $UA" -H "X-CSRF-Token: $CSRF" -X POST "$BASE/panel/api/xray/update" --data-urlencode "config@/tmp/tpl-new.json")
echo "save attempt 1 (field 'config'): $(printf '%s' "$S1" | head -c 200)"
sleep 2
TPL2=$(curl -ks -b "$JAR" -H "User-Agent: $UA" -H "X-CSRF-Token: $CSRF" -X POST "$BASE/panel/api/xray/" | jq -r '.obj.config // .obj.jsonConfig // (if (.obj|type)=="string" then .obj else empty end) // empty')
if ! printf '%s' "$TPL2" | grep -q 'dns-out'; then
  S2=$(curl -ks -b "$JAR" -H "User-Agent: $UA" -H "X-CSRF-Token: $CSRF" -X POST "$BASE/panel/api/xray/update" --data-urlencode "jsonConfig@/tmp/tpl-new.json")
  echo "save attempt 2 (field 'jsonConfig'): $(printf '%s' "$S2" | head -c 200)"
  sleep 2
  TPL2=$(curl -ks -b "$JAR" -H "User-Agent: $UA" -H "X-CSRF-Token: $CSRF" -X POST "$BASE/panel/api/xray/" | jq -r '.obj.config // .obj.jsonConfig // (if (.obj|type)=="string" then .obj else empty end) // empty')
fi
printf '%s' "$TPL2" | grep -q 'dns-out' && echo "template saved: dns-out НА МЕСТЕ" || { echo "DNS_FAIL: template not saved (оба варианта полей)"; printf '%s' "$S1" | head -c 300; echo; exit 0; }

echo "=== xray restart / verify ==="
sleep 5
json_get /panel/api/xray/getXrayResult | head -c 300; echo
ss -tlnp 2>/dev/null | grep -E ':(443|20461) ' | head -3
jq -c '.dns // "ABSENT IN LIVE CONFIG"' /usr/local/x-ui/bin/config.json
PROBE=$(curl -sk --resolve www.microsoft.com:443:127.0.0.1 --max-time 10 https://www.microsoft.com/ -o /dev/null -w '%{http_code}')
echo "reality probe: $PROBE"

echo "=== DNS-over-tunnel test (socks5h = DNS идёт через туннель) ==="
LIST=$(json_get /panel/api/inbounds/list)
PUB=$(printf '%s' "$LIST" | jq -r '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.protocol=="vless")] | .[0] | (.streamSettings | if type=="object" then . else (try fromjson catch {}) end).realitySettings.publicKey // empty')
SNI=$(printf '%s' "$LIST" | jq -r '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.protocol=="vless")] | .[0] | (.streamSettings | if type=="object" then . else (try fromjson catch {}) end).realitySettings.serverNames[0] // empty')
SID=$(printf '%s' "$LIST" | jq -r '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.protocol=="vless")] | .[0] | (.streamSettings | if type=="object" then . else (try fromjson catch {}) end).realitySettings.shortIds[0] // empty')
INB_ID=$(printf '%s' "$LIST" | jq -r '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.protocol=="vless")] | .[0].id // empty')
TS=$(date +%s)
REF="diagtest-$TS"
json_post /panel/api/clients/add "{\"client\":{\"email\":\"$REF\",\"flow\":\"xtls-rprx-vision\",\"limitIp\":1,\"totalGB\":0,\"enable\":true},\"inboundIds\":[$INB_ID]}" | head -c 80; echo
sleep 1
TUUD=$(json_get "/panel/api/clients/get/$REF" | jq -r '.obj.client.uuid // empty')
cat > /tmp/diag-client.json <<EOF
{
  "log": { "loglevel": "warning" },
  "inbounds": [ { "tag": "test-in", "listen": "127.0.0.1", "port": 10080, "protocol": "mixed", "settings": { "udp": false } } ],
  "outbounds": [
    { "tag": "vpn", "protocol": "vless",
      "settings": { "vnext": [ { "address": "127.0.0.1", "port": 443, "users": [ { "id": "$TUUD", "flow": "xtls-rprx-vision" } ] } ] },
      "streamSettings": { "network": "tcp", "security": "reality", "realitySettings": { "serverName": "$SNI", "fingerprint": "chrome", "publicKey": "$PUB", "shortId": "$SID", "show": false } } },
    { "tag": "direct", "protocol": "freedom" }
  ]
}
EOF
$XP -c /tmp/diag-client.json > /tmp/diag-client.log 2>&1 &
CPID=$!
sleep 3
# socks5h: хост НЕ резолвится на сервере, а через прокси (туннель)
D1=$(curl -s --max-time 20 -x socks5h://127.0.0.1:10080 https://example.com -o /dev/null -w 'dns-through-tunnel: %{http_code} %{time_total}s')
D2=$(curl -s --max-time 20 -x socks5h://127.0.0.1:10080 https://www.youtube.com -o /dev/null -w 'youtube(dns-tunnel): %{http_code} %{time_total}s')
echo "1) $D1"
echo "2) $D2"
[ -s /tmp/diag-client.log ] && tail -5 /tmp/diag-client.log
kill "$CPID" 2>/dev/null
curl -ks -b "$JAR" -H "X-CSRF-Token: $CSRF" -X DELETE "$BASE/panel/api/clients/del/$REF" | grep -q '"success":true' && echo "test client deleted" || echo "test client $REF остался"

case "$D1$D2" in
  *200*) echo "DNS_FIXED: DNS через туннель работает — у приложений пропал 'интернет пропадает'" ;;
  *) echo "DNS_FAIL: dns через туннель всё ещё не работает" ;;
esac
