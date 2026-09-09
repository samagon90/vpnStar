#!/usr/bin/env bash
# ============================================================
#  Sonic VPN — сайт + база + админка (запускать на РУССКОМ сервере)
#  Клонирует репозиторий, ставит зависимости, настраивает Caddy
#  (домен + по IP), пишет .env (секреты генерируются сами +
#  данные панели 3x-ui из аргументов), запускает pm2 и делает
#  самопроверку: создаёт тестовый аккаунт — это проверяет ВСЮ
#  цепочку «сайт → русский сервер → немецкий 3x-ui».
#
#  Запуск:
#    bash app-setup.sh ЛОГИН_ПАНЕЛИ ПАРОЛЬ_ПАНЕЛИ PUBLIC_KEY [XUI_BASE]
#  (XUI_BASE по умолчанию — ваша панель 3x-ui; повторный запуск
#   безопасен: обновляет код и перезапускает, .env не трогает)
# ============================================================
set -euo pipefail

U="${1:-}"; P="${2:-}"; PUBKEY="${3:-}"
XUI_BASE="${4:-https://185.125.102.135:20461/3dtIfnbTYAw5E0rNtB}"
DOMAIN="sonicvpn.ru"
DE_IP="${XUI_BASE#*://}"; DE_IP="${DE_IP%%:*}"
RU_IP=$(curl -s --max-time 6 https://ifconfig.me 2>/dev/null || true)
case "$RU_IP" in ''|*[!0-9.]*) RU_IP="87.249.49.204";; esac
[ -n "$RU_IP" ] || RU_IP="87.249.49.204"

[ -n "$U" ] && [ -n "$P" ] && [ -n "$PUBKEY" ] || {
  echo "Запуск: bash app-setup.sh ЛОГИН_ПАНЕЛИ ПАРОЛЬ_ПАНЕЛИ PUBLIC_KEY [XUI_BASE]"; exit 1; }

c() { printf "\n\033[1;34m==> %s\033[0m\n" "$1"; }

c "Код → /opt/sonicvpn"
if [ -d /opt/sonicvpn/.git ]; then
  git -C /opt/sonicvpn fetch -q origin arena/01a05219-vpnstar
  git -C /opt/sonicvpn reset --hard -q origin/arena/01a05219-vpnstar
else
  git clone -q -b arena/01a05219-vpnstar https://github.com/samagon90/vpnStar.git /opt/sonicvpn
fi

c "Зависимости (npm install)"
cd /opt/sonicvpn/server
npm install --no-audit --no-fund --loglevel=error

c "Caddy: домен $DOMAIN + доступ по IP"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    reverse_proxy 127.0.0.1:3000
    encode gzip
}
api.$DOMAIN {
    reverse_proxy 127.0.0.1:3000
    encode gzip
}
:80 {
    reverse_proxy 127.0.0.1:3000
}
:8080 {
    reverse_proxy 127.0.0.1:3000
}
EOF
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null || { echo "❌ Caddy: конфигурация не прошла валидацию"; exit 1; }
systemctl restart caddy
echo "Caddy перезапущен"

c ".env"
if [ -f .env ]; then
  echo ".env уже существует — оставляю без изменений (код и сервис обновлю)"
else
  cp .env.example .env
  SECRET=$(openssl rand -hex 32)
  ADMIN=$(openssl rand -hex 16)
  sed -i \
    -e "s|^BASE_URL=.*|BASE_URL=http://$RU_IP|" \
    -e "s|^SECRET_KEY=.*|SECRET_KEY=$SECRET|" \
    -e "s|^PAYMENT_MODE=.*|PAYMENT_MODE=mock|" \
    -e "s|^XUI_BASE=.*|XUI_BASE=$XUI_BASE|" \
    -e "s|^XUI_USER=.*|XUI_USER=$U|" \
    -e "s|^XUI_PASSWORD=.*|XUI_PASSWORD=$P|" \
    -e "s|^AI_API_BASE=.*|AI_API_BASE=https://api.groq.com/openai/v1|" \
    -e "s|^AI_MODEL=.*|AI_MODEL=llama-3.3-70b-versatile|" \
    -e "s|^ADMIN_TOKEN=.*|ADMIN_TOKEN=$ADMIN|" \
    .env
  {
    echo "XUI_HOST=$DE_IP"
    echo "XUI_PORT=443"
    echo "XUI_SNI=www.microsoft.com"
    echo "XUI_PUB_KEY=$PUBKEY"
  } >> .env
  echo ".env создан (сайт: http://$RU_IP, admin-токен: $ADMIN)"
fi

c "Смягчаю fail2ban (10 попыток / блок 5 минут — чтобы не самозапирались)"
if command -v fail2ban-client &>/dev/null; then
  printf '[sshd]\nenabled = true\nmaxretry = 10\nfindtime = 600\nbantime = 300\n' > /etc/fail2ban/jail.d/sshd-relaxed.conf
  fail2ban-client reload 2>/dev/null || systemctl restart fail2ban 2>/dev/null || true
fi

c "Запуск (pm2) + автозапуск при перезагрузке"
pm2 delete sonicvpn 2>/dev/null || true
pm2 start src/index.js --name sonicvpn
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
pm2 save

c "Самопроверка"
sleep 2
HEALTH=$(curl -s --max-time 5 http://127.0.0.1:3000/api/health || echo "")
echo "health: $HEALTH"
TS=$(date +%s)
REG=$(curl -s --max-time 90 -X POST http://127.0.0.1:3000/api/register -H 'Content-Type: application/json' \
  -d "{\"username\":\"selftest-$TS\",\"password\":\"12345678\"}" || echo "")
echo "$REG" | head -c 300; echo
if printf '%s' "$REG" | grep -q '"error"'; then
  echo "❌ Самопроверка не удалась: аккаунт не создан."
  echo "   Часто это значит: сайт не может попасть на немецкую 3x-ui."
  echo "   Проверьте: 1) скрипт xui-setup.sh на DE завершился «ГОТОВО ✅»,"
  echo "              2) на DE выполнено: ufw allow from $RU_IP to any port $(printf '%s' "$XUI_BASE" | sed -E 's#https?://[^/:]+:([0-9]+).*#\1#') proto tcp"
  exit 1
fi
echo "Самопроверка: тестовый аккаунт создан, ключ сгенерирован — вся цепочка работает ✅"

echo
echo "============================================================"
echo "  САЙТ ЖИВ ✅"
echo
echo "  Сайт:         http://$RU_IP/"
echo "  Админка:      http://$RU_IP/admin.html"
echo "  Токен админки: $ADMIN   ← ЗАПИШИТЕ, потеряете — войдите на сервер и посмотрите /opt/sonicvpn/server/.env"
echo
echo "  Дальше: откройте сайт в браузере → «Регистрация»"
echo "  (логин любой, пароль от 6 символов) → получите QR-код"
echo "  для v2rayNG. Платежи пока в тестовом режиме (mock)."
echo "============================================================"
echo "__SONIC_SITE_OK__"
