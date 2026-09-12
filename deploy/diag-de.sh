#!/usr/bin/env bash
# v5: ФИНАЛЬНЫЙ фикс DE — реальные Reality-ключи (xray-linux-amd64 x25519),
#     порт инбаунда 433 -> 443, ufw allow 443, проверка Reality-проброса.
set +e
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

echo "=== current state ==="
echo "config inbounds: $(jq -c '[.inbounds[]? | {tag, port, proto: .protocol}]' /usr/local/x-ui/bin/config.json 2>/dev/null | head -c 300)"
ss -tlnp 2>/dev/null | grep -E ':(443|433|20461) ' | head -5
ufw status 2>/dev/null | head -15

[ -x "$XP" ] || { echo "DE_FAIL: $XP not executable"; exit 0; }
echo "=== new key pair ==="
KEYS=$("$XP" x25519 2>&1)
PRIV=$(printf '%s\n' "$KEYS" | awk -F': ' '/Private key/{print $2}' | tr -d '[:space:]')
PUB=$(printf '%s\n' "$KEYS" | awk -F': ' '/Public key/{print $2}' | tr -d '[:space:]')
echo "PRIV len=${#PRIV}  PUB len=${#PUB}"
if [ ${#PRIV} -lt 40 ] || [ ${#PUB} -lt 40 ]; then
  echo "--- raw:"; printf '%s\n' "$KEYS" | head -8
  echo "DE_FAIL: x25519 keys not parsed"
  exit 0
fi

echo "=== panel login + inbound update (keys + port 443) ==="
CSRF=$(curl -ks -c "$JAR" --max-time 8 "$BASE/csrf-token" | jq -r '.obj // empty' 2>/dev/null)
LOGIN=$(curl -ks -b "$JAR" -c "$JAR" --max-time 8 -X POST "$BASE/login" \
  -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
  -d '{"username":"12345678","password":"12345678"}')
echo "login: $(printf '%s' "$LOGIN" | head -c 100)"

LIST=$(api GET /panel/api/inbounds/list)
INB_ID=$(printf '%s' "$LIST" | jq -r '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.protocol=="vless" and ((.streamSettings|tostring)|contains("realitySettings")))] | .[0].id // empty')
CUR_PORT=$(printf '%s' "$LIST" | jq -r --argjson id "$INB_ID" '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.id==$id)] | .[0].port // empty')
echo "inbound id=$INB_ID current_port=$CUR_PORT"
if [ -z "$INB_ID" ]; then echo "DE_FAIL: reality inbound not found"; exit 0; fi

CL_BEFORE=$(printf '%s' "$LIST" | jq -r --argjson id "$INB_ID" '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.id==$id)] | .[0].settings | (if type=="object" then (.clients // []) else (try ((fromjson).clients // []) catch []) end) | length')
UPD=$(printf '%s' "$LIST" | jq -c --argjson id "$INB_ID" --arg priv "$PRIV" --arg pub "$PUB" '
  (.obj | if type=="array" then . else (.rows // []) end)
  | [.[]? | select(.id==$id)] | .[0]
  | .port = 443
  | .streamSettings = (.streamSettings | if type=="object" then . else (try fromjson catch {}) end)
  | .streamSettings.realitySettings.privateKey = $priv
  | .streamSettings.realitySettings.publicKey = $pub
')
[ -z "$UPD" ] && { echo "DE_FAIL: could not build update object"; exit 0; }
RESP=$(api POST "/panel/api/inbounds/update/$INB_ID" "$UPD")
echo "update: $(printf '%s' "$RESP" | head -c 160)"
sleep 5

echo "=== ufw: open 443 for clients (world) ==="
ufw allow 443/tcp >/dev/null 2>&1 && echo "ufw allow 443: ok"
ufw status 2>/dev/null | head -12

echo "=== verify ==="
LIST2=$(api GET /panel/api/inbounds/list)
NEW_PORT=$(printf '%s' "$LIST2" | jq -r --argjson id "$INB_ID" '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.id==$id)] | .[0].port // empty')
NEW_PRIV=$(printf '%s' "$LIST2" | jq -r --argjson id "$INB_ID" '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.id==$id)] | .[0] | (.streamSettings | if type=="object" then . else (try fromjson catch {}) end).realitySettings.privateKey // empty')
CL_AFTER=$(printf '%s' "$LIST2" | jq -r --argjson id "$INB_ID" '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.id==$id)] | .[0].settings | (if type=="object" then (.clients // []) else (try ((fromjson).clients // []) catch []) end) | length')
LINKS=$(api GET /panel/api/clients/links/sonic-main)
VPUB=$(printf '%s' "$LINKS" | grep -oE 'pbk=[A-Za-z0-9+/=]+' | head -1 | sed 's/^pbk=//')
echo "port: $NEW_PORT  priv_ok: $([ "$NEW_PRIV" = "$PRIV" ] && echo yes || echo no)  clients: $CL_AFTER/$CL_BEFORE"
echo "panel pbk: $VPUB (len ${#VPUB})"
sleep 2
ss -tlnp 2>/dev/null | grep -E ':(443|433) ' | head -3
curl -sk --resolve www.microsoft.com:443:127.0.0.1 --max-time 10 https://www.microsoft.com/ -o /dev/null -w 'reality probe on 443: %{http_code} (200/301/307 = работает)\n'

if [ "$NEW_PORT" = "443" ] && [ "$NEW_PRIV" = "$PRIV" ] && [ "$VPUB" = "$PUB" ] && [ "$CL_AFTER" = "$CL_BEFORE" ]; then
  echo "DE_FIXED: $PUB"
else
  echo "DE_FAIL: verification mismatch (port=$NEW_PORT priv=$([ "$NEW_PRIV" = "$PRIV" ] && echo ok || echo bad) pbk=$([ "$VPUB" = "$PUB" ] && echo ok || echo bad) clients=$CL_AFTER/$CL_BEFORE)"
fi
