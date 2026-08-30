#!/usr/bin/env bash
# ============================================================
#  Sonic VPN — подготовка VPS (Ubuntu 22.04/24.04, root)
#  Ставит: 3x-ui (VLESS+Reality/Hysteria2), Caddy (авто-SSL),
#  UFW, swap, fail2ban, Uptime Kuma (опц., домен укажи позже)
#  Оплатить можно из РФ: AdminVPS / Timeweb Cloud (МИР, СБП)
# ============================================================
set -euo pipefail

DOMAIN="${1:-sonicvpn.ru}"
PORT_UI=3001

c() { printf "\n\033[1;34m==> %s\033[0m\n" "$1"; }

[ "$(id -u)" = "0" ] || { echo "Запустите от root: sudo bash $0"; exit 1; }

c "Системные пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates ufw fail2ban git unzip
mkdir -p /etc/caddy.d

c "Swap (если RAM < 8 GB)"
free -m | awk 'NR==2{if ($2 < 8000) print "yes"}' | grep -q yes && {
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q swapfile /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab
  echo "swap добавлен: 2 GB"
} || echo "swap не нужен"

c "Установка 3x-ui (панель VLESS Reality / Hysteria2 / AmneziaWG)"
if [ -d /usr/local/bin/x-ui ] || [ -f /etc/x-ui/panel ]; then
  echo "3x-ui уже установлен"
else
  bash <(curl -L https://raw.githubusercontent.com/mhsanaei/3x-ui/master/install.sh)
fi

c "Caddy (reverse-proxy + авто-сертификаты Let's Encrypt)"
if command -v caddy &>/dev/null; then
  echo "caddy уже установлен"
else
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/amd64 stable main" > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

# Caddyfile: сайт Sonic VPN на :8080 (Node-панель), авто-TLS
if [ ! -f /etc/caddy/Caddyfile ]; then cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.orig; fi
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
systemctl enable caddy && (systemctl restart caddy || true)

c "Установка Node.js 22 (панель + бот)"
if node -v 2>/dev/null | grep -qE '^v(2[2-9]|[3-9][0-9])'; then
  echo "node уже установлен: $(node -v)"
else
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

c "Firewall (UFW)"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp    # Reality/QUIC
ufw allow 2096/tcp   # запасной порт VLESS (поменяйте под свой)
ufw allow 8443/udp   # Hysteria2 (поменяйте под свой)
ufw allow 3001/tcp   # Uptime Kuma / панели
ufw --force enable

c "Fail2ban (защита SSH)"
systemctl enable fail2ban 2>/dev/null || true
systemctl restart fail2ban 2>/dev/null || true

c "pm2 (демон-менеджер для панели/бота)"
npm install -g pm2 2>/dev/null || echo "pm2 — поставьте вручную: npm i -g pm2"

echo
echo "============================================================"
echo "  ГОТОВО. Дальше:"
echo "  1. Панель 3x-ui: x-ui (или 3x-ui) — откроется логин-форма,"
echo "     или смотрите: journalctl -u 3x-ui -f  /  x-ui panel -p <порт>"
echo "  2. Создайте inbound VLESS+Reality + Hysteria2 (см. deploy/README.md)"
echo "  3. Задеплойте панель Sonic VPN:"
echo "     git clone -b arena/01a05219-vpnstar https://github.com/samagon90/vpnStar.git /opt/sonicvpn"
echo "     cd /opt/sonicvpn/server && npm install && cp .env.example .env && nano .env"
echo "     pm2 start src/index.js --name sonicvpn && pm2 save && pm2 startup"
echo "  4. Пропишите в Cloudflare: $DOMAIN → IP этого VPS (прокси ВКЛ)"
echo "  5. Проверьте: curl -I https://$DOMAIN/api/health"
echo "============================================================"
