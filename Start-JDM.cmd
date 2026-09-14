@echo off
setlocal
title JDM - Local design studio
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-local.ps1"
if errorlevel 1 (
  echo.
  echo JDM could not start. The message above explains the next step.
  pause
  exit /b 1
)
endlocal
