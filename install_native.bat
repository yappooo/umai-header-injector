@echo off
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

echo.
echo  UMAI OTP Helper - Native Messaging Setup
echo  ==========================================
echo.
echo  Step 1: Open Chrome, go to chrome://extensions
echo  Step 2: Enable Developer Mode (top-right toggle)
echo  Step 3: Find the UMAI Header Injector card
echo  Step 4: Copy the ID shown below the extension name (32 characters)
echo.
set /p EXT_ID="  Paste extension ID here: "

if "%EXT_ID%"=="" (
    echo  ERROR: No ID entered. Run this script again.
    pause
    exit /b 1
)

set "BAT_PATH=%SCRIPT_DIR%\otp_helper.bat"
set "MANIFEST_PATH=%SCRIPT_DIR%\com.umai.otp_helper.json"

rem Double backslashes for JSON
set "BAT_PATH_JSON=%BAT_PATH:\=\\%"
set "MANIFEST_PATH_ESC=%MANIFEST_PATH:\=\\%"

echo  Writing native messaging manifest...
(
echo {
echo   "name": "com.umai.otp_helper",
echo   "description": "UMAI OTP IMAP reader",
echo   "path": "%BAT_PATH_JSON%",
echo   "type": "stdio",
echo   "allowed_origins": ["chrome-extension://%EXT_ID%/"]
echo }
) > "%MANIFEST_PATH%"

echo  Registering in Windows registry...
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.umai.otp_helper" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f

echo.
echo  Done!
echo  - Reload the extension in chrome://extensions (refresh icon on the card)
echo  - Fill IMAP password in Configure hunt... options page
echo.
pause
