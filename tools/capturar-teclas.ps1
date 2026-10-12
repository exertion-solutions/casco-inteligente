# Captura eventos de teclas del casco por ADB y los imprime. Ctrl+C para salir.
# Uso: .\capturar-teclas.ps1 [-Adb 'C:\ruta\adb.exe']
param([string]$Adb = "$env:USERPROFILE\adb-tools\platform-tools\adb.exe")

if (-not (Test-Path $Adb)) { Write-Error "No se encuentra adb en $Adb"; exit 1 }
& $Adb devices
& $Adb shell getevent -lt | Select-String -Pattern 'EV_KEY'
