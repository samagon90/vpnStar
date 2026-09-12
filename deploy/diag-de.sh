#!/usr/bin/env bash
# Диагностика DE-сервера: реальный Public Key + схема панели (http/https)
set +e
CFG=""
[ -f /usr/local/etc/xray/config.json ] && CFG=/usr/local/etc/xray/config.json
[ -f /etc/xray/config.json ] && CFG=/etc/xray/config.json
echo "xray config: $CFG"
PK=$(grep -oE '"privateKey": *"[^"]+"' "$CFG" 2>/dev/null | head -1 | sed -E 's/.*"privateKey": *"(.*?)".*/\1/')
echo "privateKey length: ${#PK}"
if command -v xray >/dev/null 2>&1 && [ -n "$PK" ]; then
  xray x25519 -i "$PK" 2>/dev/null | grep -i 'public key'
fi
echo "=== local panel check (from DE itself) ==="
curl -s -o /dev/null -w 'local http  code: %{http_code}\n' --max-time 5 "http://127.0.0.1:20461/3dtIfnbTYAw5E0rNtB/"
curl -sk -o /dev/null -w 'local https code: %{http_code}\n' --max-time 5 "https://127.0.0.1:20461/3dtIfnbTYAw5E0rNtB/"
echo "=== local panel csrf (http) ==="
curl -s --max-time 5 "http://127.0.0.1:20461/3dtIfnbTYAw5E0rNtB/csrf-token" | head -c 120; echo
