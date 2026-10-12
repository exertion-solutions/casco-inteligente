# Uso: .\test-cors.ps1 -Dominio live.ejemplo.com [-Origen https://exertion-solutions.github.io]
param([Parameter(Mandatory)][string]$Dominio, [string]$Origen = "https://exertion-solutions.github.io")
$h = & curl.exe -sS -o NUL -D - -X OPTIONS "https://$Dominio/live/test/whep" `
  -H "Origin: $Origen" -H "Access-Control-Request-Method: POST" `
  -H "Access-Control-Request-Headers: authorization,content-type"
if ($LASTEXITCODE -ne 0) { Write-Host "FALLO: no conecta con $Dominio"; exit 1 }
$h | Select-Object -First 1
$script:fail = 0
function Chk($n, $v) {
  if (($h -join "`n") -match "(?im)^${n}:.*${v}") { Write-Host "OK    $n ~ $v" }
  else { Write-Host "FALLA $n (esperado: $v)"; $script:fail = 1 }
}
Chk "access-control-allow-origin" ([regex]::Escape($Origen))
Chk "access-control-allow-methods" "POST"
Chk "access-control-allow-methods" "PATCH"
Chk "access-control-allow-methods" "DELETE"
Chk "access-control-allow-headers" "authorization"
Chk "access-control-allow-headers" "content-type"
if (($h | Select-Object -First 1) -notmatch " 204") { Write-Host "FALLA estado (esperado 204)"; $script:fail = 1 }
if ($script:fail -eq 0) { "TODO OK" } else { "HAY FALLAS" }
exit $script:fail
