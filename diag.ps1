# Sonic VPN - diagnostics v5: DE=new Reality key pair + inbound update, RU=.env fix + E2E
# Read credentials from local sonic-creds.txt (never stored in this repo).
Import-Module Posh-SSH
$lines = Get-Content "$HOME\sonic-creds.txt"
function Get-Cred([string]$name) {
  (($lines | Where-Object { $_ -like ($name + '=*') }) | Select-Object -First 1) -replace ($name + '='), ''
}
$ruIp = Get-Cred 'RU_IP'; $ruPass = Get-Cred 'RU_PASS'
$deIp = Get-Cred 'DE_IP'; $dePass = Get-Cred 'DE_PASS'
$repo = 'if [ -d /tmp/sonic-repo ]; then git -C /tmp/sonic-repo fetch -q origin arena/01a05219-vpnstar && git -C /tmp/sonic-repo reset --hard -q origin/arena/01a05219-vpnstar; else git clone -q -b arena/01a05219-vpnstar https://github.com/samagon90/vpnStar.git /tmp/sonic-repo; fi'

Write-Host "===== [1/2] DE server: $deIp (new key pair + inbound update) =====" -ForegroundColor Cyan
$deCred = New-Object PSCredential 'root', (ConvertTo-SecureString $dePass -AsPlainText -Force)
$s1 = New-SSHSession -ComputerName $deIp -Credential $deCred -AcceptKey
$c1 = Invoke-SSHCommand -SessionId $s1.SessionId -Command "$repo; echo ---DIAG-DE---; bash /tmp/sonic-repo/deploy/diag-de.sh" -TimeOut 300
Remove-SSHSession -SessionId $s1.SessionId | Out-Null
Write-Host $c1.Output
$newPub = ''
foreach ($l in @($c1.Output)) {
  if ($l -match '^DE_FIXED:\s*([A-Za-z0-9+/=]{20,})') { $newPub = $matches[1]; break }
}
if (-not $newPub) {
  Write-Host 'DE part failed - aborting (RU not touched).' -ForegroundColor Red
  exit 1
}
Write-Host "New real public key: $newPub (len $($newPub.Length))" -ForegroundColor Yellow

Write-Host "===== [2/2] RU server: $ruIp (.env fix + restart + E2E) =====" -ForegroundColor Cyan
$ruCred = New-Object PSCredential 'root', (ConvertTo-SecureString $ruPass -AsPlainText -Force)
$s2 = New-SSHSession -ComputerName $ruIp -Credential $ruCred -AcceptKey
$ruCmd = "$repo; echo ---DIAG-RU---; bash /tmp/sonic-repo/deploy/diag-ru.sh '$newPub'"
$c2 = Invoke-SSHCommand -SessionId $s2.SessionId -Command $ruCmd -TimeOut 600
Remove-SSHSession -SessionId $s2.SessionId | Out-Null
Write-Host $c2.Output
