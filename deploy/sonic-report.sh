#!/bin/bash
# Sonic VPN: снимок состояния для разбора с AI.
# Запуск: bash /opt/sonic-report.sh
# Вывод: /var/log/sonic-report-<дата>.txt — скопируй его содержимое в чат с AI,
# и он предложит улучшения/починит найденное.
OUT=/var/log/sonic-report-$(date -u +%Y%m%d-%H%M).txt
{
echo "===== SONIC-REPORT $(date -u +%FT%TZ) ====="
echo "--- uptime/load ---"
uptime
echo "--- pm2 ---"
pm2 list 2>/dev/null | grep -E "sonicvpn|status|online|errored" | head -5
echo "--- app health ---"
curl -s --max-time 10 http://127.0.0.1:80/api/health
echo ""
echo "--- debug/server (мост+панель) ---"
curl -s --max-time 25 http://127.0.0.1:80/api/debug/server | head -c 500
echo ""
echo "--- xrayru ---"
systemctl is-active xrayru
echo "--- DB counts ---"
node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/opt/sonicvpn/data/sonicvpn.db');for(const t of ['users','devices','payments','admins'])try{console.log(t+':'+db.prepare('SELECT COUNT(*) c FROM '+t).get().c)}catch(e){console.log(t+':?')}" 2>/dev/null
echo "--- paid sum ---"
node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/opt/sonicvpn/data/sonicvpn.db');console.log('paid_cents:'+db.prepare(\"SELECT COALESCE(SUM(amount_cents),0) s FROM payments WHERE status='paid'\").get().s)" 2>/dev/null
echo "--- monitor fails (24h) ---"
grep -c "FAIL" /var/log/sonicvpn-monitor.log 2>/dev/null || echo 0
grep "FAIL" /var/log/sonicvpn-monitor.log 2>/dev/null | tail -5
echo "--- stability tail ---"
tail -5 /var/log/sonicvpn-stability.log 2>/dev/null
echo "--- app errors (recent) ---"
grep -aiE "error|exception|failed" /root/.pm2/logs/sonicvpn-error.log 2>/dev/null | grep -av "ExperimentalWarning\|trace-warnings" | tail -8 | cut -c1-200
echo "--- disk/ram ---"
df -h / | tail -1
free -m | head -2
echo "===== END ====="
} > "$OUT" 2>&1
echo "REPORT:$OUT"
