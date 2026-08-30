# Builds a distributable Windows installer.
#
#   powershell -ExecutionPolicy Bypass -File .\scripts\build_windows.ps1
#
# Steps: freeze the Python sidecar -> build the Flutter app -> copy the
# sidecar beside the .exe -> compile an Inno Setup installer.
#
# Must run ON Windows. Neither PyInstaller nor `flutter build windows` can
# cross-compile from macOS or Linux — there is no workaround short of a
# Windows machine, VM, or CI runner.

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$SidecarDir  = Join-Path $ProjectRoot "python_sidecar"
$VenvPython  = Join-Path $SidecarDir ".venv\Scripts\python.exe"
# Must match BINARY_NAME in windows/CMakeLists.txt.
$AppName     = "Vid2Log"
$DistDir     = Join-Path $ProjectRoot "dist"

Write-Host "==> Project: $ProjectRoot"

# ── Preflight ─────────────────────────────────────────────────────────────
if (-not (Test-Path $VenvPython)) {
    Write-Error "$VenvPython not found. Set up the sidecar venv first - see python_sidecar\README.md."
}

if (-not $env:VID2LOG_TESSERACT_DIR -and -not (Get-Command tesseract -ErrorAction SilentlyContinue)) {
    Write-Error @"
tesseract not found on PATH. It gets bundled into the app, so it must exist
at build time. Install it from https://github.com/UB-Mannheim/tesseract/wiki
and either add it to PATH or set VID2LOG_TESSERACT_DIR to its install folder
(the one containing tesseract.exe and tessdata\).
"@
}

# ── 1. Freeze the sidecar ─────────────────────────────────────────────────
# Through the venv's own python, so PyInstaller freezes THAT environment - a
# globally-installed pyinstaller would quietly produce a bundle with no
# TensorFlow in it.
Write-Host "==> Freezing the Python sidecar (this takes a few minutes)..."
Push-Location $SidecarDir
Remove-Item -Recurse -Force build, dist -ErrorAction SilentlyContinue
& $VenvPython -m PyInstaller vid2log_sidecar.spec --noconfirm
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "PyInstaller failed." }
Pop-Location

$SidecarBuild = Join-Path $SidecarDir "dist\vid2log_sidecar"
$SidecarExe   = Join-Path $SidecarBuild "vid2log_sidecar.exe"
if (-not (Test-Path $SidecarExe)) {
    Write-Error "Expected $SidecarExe after freezing."
}

# Smoke-test before it goes near the installer: a missing hidden import
# surfaces here as a readable traceback rather than as "Local engine failed
# to start" on a user's machine.
Write-Host "==> Smoke-testing the frozen sidecar..."
$proc = Start-Process -FilePath $SidecarExe -ArgumentList "--port","8799" -PassThru
$healthy = $false
foreach ($i in 1..60) {
    Start-Sleep -Seconds 1
    try {
        Invoke-WebRequest -Uri "http://127.0.0.1:8799/health" -UseBasicParsing -TimeoutSec 2 | Out-Null
        $healthy = $true
        break
    } catch { }
}
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
if (-not $healthy) {
    Write-Error "The frozen sidecar never became healthy - usually a missing hidden import in vid2log_sidecar.spec."
}
Write-Host "    sidecar responded OK"

# ── 2. Build the Flutter app ──────────────────────────────────────────────
Write-Host "==> Building the Flutter app..."
Push-Location $ProjectRoot
flutter build windows --release
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "flutter build windows failed." }
Pop-Location

$ReleaseDir = Join-Path $ProjectRoot "build\windows\x64\runner\Release"
if (-not (Test-Path $ReleaseDir)) {
    Write-Error "$ReleaseDir not found after the Flutter build."
}

# ── 3. Copy the sidecar beside the .exe ───────────────────────────────────
# Windows apps ship flat, so this sits next to vid2log.exe - which is where
# lib\services\sidecar_service.dart looks.
Write-Host "==> Copying the sidecar next to the app..."
$Target = Join-Path $ReleaseDir "vid2log_sidecar"
Remove-Item -Recurse -Force $Target -ErrorAction SilentlyContinue
Copy-Item -Recurse $SidecarBuild $Target

# ── 4. Compile the installer ──────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $DistDir | Out-Null

$IsccCandidates = @(
    "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    "C:\Program Files\Inno Setup 6\ISCC.exe"
)
$Iscc = $IsccCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Iscc) {
    $IsccCmd = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($IsccCmd) { $Iscc = $IsccCmd.Source }
}

if ($Iscc) {
    Write-Host "==> Compiling the installer with Inno Setup..."
    & $Iscc (Join-Path $ProjectRoot "scripts\installer.iss")
    if ($LASTEXITCODE -ne 0) { Write-Error "Inno Setup failed." }
    Write-Host ""
    Write-Host "Done: $DistDir\vid2log-windows-setup.exe"
} else {
    # Still leave the user with something shippable rather than nothing.
    Write-Host "==> Inno Setup not found - producing a portable .zip instead."
    Write-Host "    Install it from https://jrsoftware.org/isdl.php for a real installer."
    $Zip = Join-Path $DistDir "$AppName-windows-portable.zip"
    Remove-Item -Force $Zip -ErrorAction SilentlyContinue
    Compress-Archive -Path "$ReleaseDir\*" -DestinationPath $Zip
    Write-Host ""
    Write-Host "Done: $Zip"
}
