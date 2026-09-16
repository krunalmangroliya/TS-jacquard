@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -Command "try { $page = Invoke-WebRequest 'http://127.0.0.1:4328' -UseBasicParsing -TimeoutSec 2; if ($page.Content -match '<title>Loom Clean') { if ($page.Content -match '/@vite/client') { exit 2 }; exit 0 } } catch {} exit 1" >nul 2>nul
if errorlevel 2 (
  echo The development server is using port 4328. Close its terminal, then run this launcher again.
  pause
  exit /b 1
)
if not errorlevel 1 (
  start "" "http://127.0.0.1:4328"
  exit /b 0
)
set "LOOM_NODE=node"
where node >nul 2>nul
if errorlevel 1 set "LOOM_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not "%LOOM_NODE%"=="node" if not exist "%LOOM_NODE%" (
    echo Install Node.js 22.12 or later to start Loom Clean.
    pause
    exit /b 1
)
if exist "node_modules\vite\bin\vite.js" (
  set "LOOM_VITE=node_modules\vite\bin\vite.js"
) else if exist "..\node_modules\vite\bin\vite.js" (
  set "LOOM_VITE=..\node_modules\vite\bin\vite.js"
) else (
  echo Run npm install inside this folder once, then try again.
  pause
  exit /b 1
)
echo Preparing Loom Clean for this device...
"%LOOM_NODE%" "%LOOM_VITE%" build --configLoader runner
if errorlevel 1 (
  echo Loom Clean could not build. See the error above.
  pause
  exit /b 1
)
echo Starting Loom Clean at http://127.0.0.1:4328
"%LOOM_NODE%" "%LOOM_VITE%" preview --configLoader runner --host 127.0.0.1 --port 4328 --strictPort --open
if errorlevel 1 (
  echo.
  echo Loom Clean could not start. See the error above.
  echo If port 4328 is occupied by another app, close that app and try again.
  pause
  exit /b 1
)
