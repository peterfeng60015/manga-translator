@echo off
chcp 65001 >nul
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.local.manga_translator" /f >nul 2>&1
del "%~dp0native-host\com.local.manga_translator.json" 2>nul
echo 已移除註冊
pause
