@echo off
chcp 65001 >nul
rem 註冊 Chrome Native Messaging host，讓插件的「啟動本機伺服器」按鈕可以執行 start-server.bat。
rem 只寫入目前使用者的登錄檔（HKCU），不需要系統管理員權限。移除請執行 uninstall-native-host.bat。
setlocal
set "NAME=com.local.manga_translator"
set "DIR=%~dp0native-host"
set "JSON=%DIR%\%NAME%.json"
powershell -NoProfile -Command "$m = [ordered]@{ name = '%NAME%'; description = 'manga-translator local server launcher'; path = (Join-Path '%DIR%' 'host.bat'); type = 'stdio'; allowed_origins = @('chrome-extension://ljcafbkmjchhgelhikfepgmeanecocle/') }; [IO.File]::WriteAllText('%JSON%', ($m | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))"
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\%NAME%" /ve /t REG_SZ /d "%JSON%" /f >nul
if errorlevel 1 (echo 註冊失敗 & pause & exit /b 1)
echo 已註冊 %NAME%
echo 若 Chrome 已開著插件，請到 chrome://extensions 按插件的重新載入。
pause
