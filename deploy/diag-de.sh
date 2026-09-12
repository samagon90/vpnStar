#!/usr/bin/env bash
# v7: проверка фактического состояния + починка ссылки:
#     если панель отдаёт устаревший pbk — рестарт панели и повторная проверка.
#     Текущие ключи в БД = формат этой сборки (reality уже работает, probe=403).
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

echo "=== xray config: reality keys (фактически, на диске) ==="
jq -c '.inbounds[]? | select(.protocol=="vless") | {tag, port, pbk: .streamSettings.realitySettings.publicKey, priv_len: (.streamSettings.realitySettings.privateKey | length)}' /usr/local/x-ui/bin/config.json 2>/dev/null

login
echo "login done"
PBK=$(get_pbk)
echo "panel link pbk now: $PBK (len ${#PBK})"
PROBE=$(curl -sk --resolve www.microsoft.com:443:127.0.0.1 --max-time 10 https://www.microsoft.com/ -o /dev/null -w '%{http_code}')
echo "reality probe: $PROBE"

if [ ${#PBK} -ge 40 ] && [ "$PROBE" != "000" ]; then
  echo "DE_FIXED: $PBK"
  exit 0
fi

echo "=== ссылка устарела ($([ ${#PBK} -ge 40 ] && echo ok || echo stale) pbk) -> рестарт панели ==="
systemctl restart x-ui 2>/dev/null || systemctl restart 3x-ui 2>/dev/null || /usr/local/x-ui/x-ui restart 2>/dev/null || true
sleep 10
ss -tlnp 2>/dev/null | grep -E ':(443|20461) ' | head -3
login
PBK=$(get_pbk)
echo "panel link pbk after restart: $PBK (len ${#PBK})"
PROBE=$(curl -sk --resolve www.microsoft.com:443:127.0.0.1 --max-time 10 https://www.microsoft.com/ -o /dev/null -w '%{http_code}')
echo "reality probe after restart: $PROBE"
if [ ${#PBK} -ge 40 ] && [ "$PROBE" != "000" ]; then
  echo "DE_FIXED: $PBK"
else
  echo "=== raw link for inspection ==="
  api GET /panel/api/clients/links/sonic-main | head -c 500; echo
  echo "DE_FAIL: link still stale (pbk len ${#PBK}, probe $PROBE)"
fi
