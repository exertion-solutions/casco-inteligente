# Instala en el casco el modelo de voz en espanol (Vosk, sin nube) para los comandos por voz.
# Descarga vosk-model-small-es (~40 MB) a una carpeta NUEVA, verifica tamano/MD5/zip, lo descomprime en otra carpeta
# nueva y lo copia por ADB a /sdcard/Android/data/ar.exertion.casco/files/vosk-model-es/.
# El modelo NO va al repo ni al APK. Requisitos: casco por USB con depuracion, ~120 MB libres en C: y 60 MB en el casco.
# Uso: .\instalar-modelo-voz.ps1            (descarga y copia)
#      .\instalar-modelo-voz.ps1 -Zip 'C:\ruta\vosk-model-small-es-0.42.zip'   (ya descargado: solo verifica y copia)
param(
  [string]$Adb = "$env:USERPROFILE\adb-tools\platform-tools\adb.exe",
  [string]$Modelo = 'vosk-model-small-es-0.42',
  [string]$Zip = '',
  [string]$Trabajo = (Join-Path $env:TEMP ("casco-vosk-" + (Get-Date -Format 'yyyyMMdd-HHmmss')))
)
$ErrorActionPreference = 'Stop'
$pkg = 'ar.exertion.casco'
$destino = "/sdcard/Android/data/$pkg/files/vosk-model-es"
$base = 'https://alphacephei.com/vosk/models'

if (-not (Test-Path $Adb)) { throw "No existe adb: $Adb" }
$dev = (& $Adb devices | Select-String "`tdevice$").Count
if ($dev -lt 1) { throw 'No hay casco conectado por USB (adb devices).' }

# carpeta de trabajo NUEVA y vacia (nunca se reutiliza una existente)
if (Test-Path $Trabajo) { throw "La carpeta de trabajo ya existe, usar otra: $Trabajo" }
New-Item -ItemType Directory -Path $Trabajo | Out-Null
$dl = Join-Path $Trabajo 'descarga'
$ex = Join-Path $Trabajo 'modelo'
New-Item -ItemType Directory -Path $dl, $ex | Out-Null

# 1) archivo .zip: el indicado o el descargado
$md5Esperado = $null
$tamEsperado = $null
try {
  $lista = Invoke-RestMethod "$base/model-list.json"
  $m = $lista | Where-Object { $_.name -eq $Modelo } | Select-Object -First 1
  if ($m) { $md5Esperado = $m.md5; $tamEsperado = [int64]$m.size }
} catch { Write-Warning "No se pudo leer model-list.json (se verifica solo tamano y zip): $_" }

if ($Zip) {
  if (-not (Test-Path $Zip)) { throw "No existe el zip: $Zip" }
  $archivo = (Resolve-Path $Zip).Path
} else {
  $archivo = Join-Path $dl "$Modelo.zip"
  Write-Host "Descargando $base/$Modelo.zip ..."
  Invoke-WebRequest -Uri "$base/$Modelo.zip" -OutFile $archivo
}

# 2) verificaciones: tamano razonable, MD5 (si hay lista), zip valido y con los archivos del modelo
$tam = (Get-Item $archivo).Length
Write-Host ("Tamano: {0:N1} MB" -f ($tam / 1MB))
if ($tam -lt 20MB -or $tam -gt 80MB) { throw "Tamano inesperado ($tam bytes): se esperan ~40 MB para un modelo small." }
if ($tamEsperado -and $tam -ne $tamEsperado) { throw "El tamano ($tam) no coincide con el publicado ($tamEsperado)." }
if ($md5Esperado) {
  $md5 = (Get-FileHash $archivo -Algorithm MD5).Hash.ToLower()
  if ($md5 -ne $md5Esperado.ToLower()) { throw "MD5 distinto del publicado ($md5 vs $md5Esperado)." }
  Write-Host "MD5 ok: $md5"
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::OpenRead($archivo)
try {
  $nombres = $z.Entries | ForEach-Object { $_.FullName }
  foreach ($req in 'am/final.mdl', 'graph/HCLr.fst', 'graph/Gr.fst', 'conf/model.conf') {
    if (-not ($nombres | Where-Object { $_ -like "*$req" })) { throw "El zip no es un modelo Vosk valido: falta $req" }
  }
} finally { $z.Dispose() }

# 3) descomprimir en carpeta nueva
[System.IO.Compression.ZipFile]::ExtractToDirectory($archivo, $ex)
$raiz = Get-ChildItem $ex -Directory | Select-Object -First 1
if (-not $raiz -or -not (Test-Path (Join-Path $raiz.FullName 'am\final.mdl'))) { throw 'No se encontro am\final.mdl tras descomprimir.' }

# 4) copiar al casco (reemplaza el modelo anterior) y verificar
& $Adb shell "mkdir -p /sdcard/Android/data/$pkg/files && rm -rf $destino && mkdir -p $destino"
& $Adb push "$($raiz.FullName)\." "$destino/"
$tamRemoto = (& $Adb shell "stat -c %s $destino/am/final.mdl").Trim()
$tamLocal = (Get-Item (Join-Path $raiz.FullName 'am\final.mdl')).Length
if ($tamRemoto -ne "$tamLocal") { throw "am/final.mdl en el casco mide $tamRemoto y deberia medir $tamLocal." }
Write-Host "Modelo instalado en $destino"
Write-Host "Siguiente: poner voice_commands=true en la configuracion del casco (o desde el panel) y revisar:"
Write-Host "  adb logcat -s CascoAgente   (debe aparecer 'voz: reconocimiento listo')"
Write-Host "Se puede borrar la carpeta temporal: $Trabajo"
