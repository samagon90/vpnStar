#!/usr/bin/env bash
# v12: DE health-check (xray жив, 443 слушает, ключи в конфиге и панели совпадают).
set +e
BASE="https://127.0.0.1:20461/3dtIfnbTYAw5E0rNtB"
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
JAR=/tmp/panel_$$.jar
rm -f "$JAR"

api() {
  local m="$1" p="$2" d="${3:-}"
  if [ "$m" = POST ]; then
    curl -ks -b "$JAR" -H "User-Agent: $UA" -H "X-CSRF-Token: $CSRF" \
      -H 'Content-Type: application/json' -X POST "$BASE$p" -d "$d"
  else
    curl -ks -b "$JAR" -H "User-Agent: $UA" "$BASE$p"
  fi
}

login() {
  rm -f "$JAR"
  CSRF=$(curl -ks -c "$JAR" --max-time 8 "$BASE/csrf-token" | jq -r '.obj // empty' 2>/dev/null)
  curl -ks -b "$JAR" -c "$JAR" --max-time 8 -X POST "$BASE/login" \
    -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
    -d '{"username":"12345678","password":"12345678"}' -o /dev/null
}

CONFIG_PUB=$(jq -r '.inbounds[]? | select(.protocol=="vless") | .streamSettings.realitySettings.publicKey // empty' /usr/local/x-ui/bin/config.json 2>/dev/null | head -1)
CONFIG_PORT=$(jq -r '.inbounds[]? | select(.protocol=="vless") | .port // empty' /usr/local/x-ui/bin/config.json 2>/dev/null | head -1)
echo "xray config: pbk=$CONFIG_PUB (len ${#CONFIG_PUB}) port=$CONFIG_PORT"
ss -tlnp 2>/dev/null | grep -E ':(443|20461) ' | head -3

login
LIST_PUB=$(api GET /panel/api/inbounds/list | jq -r '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.protocol=="vless")] | .[0] | (.streamSettings | if type=="object" then . else (try fromjson catch {}) end).realitySettings.publicKey // empty')
echo "panel /list pbk: $LIST_PUB"

PROBE=$(curl -sk --resolve www.microsoft.com:443:127.0.0.1 --max-time 10 https://www.microsoft.com/ -o /dev/null -w '%{http_code}')
echo "reality probe: $PROBE"

if [ ${#CONFIG_PUB} -ge 40 ] && [ "$CONFIG_PUB" = "$LIST_PUB" ] && [ "$PROBE" != "000" ]; then
  echo "DE_FIXED: $CONFIG_PUB"
else
  echo "DE_FAIL: config=$CONFIG_PUB list=$LIST_PUB probe=$PROBE"
fi
