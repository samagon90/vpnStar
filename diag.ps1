# Sonic VPN - diagnostics v7: скрипты DE/RU грузим с Pages по SFTP (не зависят от egress серверов на GitHub); stderr виден
Import-Module Posh-SSH
$lines = Get-Content "$HOME\sonic-creds.txt"
function Get-Cred([string]$name) {
  (($lines | Where-Object { $_ -like ($name + '=*') }) | Select-Object -First 1) -replace ($name + '='), ''
}
$ruIp = Get-Cred 'RU_IP'; $ruPass = Get-Cred 'RU_PASS'
$deIp = Get-Cred 'DE_IP'; $dePass = Get-Cred 'DE_PASS'

Write-Host "=== fresh scripts from Pages ===" -ForegroundColor Cyan
iwr https://samagon90.github.io/vpnStar/deploy/diag-de.sh -OutFile "$HOME\diag-de.sh" -UseBasicParsing
iwr https://samagon90.github.io/vpnStar/deploy/diag-ru.sh -OutFile "$HOME\diag-ru.sh" -UseBasicParsing
Write-Host ("sizes: diag-de.sh={0} diag-ru.sh={1}" -f (Get-Item "$HOME\diag-de.sh").Length, (Get-Item "$HOME\diag-ru.sh").Length)

Write-Host "===== [1/2] DE server: $deIp (DNS fix in xray config template) =====" -ForegroundColor Cyan
$deCred = New-Object PSCredential 'root', (ConvertTo-SecureString $dePass -AsPlainText -Force)
$s1 = New-SSHSession -ComputerName $deIp -Credential $deCred -AcceptKey
Invoke-FileTransfer -ComputerName $deIp -Credential $deCred -SourcePath "$HOME\diag-de.sh" -DestinationPath "/tmp/diag-de.sh" -AcceptKey
$c1 = Invoke-SSHCommand -SessionId $s1.SessionId -Command "bash /tmp/diag-de.sh" -TimeOut 600
Remove-SSHSession -SessionId $s1.SessionId | Out-Null
Write-Host $c1.Output
if ($c1.Error) { Write-Host '---- DE stderr ----' -ForegroundColor Yellow; Write-Host $c1.Error }

# DE_FIXED = ключ, с которым работает xray (нужен RU-части для E2E-проверки)
$newPub = ''
foreach ($l in @($c1.Output)) {
  if ($l -match '^DE_FIXED:\s*([A-Za-z0-9+/=_-]{20,})') { $newPub = $matches[1]; break }
}
if (-not $newPub) {
  Write-Host 'DE part failed - aborting (RU not touched). Full DE output above.' -ForegroundColor Red
  exit 1
}
Write-Host "Working public key: $newPub" -ForegroundColor Yellow

Write-Host "===== [2/2] RU server: $ruIp (deploy code + E2E) =====" -ForegroundColor Cyan
$ruCred = New-Object PSCredential 'root', (ConvertTo-SecureString $ruPass -AsPlainText -Force)
$s2 = New-SSHSession -ComputerName $ruIp -Credential $ruCred -AcceptKey
Invoke-FileTransfer -ComputerName $ruIp -Credential $ruCred -SourcePath "$HOME\diag-ru.sh" -DestinationPath "/tmp/diag-ru.sh" -AcceptKey
$ruCmd = "echo ---DIAG-RU---; bash /tmp/diag-ru.sh '$newPub'"
$c2 = Invoke-SSHCommand -SessionId $s2.SessionId -Command $ruCmd -TimeOut 600
Remove-SSHSession -SessionId $s2.SessionId | Out-Null
Write-Host $c2.Output
if ($c2.Error) { Write-Host '---- RU stderr ----' -ForegroundColor Yellow; Write-Host $c2.Error }
