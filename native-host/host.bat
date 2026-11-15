@echo off
set "PY=%~dp0..\server\.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" -I "%~dp0host.py" %*
