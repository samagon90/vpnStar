# 📱 Sonic VPN — Android-приложение

Наше собственное приложение для Android — **ребрендинг [v2rayNG 2.2.6](https://github.com/2dust/v2rayNG)**
(funkциональность v2rayNG в полный объём: VLESS+Reality, Hysteria2, TUIC, Shadowsocks и т.д.).

| | |
|---|---|
| Имя приложения | **Sonic VPN** |
| Package (applicationId) | `ru.sonicvpn.app` (не конфликтует с v2rayNG, можно ставить рядом) |
| Иконка/цвета | синий Sonic-щит (#1e6fff / #45b8ff), `icon-source.png` — исходник |
| Лицензия | **GPL v3** (обязательно: v2rayNG — GPL, форк наследует; LICENSE остаётся в приложении) |

## Как собрать APK

Сборка идёт **на GitHub Actions** (в этой песочнице нет доступа к Maven/Android SDK — это нормально).
Workflow лежит в **`android/workflow/sonicvpn-android.yml`** (не в `.github/workflows/` — песочница
не имеет права пушить workflow-файлы, поэтому файл в репо «спит» в этой папке).

**Одноразовая активация (2 минуты, делает владелец в браузере):**
1. GitHub → репо vpnStar → вкладка **Add file** → **Create new file**
2. В поле имени файла: `.github/workflows/sonicvpn-android.yml` (создастся путь сам)
3. Вставить содержимое `android/workflow/sonicvpn-android.yml` → **Commit new file**
   (свой git-аккаунт права на workflows имеет — пуш из песочницы их не имеет)

**Дальше — каждый сборка = 1 клик:**
1. Вкладка **Actions** → workflow **«Sonic VPN Android APK»** → **Run workflow**
2. ~15 минут → APK в **Releases** (тег `sonicvpn-android`):
   - `SonicVPN-arm64-v8a.apk` — основной (большинство телефонов)
   - `SonicVPN-armeabi-v7a.apk` — старые устройства
   - `SonicVPN-universal.apk` — все архитектуры
3. **Стабильные ссылки** (используются на `help.html` и в боте, работают после первой сборки):
   - `https://github.com/samagon90/vpnStar/releases/latest/download/SonicVPN-arm64-v8a.apk`
   - `https://github.com/samagon90/vpnStar/releases/latest/download/SonicVPN-universal.apk`

> ⚠️ Пока workflow не активирован — ссылки на APK открывают 404. После первой сборки всё оживает.

> APK собирается с **debug-подписью** (автоматическая, без ключей): на телефон ставится
> как «неизвестный источник» — стандартная практика для VPN-сервисов РФ (Play Store нерелевантен).
> Для подписи release-ключом: сгенерировать keystore, положить в Settings → Secrets
> (APP_KEYSTORE_BASE64/PASSWORD/ALIAS) и переписать шаг сборки на `assembleRelease` как в CI v2rayNG.

## Что здесь лежит

```
android/
  icon-source.png            исходник иконки 1024×1024 (поменять файл → npm run icons → commit)
  resize-icons.js            генерация иконок во все mipmap-плотности (размеры 1:1 v2rayNG)
  package.json               tooling (sharp) — только для иконок
  branding/app/src/…         файлы-переопределения, overlay-копируются поверх исходников v2rayNG:
    res/mipmap-*/            ic_launcher / _round / _foreground / ic_banner — все плотности
    res/values/colors.xml    палитра Material3: primary #1e6fff, secondary #45b8ff
    res/values/ic_launcher_background.xml  фон адаптивной иконки
  v2rayNG/                   ⚠️ локальный клон для разработки (в .gitignore, не коммитится)
```
Текстовые правки (app_name, applicationId, versionName) применяются в workflow через `sed`
(шаг «Sonic VPN branding (имя, package, версия)») — держать их в sync при смене версии v2rayNG.

## Сменить иконку

1. Положить новый исходник 1024×1024+ как `icon-source.png`
2. `npm install && npm run icons`
3. `git add -A && git commit`
4. Запустить workflow (см. выше)

## Локальная сборка (если есть машина с Android-инструментом)

```bash
cd android
git clone --depth 1 --branch 2.2.6 --recurse-submodules --shallow-submodules \
  https://github.com/2dust/v2rayNG.git v2rayNG
cp -r branding/app/src/. v2rayNG/V2rayNG/app/src/
sed -i 's|<string name="app_name" translatable="false">v2rayNG</string>|<string name="app_name" translatable="false">Sonic VPN</string>|' \
  v2rayNG/V2rayNG/app/src/main/res/values/strings.xml
sed -i 's|applicationId = "com.v2ray.ang"|applicationId = "ru.sonicvpn.app"|' \
  v2rayNG/V2rayNG/app/build.gradle.kts
# далее — рецепт из .github/workflows/sonicvpn-android.yml (SDK 37, NDK 29, JDK 21,
# compile-hevtun.sh, libv2ray.aar из релизов AndroidLibXrayLite) и ./gradlew assembleDebug
```
