#!/usr/bin/env bash
# v8: рестарт панели (в-памяти копия инбаунда станет = БД), сверка:
#     pbk в ссылке панели == pbk в конфиге xray. Дамп raw-клиента (имена полей).
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

get_pbk() {
  api GET /panel/api/clients/links/sonic-main | grep -oE 'pbk=[A-Za-z0-9+/=_-]+' | head -1 | sed 's/^pbk=//'
}

CONFIG_PUB=$(jq -r '.inbounds[]? | select(.protocol=="vless") | .streamSettings.realitySettings.publicKey // empty' /usr/local/x-ui/bin/config.json 2>/dev/null | head -1)
echo "config xray pbk: $CONFIG_PUB (len ${#CONFIG_PUB})"

echo "=== restart panel (x-ui) ==="
systemctl restart x-ui 2>/dev/null || systemctl restart 3x-ui 2>/dev/null || true
sleep 12
ss -tlnp 2>/dev/null | grep -E ':(443|20461) ' | head -3

login
PBK=$(get_pbk)
PROBE=$(curl -sk --resolve www.microsoft.com:443:127.0.0.1 --max-time 10 https://www.microsoft.com/ -o /dev/null -w '%{http_code}')
echo "panel link pbk after restart: $PBK (len ${#PBK})"
echo "reality probe: $PROBE"

echo "=== raw client object (имена полей для uuid) ==="
api GET /panel/api/clients/get/sonic-main | head -c 400; echo

if [ "$PBK" = "$CONFIG_PUB" ] && [ ${#PBK} -ge 40 ] && [ "$PROBE" != "000" ]; then
  echo "DE_FIXED: $PBK"
else
  echo "DE_FAIL: mismatch (link=$PBK config=$CONFIG_PUB probe=$PROBE)"
  echo "=== raw link ==="
  api GET /panel/api/clients/links/sonic-main | head -c 400; echo
fi
