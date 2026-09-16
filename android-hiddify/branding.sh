#!/bin/bash
# Sonic VPN: ребрендинг Hiddify (пина v4.1.1) под нас.
# Вызывается из workflow ПОСЛЕ клонирования, ДО flutter build.
# Использование: branding.sh /tmp/hiddify "$GITHUB_WORKSPACE/android-hiddify/assets"
set -e
SRC="$1"
ICONS="$2"
echo "=== Sonic branding on $SRC ==="

# 1) package: тот же applicationId, что у текущего Sonic APK (обновление встанет поверх)
sed -i 's|applicationId "app.hiddify.com"|applicationId "ru.sonicvpn.app"|' "$SRC/android/app/build.gradle"
sed -i "s|namespace 'com.hiddify.hiddify'|namespace 'ru.sonicvpn.app'|" "$SRC/android/app/build.gradle"
grep -E "applicationId|namespace" "$SRC/android/app/build.gradle" | head -3

# 2) имя приложения
sed -i 's|android:label="Hiddify"|android:label="Sonic VPN"|' "$SRC/android/app/src/main/AndroidManifest.xml"
grep -c 'Sonic VPN' "$SRC/android/app/src/main/AndroidManifest.xml"

# 3) иконки: наши ic_launcher(+round/foreground) поверх совпадающих плотностей.
# Фон адаптивной иконки оставляем hiddify (наш щит поверх смотрится норм).
if [ -d "$ICONS/mipmap" ]; then
  for d in "$ICONS"/mipmap-*/; do
    dd=$(basename "$d")
    if [ -d "$SRC/android/app/src/main/res/$dd" ]; then
      for n in ic_launcher.png ic_launcher_round.png ic_launcher_foreground.png; do
        [ -f "$d/$n" ] && cp -v "$d/$n" "$SRC/android/app/src/main/res/$dd/$n" 2>/dev/null || true
      done
    fi
  done
fi

# 4) разведка: где зашиты ссылки на обновления/домены hiddify (лог в Actions)
echo "=== URL matches in lib/ (для ручной чистки) ==="
grep -rhoE "https://[a-zA-Z0-9./_-]*hiddify[a-zA-Z0-9./_-]*" "$SRC/lib" 2>/dev/null | sort | uniq -c | sort -rn | head -20 || true
grep -rl "github.com/hiddify/hiddify-app/releases" "$SRC/lib" 2>/dev/null | head -10 || true

# 5) проверка обновлений -> наши релизы (чтобы не тянуло Hiddify)
grep -rl "github.com/hiddify/hiddify-app/releases" "$SRC/lib" 2>/dev/null | while read -r f; do
  sed -i 's|github.com/hiddify/hiddify-app/releases|github.com/samagon90/vpnStar/releases|g' "$f"
  echo "PATCHED: $f"
done

echo "=== branding done ==="
