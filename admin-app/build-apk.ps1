# Builds the SEM Admin APK (Trusted Web Activity for web-remote/admin.html).
# Run from this folder in PowerShell:   .\build-apk.ps1
#
# Uses the JDK 17 and Android SDK in ~/.bubblewrap (see README, "Aplikasi
# admin"). Steps that need you, not a script:
#   - the first run asks you to accept the Android SDK licenses (type y);
#   - without admin-release.keystore it creates one and asks for a new password;
#   - every build asks for that password to sign the APK.
# Back up admin-release.keystore: an installed app only accepts updates signed
# with the same key.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$Bubblewrap = Join-Path $HOME '.bubblewrap'
$Jdk = Get-ChildItem (Join-Path $Bubblewrap 'jdk') -Directory | Select-Object -First 1
if (-not $Jdk) { throw 'JDK 17 tidak ditemukan di ~/.bubblewrap/jdk.' }
$env:JAVA_HOME = $Jdk.FullName
$Sdk = Join-Path $Bubblewrap 'android_sdk'
$env:ANDROID_HOME = $Sdk

if (-not (Test-Path (Join-Path $Sdk 'licenses\android-sdk-license'))) {
    Write-Host "`n== Lisensi Android SDK: baca lalu ketik y untuk setiap lisensi" -ForegroundColor Cyan
    & (Join-Path $Sdk 'bin\sdkmanager.bat') --licenses "--sdk_root=$Sdk"
    if (-not (Test-Path (Join-Path $Sdk 'licenses\android-sdk-license'))) { throw 'Lisensi belum disetujui, build dibatalkan.' }
}

if (-not (Test-Path 'admin-release.keystore')) {
    Write-Host "`n== Membuat kunci tanda tangan APK. Ketik password baru (min. 6 karakter) dan simpan baik-baik." -ForegroundColor Cyan
    & (Join-Path $env:JAVA_HOME 'bin\keytool.exe') -genkeypair -keystore admin-release.keystore -alias sem-admin `
        -keyalg RSA -keysize 2048 -validity 10000 -dname 'CN=SEM Admin, O=Smart Energy Meter, C=ID'
    if ($LASTEXITCODE -ne 0) { throw 'Kunci gagal dibuat.' }
}

# Gradle and apksigner directly: `bubblewrap build` cannot start gradlew.bat
# from PowerShell. After changing twa-manifest.json, run `npx bubblewrap update`
# first to regenerate the Android project.
$env:PATH = "$(Join-Path $env:JAVA_HOME 'bin');$env:PATH"
$BuildTools = Get-ChildItem (Join-Path $Sdk 'build-tools') -Directory | Sort-Object Name | Select-Object -Last 1

Write-Host "`n== Build APK" -ForegroundColor Cyan
& .\gradlew.bat assembleRelease
if ($LASTEXITCODE -ne 0) { throw 'Build gagal, lihat pesan di atas.' }

$Unsigned = 'app\build\outputs\apk\release\app-release-unsigned.apk'
& (Join-Path $BuildTools.FullName 'zipalign.exe') -f -p 4 $Unsigned app-release-aligned.apk
if ($LASTEXITCODE -ne 0) { throw 'zipalign gagal.' }

Write-Host "`n== Tanda tangan APK. Ketik password kunci saat diminta." -ForegroundColor Cyan
& (Join-Path $BuildTools.FullName 'apksigner.bat') sign --ks admin-release.keystore --ks-key-alias sem-admin --out app-release-signed.apk app-release-aligned.apk
if ($LASTEXITCODE -ne 0) { throw 'Tanda tangan gagal (password salah?).' }
Remove-Item app-release-aligned.apk

Write-Host "`n== Sidik jari sertifikat (untuk web-remote/.well-known/assetlinks.json). Ketik password kunci sekali lagi:" -ForegroundColor Cyan
& (Join-Path $env:JAVA_HOME 'bin\keytool.exe') -list -v -keystore admin-release.keystore -alias sem-admin | Select-String 'SHA256:'
Write-Host "`nSelesai: app-release-signed.apk" -ForegroundColor Green
