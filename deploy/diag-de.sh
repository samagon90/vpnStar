#!/usr/bin/env bash
# v4: РАЗВЕДКА — что реально установлено: процессы, порты, бинарники, живой ли Reality на 443
set +e
echo "=== processes ==="
ps auxww | grep -viE '\[|grep|diag|ps auxww' | head -25
echo ""
echo "=== running services ==="
systemctl list-units --type=service --state=running --no-pager 2>/dev/null | head -12
echo ""
echo "=== listening ports (owners) ==="
ss -tlnp 2>/dev/null | head -15
echo ""
echo "=== /usr/local/bin ==="
ls -la /usr/local/bin/ 2>/dev/null | head -25
echo ""
echo "=== hunt (xray / x-ui / 3x-ui files) ==="
find / -xdev -maxdepth 5 \( -name '*xray*' -o -name 'x-ui*' -o -name '3x-ui*' -o -name '*xui*' \) -type f 2>/dev/null | head -25
echo ""
echo "=== reality probe on 443 (SNI=www.microsoft.com через наш IP — если xray жив, прокинет на настоящий microsoft) ==="
curl -sk --resolve www.microsoft.com:443:185.125.102.135 --max-time 10 https://www.microsoft.com/ -o /dev/null -w 'reality probe: %{http_code} (200/301/307 = xray жив и прокидывает)\n'
curl -sk --max-time 8 https://185.125.102.135:443/ -o /dev/null -w 'plain probe (SNI=IP): %{http_code} (000/reset = Reality отбрасывает чужих, это норма)\n'
echo ""
echo "=== all /usr/local/bin & *ui*/*xray* processes ==="
for pid in /proc/[0-9]*; do
  EXE=$(readlink -f "$pid/exe" 2>/dev/null)
  case "$EXE" in
    */xray*|*/3x-ui*|*/x-ui*|/usr/local/bin/*)
      CMD=$(tr '\0' ' ' < "$pid/cmdline" 2>/dev/null | head -c 70)
      echo "pid $(basename "$pid"): $EXE  [$CMD]"
      ;;
  esac
done
echo ""
echo "=== panel dir (parent of first /usr/local/bin process) ==="
for pid in /proc/[0-9]*; do
  EXE=$(readlink -f "$pid/exe" 2>/dev/null)
  case "$EXE" in
    /usr/local/bin/*) ls -la "$(dirname "$EXE")" | head -25; break;;
  esac
done
