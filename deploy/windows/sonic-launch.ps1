# Sonic VPN - one-click launch (both servers)
# Credentials: sonic-creds.txt next to this file (6 lines: DE_IP, DE_PASS, DE_XUI_USER, DE_XUI_PASS, RU_IP, RU_PASS).
# No passwords are stored in this file (the repo is public).
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$credFile = Join-Path $dir 'sonic-creds.txt'

Write-Host '============================================================'
Write-Host '  Sonic VPN - ONE-CLICK LAUNCH (both servers)'
Write-Host '============================================================'

if (-not (Test-Path $credFile)) {
  Write-Host ''
  Write-Host 'ERROR: file sonic-creds.txt is not next to this script.' -ForegroundColor Red
  Write-Host 'Run the PowerShell one-liner from the instructions again (it creates it).' -ForegroundColor Red
  exit 1
}
$c = @{}
foreach ($line in (Get-Content $credFile)) {
  if ($line -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $c[$matches[1]] = $matches[2].Trim() }
}
$deIp = $c['DE_IP']; $dePass = $c['DE_PASS']; $xuiUser = $c['DE_XUI_USER']; $xuiPass = $c['DE_XUI_PASS']
$ruIp = $c['RU_IP']; $ruPass = $c['RU_PASS']
if (-not $deIp -or -not $dePass -or -not $xuiUser -or -not $xuiPass -or -not $ruIp -or -not $ruPass) {
  Write-Host 'ERROR: sonic-creds.txt is incomplete (need DE_IP, DE_PASS, DE_XUI_USER, DE_XUI_PASS, RU_IP, RU_PASS).' -ForegroundColor Red
  exit 1
}

# --- Posh-SSH module (installed once, ~1 minute) ---
Import-Module Posh-SSH -ErrorAction SilentlyContinue
if (-not (Get-Module -Name Posh-SSH -ErrorAction SilentlyContinue)) {
  Write-Host ''
  Write-Host 'First run: installing Posh-SSH module (~1 minute) ...'
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    try { Install-PackageProvider -Name NuGet -Force | Out-Null } catch { }
    try { Set-PSRepository -Name PSGallery -InstallationPolicy Trusted } catch { }
    try { Register-PSRepository -DefaultInstallation } catch { }
    Install-Module -Name Posh-SSH -Force -Scope CurrentUser
    Import-Module Posh-SSH
  } catch {
    Write-Host 'ERROR: could not install Posh-SSH module.' -ForegroundColor Red
    Write-Host "Details: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Tell me so we switch to plan B (SSH keys, one manual password entry).'
    exit 1
  }
}

function New-RootCred([string]$pass) {
  New-Object System.Management.Automation.PSCredential('root', (ConvertTo-SecureString $pass -AsPlainText -Force))
}
function Invoke-Server([string]$ip, [string]$pass, [string]$cmd, [string]$logFile) {
  Write-Host ''
  Write-Host "Connecting to $ip ..."
  $s = $null
  try {
    $s = New-SSHSession -ComputerName $ip -Credential (New-RootCred $pass) -AcceptKey -ConnectionTimeout 45
  } catch {
    Write-Host "ERROR: cannot connect to $ip" -ForegroundColor Red
    Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
    Write-Host '  If it is a timeout - the server guard (fail2ban) blocked your IP after'
    Write-Host '  wrong passwords. Wait 15-30 minutes and double-click again, or in the'
    Write-Host '  hosting panel open the WEB CONSOLE and run:  fail2ban-client stop'
    return $null
  }
  Write-Host 'Connected. Working (several minutes, do not close) ...'
  $r = Invoke-SSHCommand -SessionId $s.SessionId -Command $cmd -TimeOut 1800
  Remove-SSHSession -SessionId $s.SessionId | Out-Null
  $out = @($r.Output) + @($r.Error)
  [System.IO.File]::WriteAllLines($logFile, $out)
  return ($out -join "`n")
}

$rawBase = 'https://raw.githubusercontent.com/samagon90/vpnStar/arena/01a05219-vpnstar/deploy/'

# --- [1/2] Germany: 3x-ui ---
Write-Host ''
Write-Host '[1/2] German server: setting up 3x-ui ...'
$deCmd = "curl -fsSL -o /root/xui-setup.sh ${rawBase}xui-setup.sh && bash /root/xui-setup.sh $xuiUser $xuiPass $ruIp"
$deOut = Invoke-Server $deIp $dePass $deCmd "$env:TEMP\sonic-de.log"
if ($null -eq $deOut) { exit 1 }
if ($deOut -notmatch '__SONIC_XUI_OK__') {
  Write-Host ''
  Write-Host 'X German server: NOT finished. Log opened in Notepad - send me the last 15 lines.' -ForegroundColor Red
  notepad "$env:TEMP\sonic-de.log"
  exit 1
}
Write-Host '  OK: VPN server created. Extracting Public Key ...'
if ($deOut -notmatch 'Public Key:\s*(\S+)') {
  Write-Host 'X Public Key not found in the log.' -ForegroundColor Red
  notepad "$env:TEMP\sonic-de.log"
  exit 1
}
$pubKey = $matches[1]

# --- [2/2] Russia: site ---
Write-Host ''
Write-Host '[2/2] Russian server: installing the site (code, database, admin) ...'
$ruCmd = "curl -fsSL -o /root/app-setup.sh ${rawBase}app-setup.sh && bash /root/app-setup.sh $xuiUser $xuiPass $pubKey"
$ruOut = Invoke-Server $ruIp $ruPass $ruCmd "$env:TEMP\sonic-ru.log"
if ($null -eq $ruOut) { exit 1 }
if ($ruOut -notmatch '__SONIC_SITE_OK__') {
  Write-Host ''
  Write-Host 'X Russian server: NOT finished. Log opened in Notepad - send me the last 15 lines.' -ForegroundColor Red
  notepad "$env:TEMP\sonic-ru.log"
  exit 1
}

Write-Host ''
Write-Host '============================================================'
Write-Host '  DONE! Your site is live. Open in your browser:'
Write-Host ''
Write-Host "    http://$ruIp/"
Write-Host ''
Write-Host '  The admin panel token is in the log (Notepad is opening).'
Write-Host '============================================================'
notepad "$env:TEMP\sonic-ru.log"
