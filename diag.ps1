# Sonic VPN - diagnostics: read site logs + XUI env on the RU server (read-only)
# Credentials come from local sonic-creds.txt (never stored in this repo).
Import-Module Posh-SSH
$lines = Get-Content "$HOME\sonic-creds.txt"
$ip = (($lines | Where-Object { $_ -like 'RU_IP=*' }) | Select-Object -First 1) -replace 'RU_IP=', ''
$pw = (($lines | Where-Object { $_ -like 'RU_PASS=*' }) | Select-Object -First 1) -replace 'RU_PASS=', ''
if (-not $ip -or -not $pw) {
  Write-Host 'ERROR: RU_IP / RU_PASS not found in $HOME\sonic-creds.txt' -ForegroundColor Red
  exit 1
}
$sec = ConvertTo-SecureString $pw -AsPlainText -Force
$r = New-Object PSCredential 'root', $sec
Write-Host "Connecting to $ip (RU server) ..." -ForegroundColor Cyan
$cmd = 'pm2 logs sonicvpn --nostream --lines 40; echo ---ENV---; grep XUI /opt/sonicvpn/server/.env'
try {
  $s = New-SSHSession -ComputerName $ip -Credential $r -AcceptKey
  $c = Invoke-SSHCommand -SessionId $s.SessionId -Command $cmd
  $c.Output
  Remove-SSHSession -SessionId $s.SessionId | Out-Null
} catch {
  Write-Host ("SSH error: " + $_.Exception.Message) -ForegroundColor Red
}
