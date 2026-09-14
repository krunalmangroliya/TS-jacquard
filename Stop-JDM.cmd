@echo off
setlocal
title JDM - Stop local studio
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-local.ps1"
if errorlevel 1 (
  echo.
  echo The stop shortcut could not finish. The message above explains the next step.
  pause
  exit /b 1
)
endlocal
