# Sonic VPN - diagnostics v4 (RU server): update code, real key from panel, fix .env, E2E
# Read credentials from local sonic-creds.txt (never stored in this repo).
Import-Module Posh-SSH
$lines = Get-Content "$HOME\sonic-creds.txt"
function Get-Cred([string]$name) {
  (($lines | Where-Object { $_ -like ($name + '=*') }) | Select-Object -First 1) -replace ($name + '='), ''
}
$ruIp = Get-Cred 'RU_IP'; $ruPass = Get-Cred 'RU_PASS'

Write-Host "===== RU server: $ruIp (update + real key + fix + E2E) =====" -ForegroundColor Cyan
$repo = 'if [ -d /tmp/sonic-repo ]; then git -C /tmp/sonic-repo fetch -q origin arena/01a05219-vpnstar && git -C /tmp/sonic-repo reset --hard -q origin/arena/01a05219-vpnstar; else git clone -q -b arena/01a05219-vpnstar https://github.com/samagon90/vpnStar.git /tmp/sonic-repo; fi'
$ruCred = New-Object PSCredential 'root', (ConvertTo-SecureString $ruPass -AsPlainText -Force)
$s2 = New-SSHSession -ComputerName $ruIp -Credential $ruCred -AcceptKey
$c2 = Invoke-SSHCommand -SessionId $s2.SessionId -Command "$repo; bash /tmp/sonic-repo/deploy/diag-ru.sh" -TimeOut 600
Remove-SSHSession -SessionId $s2.SessionId | Out-Null
Write-Host $c2.Output
