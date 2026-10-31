# Builds the Smart Energy Meter customer APK (Trusted Web Activity for
# web-remote/index.html). Run from this folder in PowerShell:   .\build-apk.ps1
#
# Same toolchain as admin-app (JDK 17 and Android SDK in ~/.bubblewrap) and the
# same signing key, admin-app/admin-release.keystore: run admin-app's
# build-apk.ps1 once first if that key does not exist yet. The build asks for
# its password. Back the key up: an installed app only accepts updates signed
# with the same key.
#
# After changing twa-manifest.json, run `npx bubblewrap update` first to
# regenerate the Android project. `bubblewrap build` itself cannot start
# gradlew.bat from PowerShell, hence Gradle and apksigner directly.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$Keystore = '..\admin-app\admin-release.keystore'
if (-not (Test-Path $Keystore)) { throw 'Kunci admin-app\admin-release.keystore tidak ada. Jalankan admin-app\build-apk.ps1 dulu.' }

$Bubblewrap = Join-Path $HOME '.bubblewrap'
$Jdk = Get-ChildItem (Join-Path $Bubblewrap 'jdk') -Directory | Select-Object -First 1
if (-not $Jdk) { throw 'JDK 17 tidak ditemukan di ~/.bubblewrap/jdk.' }
$env:JAVA_HOME = $Jdk.FullName
$Sdk = Join-Path $Bubblewrap 'android_sdk'
$env:ANDROID_HOME = $Sdk
$env:PATH = "$(Join-Path $env:JAVA_HOME 'bin');$env:PATH"
$BuildTools = Get-ChildItem (Join-Path $Sdk 'build-tools') -Directory | Sort-Object Name | Select-Object -Last 1

Write-Host "`n== Build APK" -ForegroundColor Cyan
& .\gradlew.bat assembleRelease
if ($LASTEXITCODE -ne 0) { throw 'Build gagal, lihat pesan di atas.' }

$Unsigned = 'app\build\outputs\apk\release\app-release-unsigned.apk'
& (Join-Path $BuildTools.FullName 'zipalign.exe') -f -p 4 $Unsigned app-release-aligned.apk
if ($LASTEXITCODE -ne 0) { throw 'zipalign gagal.' }

Write-Host "`n== Tanda tangan APK. Ketik password kunci saat diminta." -ForegroundColor Cyan
& (Join-Path $BuildTools.FullName 'apksigner.bat') sign --ks $Keystore --ks-key-alias sem-admin --out app-release-signed.apk app-release-aligned.apk
if ($LASTEXITCODE -ne 0) { throw 'Tanda tangan gagal (password salah?).' }
Remove-Item app-release-aligned.apk

Write-Host "`nSelesai: app-release-signed.apk" -ForegroundColor Green
