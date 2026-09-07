#!/usr/bin/env bash
# ============================================================
#  Sonic VPN — настройка 3x-ui (запускать на НЕМЕЦКОМ сервере)
#  Сам создаёт inbound VLESS+Reality на порту 443 + первого
#  клиента, генерирует Reality-ключи, открывает панель для
#  русского сервера и печатает Public Key + значения для .env.
#  Если в панели уже создан vless-inbound — переиспользует его.
#
#  Запуск:  bash xui-setup.sh ЛОГИН_ПАНЕЛИ ПАРОЛЬ_ПАНЕЛИ [IP_RU_СЕРВЕРА]
# ============================================================
set -euo pipefail

U="${1:-}"; P="${2:-}"; RU_IP="${3:-}"
[ -n "$U" ] && [ -n "$P" ] || { echo "Запуск: bash xui-setup.sh ЛОГИН_ПАНЕЛИ ПАРОЛЬ_ПАНЕЛИ [IP_RU_СЕРВЕРА]"; exit 1; }

c() { printf "\n\033[1;34m==> %s\033[0m\n" "$1"; }

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

c "Вход в панель по API"
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
ORIGIN=$(printf '%s' "$URL" | sed -E 's#(https?://[^/]+).*#\1#')
JAR=/tmp/.xui-jar
rm -f "$JAR"
LOGIN_RESP=$(curl -ks -c "$JAR" -X POST "$URL/login" \
  -H 'Content-Type: application/json' -H "User-Agent: $UA" \
  -H "Origin: $ORIGIN" -H "Referer: $URL/" \
  -d "{\"username\":\"$U\",\"password\":\"$P\"}")
printf '%s' "$LOGIN_RESP" | grep -q '"success":true' || {
  echo "❌ Вход не удался: $LOGIN_RESP"
  echo "Проверьте логин/пароль (пункт 7 меню x-ui: Reset Username & Password)."; exit 1; }
TOKEN=$(awk 'NF>=7 && $6 ~ /auth/ {print $7}' "$JAR" 2>/dev/null | head -1 || true)
[ -n "$TOKEN" ] || TOKEN=$(awk 'NF==7 {print $7}' "$JAR" 2>/dev/null | head -1 || true)
echo "Вход выполнен"

api() { # api GET|POST /path [json]
  local m="$1" p="$2" d="${3:-}"
  if [ "$m" = POST ]; then
    curl -ks -b "$JAR" -H "x-client-token: $TOKEN" -H 'Content-Type: application/json' -X POST "$URL$p" -d "$d"
  else
    curl -ks -b "$JAR" -H "x-client-token: $TOKEN" "$URL$p"
  fi
}

XRAY_BIN=$(command -v xray || echo /usr/local/bin/xray)
c "Проверяю существующие inbound'ы"
LIST_JSON=$(api GET /panel/api/inbound/list)
PUB=""; CID=""

if printf '%s' "$LIST_JSON" | grep -q '"realitySettings"'; then
  echo "Reality-inbound уже есть — переиспользую"
  PRIV=$(printf '%s' "$LIST_JSON" | grep -oE '"privateKey":"[^"]+"' | head -1 | sed 's/"privateKey":"//; s/"$//')
  if [ -n "$PRIV" ]; then
    KEYS=$("$XRAY_BIN" x25519 -i "$PRIV" 2>/dev/null || true)
    PUB=$(printf '%s\n' "$KEYS" | awk -F': ' '/Public key/{print $2}' | tr -d '[:space:]')
  fi
  CID=$(printf '%s' "$LIST_JSON" | grep -oE '"id":"[0-9a-f-]{36}"' | head -1 | sed 's/"id":"//; s/"$//')
fi

if [ -z "$PUB" ]; then
  c "Создаю inbound VLESS+Reality (порт 443) + первый клиент"
  KEYS=$("$XRAY_BIN" x25519)
  PRIV=$(printf '%s\n' "$KEYS" | awk -F': ' '/Private key/{print $2}' | tr -d '[:space:]')
  PUB=$(printf '%s\n' "$KEYS" | awk -F': ' '/Public key/{print $2}' | tr -d '[:space:]')
  [ -n "$PRIV" ] && [ -n "$PUB" ] || { echo "❌ Не сгенерировались Reality-ключи (xray x25519)"; exit 1; }
  CID=$(cat /proc/sys/kernel/random/uuid)

  ADD_JSON=$(printf '{"settings":"{\"clients\":[{\"id\":\"%s\",\"email\":\"sonic-main\",\"flow\":\"xtls-rprx-vision\",\"limitIp\":1,\"totalGB\":0,\"enable\":true}],\"decryption\":\"none\"}","tag":"sonic-vless-443","streamSettings":"{\"network\":\"tcp\",\"security\":\"reality\",\"realitySettings\":{\"show\":false,\"xver\":0,\"dest\":\"www.microsoft.com:443\",\"serverNames\":[\"www.microsoft.com\"],\"privateKey\":\"%s\",\"minClientVer\":\"\",\"maxClientVer\":\"\",\"shortIds\":[],\"spiderX\":\"/\"}}","sniffing":"{\"enabled\":true,\"destOverride\":[\"http\",\"tls\",\"quic\"]}","port":443,"protocol":"vless","enable":true,"remark":"Sonic Основной"}' "$CID" "$PRIV")
  ADD_RESP=$(api POST /panel/api/inbound/add "$ADD_JSON")
  printf '%s' "$ADD_RESP" | grep -q '"success":true' || { echo "❌ Не удалось создать inbound: $ADD_RESP"; exit 1; }
  echo "Inbound создан"
fi

[ -n "$PUB" ] || { echo "❌ Не удалось получить Public Key"; exit 1; }
[ -n "$CID" ] || { echo "❌ Не найден ID клиента (создайте Add Client в панели и повторите)"; exit 1; }

if [ -n "$RU_IP" ]; then
  c "Открываю порт панели ($PORT) для RU-сервера $RU_IP"
  ufw allow from "$RU_IP" to any port "$PORT" proto tcp || true
fi

PUBIP=$(curl -s --max-time 6 https://ifconfig.me 2>/dev/null || true)
case "$PUBIP" in
  *[!0-9.]*) PUBIP="185.125.102.135";;
esac
[ -n "$PUBIP" ] || PUBIP="185.125.102.135"

VLINK="vless://${CID}@${PUBIP}:443?encryption=none&security=reality&sni=www.microsoft.com&pbk=${PUB}&fp=chrome&flow=xtls-rprx-vision&type=tcp/#SonicVPN"

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
