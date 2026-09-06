#!/usr/bin/env bash
# ============================================================
#  Sonic VPN — НЕМЕЦКИЙ сервер: ТОЛЬКО VPN (3x-ui + xray)
#  Ubuntu 22.04/24.04, запускать от root.
#  Сайта и базы клиентов здесь НЕТ — они на русском сервере
#  (deploy/vps-setup-ru.sh). Здесь только VPN-трафик (no-logs).
#
#  Запуск: sudo bash vps-setup-de.sh [IP_РУССКОГО_СЕРВЕРА]
#  (IP нужен, чтобы панель 3x-ui была доступна только ему)
# ============================================================
set -euo pipefail

RU_IP="${1:-}"
c() { printf "\n\033[1;34m==> %s\033[0m\n" "$1"; }

[ "$(id -u)" = "0" ] || { echo "Запустите от root: sudo bash $0"; exit 1; }

c "Системные пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates ufw fail2ban git unzip

c "Swap (если RAM < 4 GB)"
free -m | awk 'NR==2{if ($2 < 4000) print "yes"}' | grep -q yes && {
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q swapfile /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab
  echo "swap добавлен: 2 GB"
} || echo "swap не нужен"

c "Установка 3x-ui (панель VLESS Reality / Hysteria2)"
if [ -d /usr/local/bin/x-ui ] || [ -f /etc/x-ui/panel ]; then
  echo "3x-ui уже установлен"
else
  bash <(curl -L https://raw.githubusercontent.com/mhsanaei/3x-ui/master/install.sh)
fi

# порт панели (печатается установщиком; пробуем прочитать из конфига)
PORT_UI=$(grep -oP '"port"\s*:\s*\K[0-9]+' /etc/x-ui/panel.json 2>/dev/null | head -1 || true)
[ -n "$PORT_UI" ] || PORT_UI=2053
echo "порт панели 3x-ui: $PORT_UI"

c "Firewall (UFW) — VPN + панель"
ufw allow OpenSSH
ufw allow 443/tcp    # VLESS+Reality (основной)
ufw allow 443/udp    # запасной (QUIC)
ufw allow 8443/udp   # Hysteria2 (запасной, шаг 4 гайда)
if [ -n "$RU_IP" ]; then
  ufw allow from "$RU_IP" to any port "$PORT_UI" proto tcp
  echo "панель 3x-ui ($PORT_UI) открыта ТОЛЬКО для $RU_IP"
else
  ufw allow "$PORT_UI"/tcp
  echo "ВНИМАНИЕ: панель ($PORT_UI) открыта всем — после входа смените порт и пароль (x-ui setting)"
fi
ufw --force enable

c "Fail2ban (защита SSH)"
systemctl enable fail2ban 2>/dev/null || true
systemctl restart fail2ban 2>/dev/null || true

echo
echo "============================================================"
echo "  НЕМЕЦКИЙ сервер готов. Дальше:"
echo "  1. Откройте панель 3x-ui:  http://IP_ЭТОГО_СЕРВЕРА:$PORT_UI"
echo "  2. Создайте inbound VLESS+Reality на порту 443 (шаг 4 гайда)"
echo "  3. Логин/пароль панели → в .env на РУССКОМ сервере:"
echo "     XUI_BASE=http://IP_ЭТОГО_СЕРВЕРА:$PORT_UI"
echo "     XUI_USER=...  XUI_PASSWORD=..."
echo "============================================================"
