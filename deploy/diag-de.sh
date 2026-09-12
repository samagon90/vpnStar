#!/usr/bin/env bash
# v3: найти xray (PATH/известные пути/живой процесс), сгенерировать пару,
#     обновить inbound. Если xray не дал ключи — печатает диагностику DE_NEEDS_KEYS.
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

echo "=== xray binary hunt ==="
echo "PATH=$PATH"
XP=$(command -v xray 2>/dev/null || true)
[ -n "$XP" ] && echo "in PATH: $XP" || echo "xray NOT in PATH"
for b in /usr/local/bin/xray /usr/bin/xray /opt/3x-ui/bin/xray /usr/local/xray/bin/xray; do
  [ -x "$b" ] && { echo "found: $b"; [ -z "$XP" ] && XP="$b"; }
done
if [ -z "$XP" ]; then
  for pid in $(pgrep -x xray 2>/dev/null) $(pgrep -f '3x-ui' 2>/dev/null); do
    EXE=$(readlink -f "/proc/$pid/exe" 2>/dev/null)
    [ -n "$EXE" ] && echo "process $pid exe: $EXE"
    XDIR=$(dirname "$EXE" 2>/dev/null)
    if [ -n "$XDIR" ] && [ -x "$XDIR/xray" ] && [ "$XDIR/xray" != "$EXE" ]; then
      echo "xray next to panel: $XDIR/xray"; XP="$XDIR/xray"; break
    fi
  done
fi
if [ -z "$XP" ]; then
  XP=$(find / -maxdepth 4 -name 'xray' -type f -perm -u+x 2>/dev/null | head -1)
  [ -n "$XP" ] && echo "found via find: $XP"
fi
if [ -z "$XP" ] || [ ! -x "$XP" ]; then
  echo "DE_NEEDS_KEYS: xray binary not found anywhere"
  exit 0
fi
echo "using xray: $XP"
"$XP" version 2>&1 | head -1

echo "=== x25519 ==="
KEYS=$("$XP" x25519 2>/tmp/x25519.err)
echo "x25519 exit=$? stdout_len=${#KEYS}"
[ -s /tmp/x25519.err ] && { echo "--- stderr:"; head -3 /tmp/x25519.err; }
[ -z "$KEYS" ] && KEYS=$("$XP" x25519 2>&1)
PRIV=$(printf '%s\n' "$KEYS" | awk -F': ' '/Private key/{print $2}' | tr -d '[:space:]')
PUB=$(printf '%s\n' "$KEYS" | awk -F': ' '/Public key/{print $2}' | tr -d '[:space:]')
echo "PRIV len=${#PRIV}  PUB len=${#PUB}"
if [ ${#PRIV} -lt 40 ] || [ ${#PUB} -lt 40 ]; then
  echo "--- raw output:"; printf '%s\n' "$KEYS" | head -8
  echo "DE_NEEDS_KEYS: x25519 produced no usable keys"
  exit 0
fi

echo "=== update inbound via panel API ==="
CSRF=$(curl -ks -c "$JAR" --max-time 8 "$BASE/csrf-token" | jq -r '.obj // empty' 2>/dev/null)
LOGIN=$(curl -ks -b "$JAR" -c "$JAR" --max-time 8 -X POST "$BASE/login" \
  -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
  -d '{"username":"12345678","password":"12345678"}')
echo "login: $(printf '%s' "$LOGIN" | head -c 100)"

LIST=$(api GET /panel/api/inbounds/list)
INB_ID=$(printf '%s' "$LIST" | jq -r '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.protocol=="vless" and ((.streamSettings|tostring)|contains("realitySettings")))] | .[0].id // empty')
echo "reality inbound id: $INB_ID"
if [ -z "$INB_ID" ]; then echo "DE_NEEDS_KEYS: reality inbound not found"; exit 0; fi

CL_BEFORE=$(printf '%s' "$LIST" | jq -r --argjson id "$INB_ID" '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.id==$id)] | .[0].settings | (if type=="object" then (.clients // []) else (try ((fromjson).clients // []) catch []) end) | length')
echo "clients on inbound before: $CL_BEFORE"

UPD=$(printf '%s' "$LIST" | jq -c --argjson id "$INB_ID" --arg priv "$PRIV" --arg pub "$PUB" '
  (.obj | if type=="array" then . else (.rows // []) end)
  | [.[]? | select(.id==$id)] | .[0]
  | .streamSettings = (.streamSettings | if type=="object" then . else (try fromjson catch {}) end)
  | .streamSettings.realitySettings.privateKey = $priv
  | .streamSettings.realitySettings.publicKey = $pub
')
[ -z "$UPD" ] && { echo "DE_NEEDS_KEYS: could not build update object"; exit 0; }

RESP=$(api POST "/panel/api/inbounds/update/$INB_ID" "$UPD")
echo "update: $(printf '%s' "$RESP" | head -c 200)"
sleep 4

LIST2=$(api GET /panel/api/inbounds/list)
NEW_PRIV_IN_LIST=$(printf '%s' "$LIST2" | jq -r --argjson id "$INB_ID" '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.id==$id)] | .[0] | (.streamSettings | if type=="object" then . else (try fromjson catch {}) end).realitySettings.privateKey // empty')
CL_AFTER=$(printf '%s' "$LIST2" | jq -r --argjson id "$INB_ID" '(.obj | if type=="array" then . else (.rows // []) end) | [.[]? | select(.id==$id)] | .[0].settings | (if type=="object" then (.clients // []) else (try ((fromjson).clients // []) catch []) end) | length')
LINKS=$(api GET /panel/api/clients/links/sonic-main)
VPUB=$(printf '%s' "$LINKS" | grep -oE 'pbk=[A-Za-z0-9+/=]+' | head -1 | sed 's/^pbk=//')
echo "clients after: $CL_AFTER  panel pbk: $VPUB (len ${#VPUB})"

if [ "$NEW_PRIV_IN_LIST" = "$PRIV" ] && [ "$VPUB" = "$PUB" ] && [ "$CL_AFTER" = "$CL_BEFORE" ]; then
  echo "DE_FIXED: $PUB"
else
  echo "DE_NEEDS_KEYS: update/verify mismatch (priv=$([ "$NEW_PRIV_IN_LIST" = "$PRIV" ] && echo ok || echo bad), pbk=$([ "$VPUB" = "$PUB" ] && echo ok || echo bad), clients=$CL_AFTER/$CL_BEFORE)"
fi
