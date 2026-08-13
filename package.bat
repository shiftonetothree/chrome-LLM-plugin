@echo off
setlocal enabledelayedexpansion

set "EXTNAME=ai-browser-assistant"

:: Read version from manifest.json
for /f "delims=" %%a in ('powershell -Command "(Get-Content manifest.json -Raw | ConvertFrom-Json).version"') do set "VERSION=%%a"
set "OUT=%EXTNAME%-%VERSION%.zip"
set "PKGDIR=%EXTNAME%-%VERSION%"

:: Remove old artifacts
if exist "%OUT%" del /f /q "%OUT%"
if exist "%PKGDIR%" rd /s /q "%PKGDIR%"

:: Create package folder at project root
mkdir "%PKGDIR%"

:: Copy all project files into the package folder
for %%F in (manifest.json popup.html sidepanel.html background.js content.js marked.min.js popup.js) do (
    copy /y "%%F" "%PKGDIR%\%%F" >nul
)
xcopy /y /e icons "%PKGDIR%\icons\" >nul

:: Zip the package contents with standard forward-slash paths and manifest.json
:: at the archive root. Windows PowerShell 5.1's Compress-Archive writes
:: backslash separators (e.g. pkg\manifest.json), which violates the ZIP spec
:: and is rejected by Firefox/AMO, so we use System.IO.Compression directly.
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem; $src=(Resolve-Path '%PKGDIR%').Path; $dst=Join-Path (Get-Location) '%OUT%'; if(Test-Path $dst){Remove-Item $dst -Force}; $zip=[System.IO.Compression.ZipFile]::Open($dst,[System.IO.Compression.ZipArchiveMode]::Create); try { Get-ChildItem -LiteralPath $src -Recurse -File | ForEach-Object { $rel=$_.FullName.Substring($src.Length).TrimStart('\','/').Replace('\','/'); $entry=$zip.CreateEntry($rel,[System.IO.Compression.CompressionLevel]::Optimal); $es=$entry.Open(); try { $fs=[System.IO.File]::OpenRead($_.FullName); try { $fs.CopyTo($es) } finally { $fs.Dispose() } } finally { $es.Dispose() } } } finally { $zip.Dispose() }"

:: Clean up package folder
rd /s /q "%PKGDIR%"

echo.
if exist "%OUT%" (
    echo Packed: %OUT%
    for %%A in ("%OUT%") do echo Size: %%~zA bytes
) else (
    echo ERROR: packaging failed
    exit /b 1
)
