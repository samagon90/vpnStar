#!/usr/bin/env bash
# v13.4: DNS-фикс через шаблон xray. Форм-поле сохранения = xraySetting
# (название из ответа GET: {clientReverseTags, inboundTags, outboundTestUrl, xraySetting}).
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

fetch_wrapper() { # печатает wrapper-объект (json) в stdout
  curl -ks -b "$JAR" -H "User-Agent: $UA" -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
    -X POST "$BASE/panel/api/xray/" -d '{}' | jq -c '.obj | if type=="string" then fromjson else . end' 2>/dev/null
}

csrf_get
echo "=== read xray template ==="
W=$(fetch_wrapper)
echo "wrapper: $(printf '%s' "$W" | head -c 200)"
printf '%s' "$W" | jq -e . >/dev/null 2>&1 || { echo "DNS_FAIL: wrapper not json"; exit 0; }
printf '%s' "$W" > /tmp/wrapper.json
XSET=$(jq -c '.xraySetting // .config // empty' /tmp/wrapper.json)
[ -z "$XSET" ] || [ "$XSET" = "null" ] && { echo "DNS_FAIL: no xraySetting field. wrapper keys: $(jq -c 'keys' /tmp/wrapper.json)"; exit 0; }
XTYPE=$(printf '%s' "$XSET" | jq -r 'type')
if [ "$XTYPE" = "string" ]; then
  printf '%s' "$XSET" | jq -r '.' > /tmp/xset.json
elif [ "$XTYPE" = "object" ]; then
  printf '%s' "$XSET" > /tmp/xset.json
else
  echo "DNS_FAIL: xraySetting type=$XTYPE"; exit 0
fi
jq -e 'type=="object"' /tmp/xset.json >/dev/null 2>&1 || { echo "DNS_FAIL: xset not a config object: $(head -c 150 /tmp/xset.json)"; exit 0; }
echo "config keys: $(jq -c 'keys' /tmp/xset.json)"
echo "dns now: $(jq -c '.dns // "ABSENT"' /tmp/xset.json)"

jq '
  .dns = {"servers": ["1.1.1.1", "8.8.8.8"]}
  | .outbounds = ((.outbounds // []) | map(select(.tag != "dns-out"))) + [{"tag":"dns-out","protocol":"dns"}]
  | .routing = ((.routing // {"domainStrategy":"AsIs","rules":[]})
      | .rules = ([{"network":"dns","outboundTag":"dns-out","type":"field"}]
          + ((.rules // []) | map(select((.outboundTag // "") != "dns-out")))))
' /tmp/xset.json > /tmp/xset-new.json || { echo "DNS_FAIL: jq modify error"; exit 0; }
echo "new: dns=$(jq -c '.dns' /tmp/xset-new.json) rule0=$(jq -c '.routing.rules[0]' /tmp/xset-new.json) last_out=$(jq -c '.outbounds[-1]' /tmp/xset-new.json)"

echo "=== SAVE (form: xraySetting + исходные остальные поля) ==="
OTU=$(jq -r '.outboundTestUrl // ""' /tmp/wrapper.json)
ITAGS=$(jq -c '.inboundTags // []' /tmp/wrapper.json)
CRTAGS=$(jq -c '.clientReverseTags // []' /tmp/wrapper.json)

save_try() { # $1=имя поля конфига
  local field="$1" R
  R=$(curl -ks -b "$JAR" -H "User-Agent: $UA" -H "X-CSRF-Token: $CSRF" -X POST "$BASE/panel/api/xray/update" \
    --data-urlencode "${field}@/tmp/xset-new.json" \
    --data-urlencode "outboundTestUrl=$OTU" \
    --data-urlencode "inboundTags=$ITAGS" \
    --data-urlencode "clientReverseTags=$CRTAGS")
  echo "save(field=$field): $(printf '%s' "$R" | head -c 200)"
  printf '%s' "$R" | grep -q '"success":true'
}

sleep 1
save_try xraySetting || save_try config || save_try jsonConfig || { echo "DNS_FAIL: save failed"; exit 0; }
sleep 2
W2=$(fetch_wrapper)
X2=$(jq -c '.xraySetting // .config // empty' <<<"$W2")
if printf '%s' "$X2" | grep -q 'dns-out'; then
  echo "template saved: dns-out НА МЕСТЕ"
else
  echo "DNS_FAIL: not verified in re-read: $(printf '%s' "$X2" | head -c 200)"; exit 0
fi

echo "=== xray restart / verify ==="
sleep 5
json_get /panel/api/xray/getXrayResult | head -c 300; echo
ss -tlnp 2>/dev/null | grep -E ':(443|20461) ' | head -3
echo "live config dns: $(jq -c '.dns // "ABSENT IN LIVE CONFIG"' /usr/local/x-ui/bin/config.json)"
PROBE=$(curl -sk --resolve www.microsoft.com:443:127.0.0.1 --max-time 10 https://www.microsoft.com/ -o /dev/null -w '%{http_code}')
echo "reality probe: $PROBE"

echo "=== DNS-over-tunnel test (socks5h = DNS через туннель) ==="
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
echo "test client uuid: $TUUD"
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
D1=$(curl -s --max-time 20 -x socks5h://127.0.0.1:10080 https://example.com -o /dev/null -w 'dns-through-tunnel: %{http_code} %{time_total}s')
D2=$(curl -s --max-time 20 -x socks5h://127.0.0.1:10080 https://www.youtube.com -o /dev/null -w 'youtube(dns-tunnel): %{http_code} %{time_total}s')
echo "1) $D1"
echo "2) $D2"
[ -s /tmp/diag-client.log ] && tail -5 /tmp/diag-client.log
kill "$CPID" 2>/dev/null
curl -ks -b "$JAR" -H "X-CSRF-Token: $CSRF" -X DELETE "$BASE/panel/api/clients/del/$REF" | grep -q '"success":true' && echo "test client deleted" || echo "test client $REF остался"

case "$D1$D2" in
  *200*) echo "DNS_FIXED: DNS через туннель работает" ;;
  *) echo "DNS_FAIL: dns через туннель всё ещё не работает" ;;
esac
