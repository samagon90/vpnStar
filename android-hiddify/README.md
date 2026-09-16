# Sonic VPN — новое Android-приложение (Hiddify)

Старый Sonic VPN (v2rayNG-ребрендинг) остаётся как запасной. Новое приложение —
ребрендинг **Hiddify v4.1.1** (Flutter, GPL): интерфейс уровня Happ, автовыбор
точки, подписки из коробки. Работает с нашими `/api/sub/v2ray` и `/api/sub/singbox`.

| | |
|---|---|
| Имя | **Sonic VPN** |
| Package | `ru.sonicvpn.app` — ТОТ ЖЕ, что у старого: новый APK встаёт поверх, профили сохраняются |
| База | `github.com/hiddify/hiddify-app`, пин `v4.1.1`, core `4.1.0` (предсобран, качается) |
| Лицензия | GPL (наследуется; LICENSE Hiddify сохраняется) |

## Сборка

Всё делает Actions: вкладка **Actions → Sonic VPN Hiddify APK → Run workflow**
(~25–40 минут, Flutter тяжёлый) → APK в Release **`sonicvpn-hiddify`**:
- `SonicHiddify-arm64-v8a.apk` — большинству
- `SonicHiddify-universal.apk` — всем (крупнее)

Стабильные ссылки (для `help.html` после первой зелёной сборки):
- `https://github.com/samagon90/vpnStar/releases/latest/download/...` — ВНИМАНИЕ:
  `latest` указывает на последний релиз ВООБЩЕ (сейчас это sonicvpn-android!),
  поэтому для Hiddify даём прямые ссылки на тег:
- `https://github.com/samagon90/vpnStar/releases/download/sonicvpn-hiddify/SonicHiddify-arm64-v8a.apk`
- `https://github.com/samagon90/vpnStar/releases/download/sonicvpn-hiddify/SonicHiddify-universal.apk`

## Что правит `branding.sh`

1. `applicationId`/`namespace` → `ru.sonicvpn.app`, имя → «Sonic VPN».
2. Иконки `ic_launcher*` из `assets/mipmap` поверх.
3. Проверка обновлений → наши релизы (`samagon90/vpnStar`), а не Hiddify.
4. Сборка с пустым `sentry_dsn` (телеметрия Hiddify отключена).

Файлы `lib/` Hiddify НЕ правим руками (только sed по URL) — иначе рассинхрон с апстримом.
Обновление версии базы: поменять `HIDDIFY_TAG` в workflow + проверить сборку.
