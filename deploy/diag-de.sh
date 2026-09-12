#!/usr/bin/env bash
# v2: пересоздать валидную Reality-пару и обновить inbound через API панели.
# Клиенты инбаунда сохраняются (обновляем только realitySettings-ключи).
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

CSRF=$(curl -ks -c "$JAR" --max-time 8 "$BASE/csrf-token" | jq -r '.obj // empty' 2>/dev/null)
LOGIN=$(curl -ks -b "$JAR" -c "$JAR" --max-time 8 -X POST "$BASE/login" \
  -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
  -d '{"username":"12345678","password":"12345678"}')
echo "login: $(printf '%s' "$LOGIN" | head -c 100)"

echo "=== new key pair (xray x25519) ==="
KEYS=$(xray x25519 2>/dev/null)
printf '%s\n' "$KEYS"
PRIV=$(printf '%s\n' "$KEYS" | awk -F': ' '/Private key/{print $2}' | tr -d '[:space:]')
PUB=$(printf '%s\n' "$KEYS" | awk -F': ' '/Public key/{print $2}' | tr -d '[:space:]')
echo "PRIV len=${#PRIV}  PUB len=${#PUB}"
if [ ${#PRIV} -lt 40 ] || [ ${#PUB} -lt 40 ]; then
  echo "DE_FAIL: x25519 output not parsed (need len>=40)"
  exit 1
fi

LIST=$(api GET /panel/api/inbounds/list)
INB_ID=$(printf '%s' "$LIST" | jq -r '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.protocol=="vless" and ((.streamSettings|tostring)|contains("realitySettings")))] | .[0].id // empty')
echo "reality inbound id: $INB_ID"
if [ -z "$INB_ID" ]; then echo "DE_FAIL: reality inbound not found"; exit 1; fi

CL_BEFORE=$(printf '%s' "$LIST" | jq -r '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.id=='"$INB_ID"')] | .[0].settings | (if type=="object" then (.clients // []) else (try ((fromjson).clients // []) catch []) end) | length')
echo "clients on inbound before: $CL_BEFORE"

UPD=$(printf '%s' "$LIST" | jq -c --argjson id "$INB_ID" --arg priv "$PRIV" --arg pub "$PUB" '
  (.obj | if type=="array" then . else (.rows // []) end)
  | [.[]? | select(.id==$id)] | .[0]
  | .streamSettings = (.streamSettings | if type=="object" then . else (try fromjson catch {}) end)
  | .streamSettings.realitySettings.privateKey = $priv
  | .streamSettings.realitySettings.publicKey = $pub
')
if [ -z "$UPD" ]; then echo "DE_FAIL: could not build update object"; exit 1; fi

RESP=$(api POST "/panel/api/inbounds/update/$INB_ID" "$UPD")
echo "update: $(printf '%s' "$RESP" | head -c 200)"
sleep 4

LIST2=$(api GET /panel/api/inbounds/list)
NEW_PRIV_IN_LIST=$(printf '%s' "$LIST2" | jq -r '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.id=='"$INB_ID"')] | .[0] | (.streamSettings | if type=="object" then . else (try fromjson catch {}) end).realitySettings.privateKey // empty')
CL_AFTER=$(printf '%s' "$LIST2" | jq -r '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.id=='"$INB_ID"')] | .[0].settings | (if type=="object" then (.clients // []) else (try ((fromjson).clients // []) catch []) end) | length')
echo "clients on inbound after: $CL_AFTER"

LINKS=$(api GET /panel/api/clients/links/sonic-main)
VPUB=$(printf '%s' "$LINKS" | grep -oE 'pbk=[A-Za-z0-9+/=]+' | head -1 | sed 's/^pbk=//')
echo "panel link pbk: $VPUB (len ${#VPUB})"

if [ "$NEW_PRIV_IN_LIST" = "$PRIV" ] && [ "$VPUB" = "$PUB" ] && [ "$CL_AFTER" = "$CL_BEFORE" ]; then
  echo "DE_FIXED: $PUB"
else
  echo "DE_FAIL: verification mismatch (priv_in_list=$([ "$NEW_PRIV_IN_LIST" = "$PRIV" ] && echo yes || echo no), link_pbk=$([ "$VPUB" = "$PUB" ] && echo yes || echo no), clients=$CL_AFTER/$CL_BEFORE)"
fi
