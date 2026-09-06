#!/usr/bin/env bash
# ============================================================
#  Sonic VPN — РУСКИЙ сервер: сайт + база клиентов + бот + админка
#  Ubuntu 22.04/24.04, запускать от root.
#  VPN-сервера здесь НЕТ — он живёт на НЕМЕЦКОМ сервере
#  (deploy/vps-setup-de.sh). Разделение = персональные данные
#  клиентов в РФ (152-ФЗ), VPN-трафик — за границей.
#
#  Запуск: sudo bash vps-setup-ru.sh [домен]   (по умолчанию sonicvpn.ru)
# ============================================================
set -euo pipefail

DOMAIN="${1:-sonicvpn.ru}"
c() { printf "\n\033[1;34m==> %s\033[0m\n" "$1"; }

[ "$(id -u)" = "0" ] || { echo "Запустите от root: sudo bash $0"; exit 1; }

c "Системные пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates ufw fail2ban git unzip
mkdir -p /etc/caddy.d

c "Swap (если RAM < 4 GB)"
free -m | awk 'NR==2{if ($2 < 4000) print "yes"}' | grep -q yes && {
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q swapfile /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab
  echo "swap добавлен: 2 GB"
} || echo "swap не нужен"

c "Caddy (домен → Node, авто-сертификаты Let's Encrypt)"
[ -f /etc/caddy/Caddyfile ] && [ ! -f /etc/caddy/Caddyfile.orig ] && cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.orig
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    reverse_proxy 127.0.0.1:8080
    encode gzip
}
api.$DOMAIN {
    reverse_proxy 127.0.0.1:8080
    encode gzip
}
:8080 {
    # прямой доступ без домена (пока DNS не прописан)
    reverse_proxy 127.0.0.1:8080
}
EOF
if ! command -v caddy &>/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/amd64 stable main" > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi
systemctl enable caddy && (systemctl restart caddy || true)

c "Node.js 22 (сайт + бот + админка)"
if node -v 2>/dev/null | grep -qE '^v(2[2-9]|[3-9][0-9])'; then
  echo "node уже установлен: $(node -v)"
else
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

c "pm2 (демон-менеджер: приложение живёт после выхода из SSH)"
npm install -g pm2 2>/dev/null || echo "pm2 — поставьте вручную: npm i -g pm2"

c "Firewall (UFW) — только SSH и веб (VPN-портов здесь НЕТ)"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

c "Fail2ban (защита SSH)"
systemctl enable fail2ban 2>/dev/null || true
systemctl restart fail2ban 2>/dev/null || true

echo
echo "============================================================"
echo "  РУСКИЙ сервер готов. Дальше:"
echo "  1. На НЕМЕЦКОМ сервере: vps-setup-de.sh → создать inbound VLESS+Reality"
echo "  2. Задеплоить сервис (шаг 6 гайда):"
echo "     git clone -b arena/01a05219-vpnstar https://github.com/samagon90/vpnStar.git /opt/sonicvpn"
echo "     cd /opt/sonicvpn/server && npm install"
echo "     cp .env.example .env && nano .env"
echo "       (заполнить: XUI_BASE=http://IP_НЕМЕЦКОГО:порт_панели, XUI_USER, XUI_PASSWORD,"
echo "        ADMIN_TOKEN, TG_BOT_TOKEN, AI_API_BASE/AI_API_KEY...)"
echo "     pm2 start src/index.js --name sonicvpn && pm2 save && pm2 startup"
echo "  3. Cloudflare: $DOMAIN → IP ЭТОГО (русского) сервера, прокси ВКЛ"
echo "  4. Проверка: curl -I https://$DOMAIN/api/health"
echo "============================================================"
