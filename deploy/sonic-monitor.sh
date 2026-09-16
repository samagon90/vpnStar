#!/bin/bash
# Sonic VPN: проверка каждые 5 минут (cron) + самолечение + алерты владельцу в TG.
# Установка: cp deploy/sonic-monitor.sh /opt/sonicvpn-monitor.sh && chmod +x
#   echo "*/5 * * * * root /opt/sonicvpn-monitor.sh" > /etc/cron.d/sonicvpn-monitor
# Алерты: в server/.env добавить ADMIN_TG_CHAT_ID=<твой chat id> (узнать: @userinfobot).
LOG=/var/log/sonicvpn-monitor.log
STATE=/tmp/sonicvpn-mon-state
ts=$(date -u +%FT%TZ)
fail=""

H=$(curl -s --max-time 10 http://127.0.0.1:80/api/health || echo FAIL)
echo "$H" | grep -q '"ok":true' || fail="$fail app-health"
D=$(curl -s --max-time 25 http://127.0.0.1:80/api/debug/server || echo FAIL)
echo "$D" | grep -q '"tcp":"ok' || fail="$fail bridge-tcp"
# tls: любой HTTP-ответ = handshake прошёл (декой отвечает 200/301/302/403 — как повезёт)
echo "$D" | grep -qE '"tls":"[0-9]{3}' || fail="$fail bridge-tls"
systemctl is-active --quiet xrayru || fail="$fail xrayru"
for p in 443 8443; do
  timeout 8 bash -c "cat < /dev/null > /dev/tcp/185.125.102.135/$p" 2>/dev/null || fail="$fail de-$p"
done
timeout 5 bash -c "cat < /dev/null > /dev/tcp/127.0.0.1/443" 2>/dev/null || fail="$fail ru-443"

# --- самолечение (только RU-сторона, безопасное) ---
if echo "$fail" | grep -q "xrayru"; then
  systemctl restart xrayru
  sleep 3
  systemctl is-active --quiet xrayru && fail=$(echo "$fail" | sed 's/xrayru//') && fail="$fail xrayru-healed"
fi
if echo "$fail" | grep -q "app-health"; then
  pm2 restart sonicvpn >/dev/null 2>&1
  sleep 8
  H2=$(curl -s --max-time 10 http://127.0.0.1:80/api/health || echo FAIL)
  echo "$H2" | grep -q '"ok":true' && fail=$(echo "$fail" | sed 's/app-health//') && fail="$fail app-healed"
fi

# --- алерты только на переходах (чтобы не спамить каждые 5 минут) ---
prev="OK"
[ -f "$STATE" ] && prev=$(cat "$STATE")
cur="OK"
[ -n "$(echo $fail | tr -d ' ')" ] && cur="FAIL:$fail"
echo "$cur" > "$STATE"
if [ "$cur" != "$prev" ]; then
  echo "$ts $cur :: $(echo $D | head -c 200)" >> $LOG
  ENVF=/opt/sonicvpn/server/.env
  CHAT=$(grep -E '^ADMIN_TG_CHAT_ID=' $ENVF 2>/dev/null | cut -d= -f2)
  TOK=$(grep -E '^TG_BOT_TOKEN=' $ENVF 2>/dev/null | cut -d= -f2)
  if [ -n "$CHAT" ] && [ -n "$TOK" ]; then
    MSG="Sonic monitor $ts: $cur"
    curl -s --max-time 15 -X POST "https://api.telegram.org/bot$TOK/sendMessage" \
      -H 'Content-Type: application/json' \
      -d "{\"chat_id\":\"$CHAT\",\"text\":\"$MSG\"}" >/dev/null 2>&1 || true
  fi
else
  [ "$cur" = "OK" ] && echo "$ts OK" >> $LOG
fi
tail -2000 $LOG > $LOG.tmp 2>/dev/null; mv $LOG.tmp $LOG 2>/dev/null; true
