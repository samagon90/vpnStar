#!/bin/bash
# Sonic VPN: ежедневный кросс-бэкап RU<->DE + опционально в Google Drive.
# Установка: cp deploy/sonic-backup.sh /opt/sonic-backup.sh && chmod +x
#   echo "0 3 * * * root /opt/sonic-backup.sh" > /etc/cron.d/sonic-backup
# Google Drive (один раз, руками): rclone authorize  ->  rclone config ->
#   создать remote с именем "gdrive", дальше скрипт сам зальёт свежайшее.
# Восстановление RU: tar xzf sonicvpn-RU-<дата>.tgz -C /
# Восстановление DE: распаковать dump, восстановить таблицы/конфиги из архива.
set -u
D=$(date -u +%Y%m%d)
BDIR=/root/backups
mkdir -p $BDIR
DE_SSH_KEY=/root/.ssh/id_ed25519
DE="ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=no -i $DE_SSH_KEY root@185.125.102.135"
SCP="scp -o BatchMode=yes -o StrictHostKeyChecking=no -i $DE_SSH_KEY"

# 1) DE: каталог + дамп панели + конфиги (сначала — чтобы каталог точно был)
$DE "mkdir -p $BDIR && sudo -u postgres pg_dump -d xui > $BDIR/xui-$D.sql && tar czf $BDIR/sonicvpn-DE-$D.tgz -C / root/backups/xui-$D.sql opt/xray-bridge/config.json usr/local/x-ui/bin/config.json && echo DE-packed" || echo "DE-pack FAIL"

# 2) RU: база + секреты -> на DE
tar czf $BDIR/sonicvpn-RU-$D.tgz -C / opt/sonicvpn/data opt/sonicvpn/server/.env 2>/dev/null
$SCP $BDIR/sonicvpn-RU-$D.tgz root@185.125.102.135:$BDIR/ 2>/dev/null && echo "RU->DE ok" || echo "RU->DE FAIL"

# 3) DE-архив -> забрать на RU
$SCP root@185.125.102.135:$BDIR/sonicvpn-DE-$D.tgz $BDIR/ 2>/dev/null && echo "DE->RU ok" || echo "DE->RU FAIL"

# 4) Google Drive — только если remote настроен
if rclone listremotes 2>/dev/null | grep -q "^gdrive:"; then
  rclone copy $BDIR/sonicvpn-RU-$D.tgz gdrive:sonic/ 2>/dev/null && echo "gdrive ok" || echo "gdrive FAIL"
else
  echo "gdrive: remote не настроен (rclone config) — пропуск"
fi

# 5) ротация: держать 7 суток
find $BDIR -name "sonicvpn-*.tgz" -mtime +7 -delete 2>/dev/null
$DE "find $BDIR -name 'sonicvpn-*.tgz' -o -name 'xui-*.sql' -mtime +7 -delete 2>/dev/null; true"
ls -la $BDIR | tail -5
