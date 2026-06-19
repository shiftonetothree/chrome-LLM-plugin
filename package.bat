@echo off
setlocal enabledelayedexpansion

set "EXTNAME=ai-browser-assistant"
set "VERSION=1.0.0"
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

:: Zip the package folder (contents will be under ai-browser-assistant-1.0.0/...)
powershell -NoProfile -Command "Compress-Archive -Path '%PKGDIR%' -DestinationPath '%OUT%' -Force"

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
