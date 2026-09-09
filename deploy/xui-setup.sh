#!/usr/bin/env bash
# ============================================================
#  Sonic VPN — настройка 3x-ui (запускать на НЕМЕЦКОМ сервере)
#  Поддерживает 3x-ui v3 (CSRF + отдельный API /clients).
#  Сам создаёт inbound VLESS+Reality на порту 443 + клиента
#  sonic-main, генерирует Reality-ключи, открывает панель для
#  русского сервера и печатает Public Key + значения для .env.
#
#  Запуск:  bash xui-setup.sh ЛОГИН_ПАНЕЛИ ПАРОЛЬ_ПАНЕЛИ [IP_RU_СЕРВЕРА]
# ============================================================
set -euo pipefail

U="${1:-}"; P="${2:-}"; RU_IP="${3:-}"
[ -n "$U" ] && [ -n "$P" ] || { echo "Запуск: bash xui-setup.sh ЛОГИН_ПАНЕЛИ ПАРОЛЬ_ПАНЕЛИ [IP_RU_СЕРВЕРА]"; exit 1; }

c() { printf "\n\033[1;34m==> %s\033[0m\n" "$1"; }

c "jq (парсинг JSON)"
command -v jq &>/dev/null || apt-get install -y -qq jq

c "Читаю настройки панели (порт, путь)"
S=$(x-ui settings 2>/dev/null || true)
PORT=$(printf '%s\n' "$S" | awk '/^port:/{print $2}' | tr -d '[:space:]')
BASE=$(printf '%s\n' "$S" | awk '/^webBasePath:/{print $2}' | tr -d '[:space:]')
[ -n "$PORT" ] || { echo "Не удалось прочитать порт панели (x-ui settings). Запустите от root."; exit 1; }
[ -n "$BASE" ] || BASE="/"
BASE_NOSLASH=$(printf '%s' "$BASE" | sed 's#/$##')
echo "Порт: $PORT  Путь: $BASE"

SCHEME=https
curl -ks --max-time 5 "https://127.0.0.1:$PORT$BASE/" -o /dev/null 2>/dev/null || SCHEME=http
URL="$SCHEME://127.0.0.1:$PORT$BASE_NOSLASH"
echo "Панель: $URL"

c "Вход в панель по API (v3: csrf-token → login)"
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
JAR=/tmp/.xui-jar
rm -f "$JAR"
CSRF_JSON=$(curl -ks -c "$JAR" "$URL/csrf-token")
CSRF=$(printf '%s' "$CSRF_JSON" | jq -r '.obj // empty' 2>/dev/null || true)
[ -n "$CSRF" ] || { echo "❌ Не получен CSRF-токен: $CSRF_JSON"; exit 1; }
LOGIN_RESP=$(curl -ks -b "$JAR" -c "$JAR" -X POST "$URL/login" \
  -H 'Content-Type: application/json' -H "User-Agent: $UA" -H "X-CSRF-Token: $CSRF" \
  -d "{\"username\":\"$U\",\"password\":\"$P\"}")
if [ "$(printf '%s' "$LOGIN_RESP" | jq -r '.success // false' 2>/dev/null)" != "true" ]; then
  MSG=$(printf '%s' "$LOGIN_RESP" | jq -r '.msg // "(пустой ответ)"' 2>/dev/null)
  echo "❌ Вход не удался: $MSG"
  echo "   1) Проверьте логин/пароль панели (меню x-ui → пункт 7)."
  echo "   2) 5 неудачных входов подряд = блок на 15 минут (просто подождите)."
  exit 1
fi
echo "Вход выполнен"

api() { # api GET|POST /path [json]
  local m="$1" p="$2" d="${3:-}"
  if [ "$m" = POST ]; then
    curl -ks -b "$JAR" -H "User-Agent: $UA" -H "X-CSRF-Token: $CSRF" \
      -H 'Content-Type: application/json' -X POST "$URL$p" -d "$d"
  else
    curl -ks -b "$JAR" -H "User-Agent: $UA" "$URL$p"
  fi
}

XRAY_BIN=$(command -v xray || echo /usr/local/bin/xray)
PUB=""; PRIV=""

c "Ищу существующий VLESS+Reality inbound"
LIST_JSON=$(api GET /panel/api/inbounds/list)
ROWS_NORMALIZE='(.obj | if type=="array" then . elif type=="object" then (.rows // []) else [] end)'
INB_ID=$(printf '%s' "$LIST_JSON" | jq -r "${ROWS_NORMALIZE} | [.[]? | select(.protocol==\"vless\" and ((.streamSettings|tostring) | contains(\"realitySettings\")))] | .[0].id // empty")

if [ -n "$INB_ID" ]; then
  echo "Inbound уже есть (id=$INB_ID) — переиспользую"
  PRIV=$(printf '%s' "$LIST_JSON" | jq -r --argjson id "$INB_ID" "${ROWS_NORMALIZE} | [.[]? | select(.id==\$id)] | .[0] | (.streamSettings | if type==\"object\" then . else fromjson end).realitySettings.privateKey // empty")
else
  c "Создаю inbound VLESS+Reality (порт 443)"
  KEYS=$("$XRAY_BIN" x25519)
  PRIV=$(printf '%s\n' "$KEYS" | awk -F': ' '/Private key/{print $2}' | tr -d '[:space:]')
  PUB=$(printf '%s\n' "$KEYS" | awk -F': ' '/Public key/{print $2}' | tr -d '[:space:]')
  [ -n "$PRIV" ] && [ -n "$PUB" ] || { echo "❌ Не сгенерировались Reality-ключи (xray x25519)"; exit 1; }
  STREAM_JSON=$(jq -cn --arg priv "$PRIV" '{network:"tcp",security:"reality",realitySettings:{show:false,xver:0,dest:"www.microsoft.com:443",serverNames:["www.microsoft.com"],privateKey:$priv,minClientVer:"",maxClientVer:"",shortIds:[],spiderX:"/"}}')
  ADD_JSON=$(jq -cn --arg stream "$STREAM_JSON" '{remark:"Sonic Основной",listen:"",port:443,protocol:"vless",settings:"{\"clients\":[],\"decryption\":\"none\"}",streamSettings:$stream,tag:"sonic-vless-443",sniffing:"{\"enabled\":true,\"destOverride\":[\"http\",\"tls\",\"quic\"]}",enable:true}')
  ADD_RESP=$(api POST /panel/api/inbounds/add "$ADD_JSON")
  INB_ID=$(printf '%s' "$ADD_RESP" | jq -r '(.obj | if type=="object" then .id else . end) // empty')
  [ -n "$INB_ID" ] || { echo "❌ Не удалось создать inbound: $ADD_RESP"; exit 1; }
  echo "Inbound создан (id=$INB_ID)"
fi

c "Проверяю основного клиента (sonic-main)"
C_LIST=$(api GET /panel/api/clients/list)
CID=$(printf '%s' "$C_LIST" | jq -r '(.obj | if type=="array" then . elif type=="object" then (.rows // []) else [] end) | [.[]? | select(.email=="sonic-main")] | .[0].id // empty')
if [ -z "$CID" ]; then
  echo "Создаю клиента sonic-main"
  CID=$(cat /proc/sys/kernel/random/uuid)
  CLIENT_JSON=$(jq -cn --arg id "$CID" --argjson inb "$INB_ID" '{client:{id:$id,security:"",email:"sonic-main",flow:"xtls-rprx-vision",limitIp:1,totalGB:0,enable:true,comment:"Sonic main"},inboundIds:[$inb]}')
  C_RESP=$(api POST /panel/api/clients/add "$CLIENT_JSON")
  if [ "$(printf '%s' "$C_RESP" | jq -r '.success // false')" != "true" ]; then
    echo "❌ Не удалось создать клиента: $C_RESP"; exit 1
  fi
else
  echo "Клиент sonic-main уже есть — переиспользую"
fi

c "Получаю Public Key"
VLINK=""
# 1) готовая vless-ссылка sonic-main из панели (содержит pbk=...)
LINK_JSON=$(api GET "/panel/api/clients/links/sonic-main")
PANEL_LINK=$(printf '%s' "$LINK_JSON" | jq -r '.obj | if type=="array" then .[0] elif type=="string" then . else empty end' 2>/dev/null || true)
PUB=$(printf '%s' "$PANEL_LINK" | grep -oE 'pbk=[A-Za-z0-9+/=]+' | head -1 | sed 's/^pbk=//')
if [ -n "$PUB" ]; then
  echo "Public Key получен из ссылки панели"
  VLINK="$PANEL_LINK"
fi
# 2) конфиг xray на диске (privateKey)
if [ -z "$PUB" ]; then
  XRAY_CFG=$(ls /usr/local/etc/xray/config.json /etc/xray/config.json 2>/dev/null | head -1 || true)
  if [ -n "$XRAY_CFG" ]; then
    PRIV=$(grep -oE '"privateKey" *: *"[^"]+"' "$XRAY_CFG" 2>/dev/null | head -1 | sed -E 's/.*"privateKey" *: *"([^"]+)".*/\1/')
  fi
fi
# 3) privateKey из списка inbound (если панель его отдаёт)
if [ -z "$PUB" ] && [ -n "$PRIV" ]; then
  KEYS2=$("$XRAY_BIN" x25519 -i "$PRIV" 2>/dev/null || true)
  PUB=$(printf '%s\n' "$KEYS2" | awk -F': ' '/Public key/{print $2}' | tr -d '[:space:]')
fi
[ -n "$PUB" ] || { echo "❌ Не удалось получить Public Key (ни из ссылок панели, ни из конфига xray)"; exit 1; }

if [ -n "$RU_IP" ]; then
  c "Открываю порт панели ($PORT) для RU-сервера $RU_IP"
  ufw allow from "$RU_IP" to any port "$PORT" proto tcp || true
fi

PUBIP=$(curl -s --max-time 6 https://ifconfig.me 2>/dev/null || true)
case "$PUBIP" in
  *[!0-9.]*) PUBIP="185.125.102.135";;
esac
[ -n "$PUBIP" ] || PUBIP="185.125.102.135"

if [ -z "$VLINK" ]; then
  VLINK="vless://${CID}@${PUBIP}:443?encryption=none&security=reality&sni=www.microsoft.com&pbk=${PUB}&fp=chrome&flow=xtls-rprx-vision&type=tcp/#SonicVPN"
fi

echo
echo "============================================================"
echo "  ГОТОВО ✅"
echo
echo "  Public Key:  $PUB"
echo "  Клиент:      $CID"
echo
echo "  VLESS-ссылка для теста на телефоне (v2rayNG → «Импорт из буфера обмена»):"
echo "  $VLINK"
echo
echo "  Значения для .env (русский сервер, шаг 6):"
echo "    XUI_BASE=$SCHEME://${PUBIP}:${PORT}${BASE_NOSLASH}"
echo "    XUI_USER=<логин панели>"
echo "    XUI_PASSWORD=<пароль панели>"
echo "    XUI_HOST=$PUBIP"
echo "    XUI_PORT=443"
echo "    XUI_SNI=www.microsoft.com"
echo "    XUI_PUB_KEY=$PUB"
echo "============================================================"
echo "__SONIC_XUI_OK__"
