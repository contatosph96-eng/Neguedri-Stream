@echo off
setlocal
title Iniciador NeguedriStream
cd /d "%~dp0"
where pyw.exe >nul 2>&1
if not errorlevel 1 (
  start "" pyw -3 "%~dp0Neguedri-Stream.py"
  exit /b 0
)
where py.exe >nul 2>&1
if not errorlevel 1 (
  start "Neguedri Streaming" py -3 "%~dp0Neguedri-Stream.py"
  exit /b 0
)
where pythonw.exe >nul 2>&1
if not errorlevel 1 (
  start "" pythonw "%~dp0Neguedri-Stream.py"
  exit /b 0
)
echo Python 3 nao foi encontrado. Instale Python 3 e tente novamente.
pause
