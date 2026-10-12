# Instala el APK del agente en el casco, copia config.json y habilita el servicio de accesibilidad.
# Requisitos: casco por USB con depuracion activa, APK compilado y config.json local (NO versionado).
# Uso: .\instalar-agente.ps1 -Config 'C:\CASCO INTELIGENTE\config.local.json'
param(
  [string]$Adb = "$env:USERPROFILE\adb-tools\platform-tools\adb.exe",
  [string]$Apk = "$PSScriptRoot\..\android\app\build\outputs\apk\debug\app-debug.apk",
  [Parameter(Mandatory)][string]$Config
)
$ErrorActionPreference = 'Stop'
$pkg = 'ar.exertion.casco'
$svc = "$pkg/$pkg.SosKeyService"

if (-not (Test-Path $Apk))    { throw "No existe el APK: $Apk (compilar primero, ver README)" }
if (-not (Test-Path $Config)) { throw "No existe config: $Config" }

& $Adb install -r $Apk
& $Adb shell pm grant $pkg android.permission.READ_EXTERNAL_STORAGE
& $Adb shell "mkdir -p /sdcard/Android/data/$pkg/files"
& $Adb push $Config "/sdcard/Android/data/$pkg/files/config.json"
# Habilitar accesibilidad (deteccion de SOS)
$cur = (& $Adb shell settings get secure enabled_accessibility_services).Trim()
if ($cur -notlike "*$svc*") {
  $new = if ($cur -and $cur -ne 'null') { "$cur`:$svc" } else { $svc }
  & $Adb shell settings put secure enabled_accessibility_services $new
}
& $Adb shell settings put secure accessibility_enabled 1
# Excluir del ahorro de bateria
& $Adb shell dumpsys deviceidle whitelist +$pkg
& $Adb shell am startservice -n "$pkg/.MediaWatcherService"
Write-Host "Listo. Ver logs: adb logcat -s CascoAgente"
