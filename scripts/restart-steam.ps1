# Restart Steam with CDP debugging on localhost:8080.
#
# Millennium v3.6.3 deletes <Steam>\.cef-enable-remote-debugging on every start
# (its health check treats it as a deprecated file), but Steam has already read
# it by then. So the flag must be recreated before each start.
#
#   powershell -File scripts/restart-steam.ps1

$steam = (Get-ItemProperty HKCU:\Software\Valve\Steam).SteamPath -replace '/', '\'
$flag = Join-Path $steam '.cef-enable-remote-debugging'

if (Get-Process steam -ErrorAction SilentlyContinue) {
    & (Join-Path $steam 'steam.exe') -shutdown
    $t = 0
    while ((Get-Process steam -ErrorAction SilentlyContinue) -and $t -lt 60) { Start-Sleep 2; $t += 2 }
}

New-Item -ItemType File -Path $flag -Force | Out-Null
Start-Process (Join-Path $steam 'steam.exe')

$t = 0
do {
    Start-Sleep 3; $t += 3
    $ok = $false
    try { $ok = (Invoke-WebRequest http://127.0.0.1:8080/json -UseBasicParsing -TimeoutSec 2).Content -match 'SharedJSContext' } catch {}
} while (-not $ok -and $t -lt 120)

if ($ok) { "CDP ready after $t s" } else { "CDP not reachable after $t s"; exit 1 }
