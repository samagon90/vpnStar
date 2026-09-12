#!/usr/bin/env bash
# v13.2: ЧИНим DNS через туннель (шаблон конфига xray через /panel/api/xray/*).
#  - dns.servers (1.1.1.1/8.8.8.8) + правило network=dns -> dns-out + outbound protocol=dns
#  - проверка: socks5h (DNS сквозь туннель)
set +e
XP=/usr/local/x-ui/bin/xray-linux-amd64
BASE="https://127.0.0.1:20461/3dtIfnbTYAw5E0rNtB"
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
JAR=/tmp/panel_$$.jar
rm -f "$JAR"
TPL_RESP=""

csrf_get() {
  rm -f "$JAR"
  CSRF=$(curl -ks -c "$JAR" --max-time 8 "$BASE/csrf-token" | jq -r '.obj // empty' 2>/dev/null)
  curl -ks -b "$JAR" -c "$JAR" --max-time 8 -X POST "$BASE/login" \
    -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
    -d '{"username":"12345678","password":"12345678"}' -o /dev/null
}
json_get() { curl -ks -b "$JAR" -H "User-Agent: $UA" "$BASE$1"; }
json_post() { curl -ks -b "$JAR" -H "User-Agent: $UA" -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' -X POST "$BASE$1" ${2:+-d "$2"}; }

try_req() { # $1=method $2=path $3=body(опц)
  local m="$1" p="$2" b="$3" R CODE BODY
  if [ "$m" = POST ]; then
    R=$(curl -ks -b "$JAR" -H "User-Agent: $UA" -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' -X POST "$BASE$p" ${b:+"-d $b"} -w '\nhttp:%{http_code}')
  else
    R=$(curl -ks -b "$JAR" -H "User-Agent: $UA" -H "X-CSRF-Token: $CSRF" "$BASE$p" -w '\nhttp:%{http_code}')
  fi
  CODE=$(printf '%s' "$R" | tail -1)
  BODY=$(printf '%s' "$R" | sed '$d')
  echo "  try $m $p -> $CODE len=${#BODY} body=$(printf '%s' "$BODY" | head -c 100)"
  if [ ${#BODY} -gt 100 ]; then TPL_RESP="$BODY"; return 0; fi
  return 1
}
get_tpl() {
  TPL_RESP=""
  try_req POST /panel/api/xray/ '{}' \
    || try_req POST /panel/api/xray '{}' \
    || try_req GET /panel/api/xray/ \
    || try_req GET /panel/api/xray \
    || try_req POST /panel/api/xray/getDefaultJsonConfig '{}' \
    || try_req GET /panel/api/xray/getDefaultJsonConfig
}
extract_tpl() {
  # obj может быть: строка-JSON {config, inboundTags, ...} / объект с config / сама строка конфига
  printf '%s' "$TPL_RESP" | jq -r '
    if (.obj | type) == "string" then
      (.obj | fromjson) as $o
      | if ($o | type) == "string" then $o
        else ($o.config // $o.jsonConfig // $o.template // ($o | tojson)) end
    else
      .obj.config // .obj.jsonConfig // .obj.template // (.obj | tojson)
    end' 2>/dev/null
}

csrf_get
echo "=== read xray config template ==="
get_tpl
TPL=$(extract_tpl)
echo "template len: ${#TPL}"
[ ${#TPL} -lt 100 ] && { echo "DNS_FAIL: cannot read template"; exit 0; }
echo "$TPL" > /tmp/tpl.json
echo "template keys: $(jq -c 'keys' /tmp/tpl.json)"
echo "dns now: $(jq -c '.dns // "ABSENT"' /tmp/tpl.json)"

jq '
  .dns = {"servers": ["1.1.1.1", "8.8.8.8"]}
  | .outbounds = ((.outbounds // []) | map(select(.tag != "dns-out"))) + [{"tag":"dns-out","protocol":"dns"}]
  | .routing = ((.routing // {"domainStrategy":"AsIs","rules":[]})
      | .rules = ([{"network":"dns","outboundTag":"dns-out","type":"field"}]
          + ((.rules // []) | map(select((.outboundTag // "") != "dns-out")))))
' /tmp/tpl.json > /tmp/tpl-new.json || { echo "DNS_FAIL: jq modify error"; exit 0; }
echo "new: dns=$(jq -c '.dns' /tmp/tpl-new.json) first_rule=$(jq -c '.routing.rules[0]' /tmp/tpl-new.json) last_out=$(jq -c '.outbounds[-1]' /tmp/tpl-new.json)"

echo "=== SAVE template (form fields: config / jsonConfig) ==="
S1=$(curl -ks -b "$JAR" -H "User-Agent: $UA" -H "X-CSRF-Token: $CSRF" -X POST "$BASE/panel/api/xray/update" --data-urlencode "config@/tmp/tpl-new.json")
echo "save(config): $(printf '%s' "$S1" | head -c 150)"
sleep 2
get_tpl >/dev/null
TPL2=$(extract_tpl)
if ! printf '%s' "$TPL2" | grep -q 'dns-out'; then
  S2=$(curl -ks -b "$JAR" -H "User-Agent: $UA" -H "X-CSRF-Token: $CSRF" -X POST "$BASE/panel/api/xray/update" --data-urlencode "jsonConfig@/tmp/tpl-new.json")
  echo "save(jsonConfig): $(printf '%s' "$S2" | head -c 150)"
  sleep 2
  get_tpl >/dev/null
  TPL2=$(extract_tpl)
fi
if printf '%s' "$TPL2" | grep -q 'dns-out'; then
  echo "template saved: dns-out НА МЕСТЕ"
else
  echo "DNS_FAIL: template not saved"; printf '%s' "$S1" | head -c 300; echo; exit 0
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
