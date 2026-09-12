#!/usr/bin/env bash
# v6: STD Reality-ключи (аргументы: $1=PRIV $2=PUB, стандартный base64 44),
#     порт 443, ufw, проверка. Если сервер отклонил стандартный формат —
#     авто-fallback на формат собственного x25519 этой сборки.
set +e
STD_PRIV="${1:-}"
STD_PUB="${2:-}"
XP=/usr/local/x-ui/bin/xray-linux-amd64
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

[ -n "$STD_PRIV" ] && [ -n "$STD_PUB" ] || { echo "DE_FAIL: no standard keys passed"; exit 0; }

CSRF=$(curl -ks -c "$JAR" --max-time 8 "$BASE/csrf-token" | jq -r '.obj // empty' 2>/dev/null)
LOGIN=$(curl -ks -b "$JAR" -c "$JAR" --max-time 8 -X POST "$BASE/login" \
  -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
  -d '{"username":"12345678","password":"12345678"}')
echo "login: $(printf '%s' "$LOGIN" | head -c 100)"

LIST=$(api GET /panel/api/inbounds/list)
INB_ID=$(printf '%s' "$LIST" | jq -r '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.protocol=="vless" and ((.streamSettings|tostring)|contains("realitySettings")))] | .[0].id // empty')
CUR_PORT=$(printf '%s' "$LIST" | jq -r --argjson id "$INB_ID" '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.id==$id)] | .[0].port // empty')
echo "inbound id=$INB_ID current_port=$CUR_PORT"
[ -n "$INB_ID" ] || { echo "DE_FAIL: reality inbound not found"; exit 0; }

CL_BEFORE=$(printf '%s' "$LIST" | jq -r --argjson id "$INB_ID" '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.id==$id)] | .[0].settings | (if type=="object" then (.clients // []) else (try ((fromjson).clients // []) catch []) end) | length')
echo "clients before: $CL_BEFORE"

ufw allow 443/tcp >/dev/null 2>&1 && echo "ufw 443/tcp: ok"

try_apply() {
  local priv="$1" pub="$2" label="$3" UPD RESP LIST2 NEW_PORT NEW_PRIV CL_AFTER VPUB PROBE
  UPD=$(printf '%s' "$LIST" | jq -c --argjson id "$INB_ID" --arg priv "$priv" --arg pub "$pub" '
    (.obj | if type=="array" then . else (.rows // []) end)
    | [.[]? | select(.id==$id)] | .[0]
    | .port = 443
    | .streamSettings = (.streamSettings | if type=="object" then . else (try fromjson catch {}) end)
    | .streamSettings.realitySettings.privateKey = $priv
    | .streamSettings.realitySettings.publicKey = $pub
  ')
  [ -z "$UPD" ] && { echo "[$label] cannot build payload"; return 1; }
  RESP=$(api POST "/panel/api/inbounds/update/$INB_ID" "$UPD")
  echo "[$label] update: $(printf '%s' "$RESP" | head -c 120)"
  sleep 6
  LIST2=$(api GET /panel/api/inbounds/list)
  NEW_PORT=$(printf '%s' "$LIST2" | jq -r --argjson id "$INB_ID" '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.id==$id)] | .[0].port // empty')
  NEW_PRIV=$(printf '%s' "$LIST2" | jq -r --argjson id "$INB_ID" '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.id==$id)] | .[0] | (.streamSettings | if type=="object" then . else (try fromjson catch {}) end).realitySettings.privateKey // empty')
  CL_AFTER=$(printf '%s' "$LIST2" | jq -r --argjson id "$INB_ID" '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.id==$id)] | .[0].settings | (if type=="object" then (.clients // []) else (try ((fromjson).clients // []) catch []) end) | length')
  LINKS=$(api GET /panel/api/clients/links/sonic-main)
  VPUB=$(printf '%s' "$LINKS" | grep -oE 'pbk=[A-Za-z0-9+/=]+' | head -1 | sed 's/^pbk=//')
  PROBE=$(curl -sk --resolve www.microsoft.com:443:127.0.0.1 --max-time 10 https://www.microsoft.com/ -o /dev/null -w '%{http_code}')
  echo "[$label] port=$NEW_PORT clients=$CL_AFTER/$CL_BEFORE pbk_len=${#VPUB} reality_probe=$PROBE"
  if [ "$NEW_PORT" = "443" ] && [ "$NEW_PRIV" = "$priv" ] && [ "$CL_AFTER" = "$CL_BEFORE" ] && [ "$VPUB" = "$pub" ] && [ "$PROBE" != "000" ]; then
    echo "DE_FIXED: $pub"
    return 0
  fi
  return 1
}

echo "=== attempt 1: standard base64 key pair ==="
if try_apply "$STD_PRIV" "$STD_PUB" "std"; then exit 0; fi

echo "=== attempt 2 (fallback): this build's own x25519 format ==="
KEYS=$("$XP" x25519 2>&1)
B_PRIV=$(printf '%s\n' "$KEYS" | awk -F': ' '/PrivateKey:/{print $2}' | tr -d '[:space:]')
B_PUB=$(printf '%s\n' "$KEYS" | awk -F': ' '/Password \(PublicKey\)/{print $2}' | tr -d '[:space:]')
echo "build format: PRIV len=${#B_PRIV} PUB len=${#B_PUB}"
if [ ${#B_PRIV} -ge 40 ] && [ ${#B_PUB} -ge 40 ]; then
  if try_apply "$B_PRIV" "$B_PUB" "build-fmt"; then exit 0; fi
fi
echo "DE_FAIL: neither key format passed verification"
