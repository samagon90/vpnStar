# Sonic VPN - diagnostic (both servers). Result opens in Notepad.
# Credentials: sonic-creds.txt next to this file.
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$credFile = Join-Path $dir 'sonic-creds.txt'

Write-Host '============================================================'
Write-Host '  Sonic VPN - DIAGNOSTIC (both servers)'
Write-Host '============================================================'

if (-not (Test-Path $credFile)) {
  Write-Host 'ERROR: file sonic-creds.txt is not next to this script.' -ForegroundColor Red
  exit 1
}
$c = @{}
foreach ($line in (Get-Content $credFile)) {
  if ($line -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $c[$matches[1]] = $matches[2].Trim() }
}

Import-Module Posh-SSH -ErrorAction SilentlyContinue
if (-not (Get-Module -Name Posh-SSH -ErrorAction SilentlyContinue)) {
  Write-Host 'First run: installing Posh-SSH module (~1 minute) ...'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Install-PackageProvider -Name NuGet -Force -Confirm:$false -Scope CurrentUser -ErrorAction SilentlyContinue | Out-Null
  if (-not (Get-PSRepository -ListAvailable | Where-Object { $_.Name -eq 'PSGallery' })) { Register-PSRepository -DefaultInstallation }
  Install-Module -Name Posh-SSH -Force -Scope CurrentUser -AllowClobber -Confirm:$false
  Import-Module Posh-SSH
}

$log = "$env:TEMP\sonic-doctor.log"
$all = @()
$all += "=== DIAGNOSTIC: $(Get-Date) ==="
$all += ''

foreach ($side in @(@('DE', $c['DE_IP'], $c['DE_PASS'], 'echo ''-- 3x-ui settings --''; x-ui settings 2>/dev/null | head -20; echo; echo ''-- firewall --''; ufw status 2>/dev/null | head -12'), @('RU', $c['RU_IP'], $c['RU_PASS'], "echo '-- health --'; curl -s --max-time 5 http://127.0.0.1:3000/api/health; echo; echo '-- pm2 --'; pm2 list 2>/dev/null | head -8; echo; echo '-- recent logs --'; pm2 logs sonicvpn --nostream --lines 15 2>/dev/null"))) {
  $name = $side[0]; $ip = $side[1]; $pass = $side[2]; $cmd = $side[3]
  $all += "---- $name server ($ip) ----"
  try {
    $s = New-SSHSession -ComputerName $ip -Credential (New-Object System.Management.Automation.PSCredential('root', (ConvertTo-SecureString $pass -AsPlainText -Force))) -AcceptKey -ConnectionTimeout 45
    $r = Invoke-SSHCommand -SessionId $s.SessionId -Command $cmd -TimeOut 120
    Remove-SSHSession -SessionId $s.SessionId | Out-Null
    $all += @($r.Output) + @($r.Error)
  } catch {
    $all += "CONNECT FAILED: $($_.Exception.Message)"
    $all += '(if timeout - the guard fail2ban blocked your IP; wait 15-30 min, or in the hosting panel WEB CONSOLE run: fail2ban-client stop)'
  }
  $all += ''
}
[System.IO.File]::WriteAllLines($log, $all)
Write-Host ''
Write-Host 'Done - the result opens in Notepad now. Send me that text if something is broken.'
notepad $log
