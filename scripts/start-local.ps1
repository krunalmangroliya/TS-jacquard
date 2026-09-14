[CmdletBinding()]
param([switch]$NoBrowser)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$appUrl = 'http://127.0.0.1:4317'
$serverEntry = Join-Path $projectRoot 'apps\server\dist\main.mjs'
$workerEntry = Join-Path $projectRoot 'apps\server\dist\export-worker.mjs'
$webEntry = Join-Path $projectRoot 'apps\web\dist\index.html'
$runtimeRoot = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies'

function Read-LocalJson([string]$Address) {
  $request = [System.Net.HttpWebRequest]::Create($Address)
  $request.Proxy = $null
  $request.Timeout = 1500
  $request.ReadWriteTimeout = 1500
  $request.AllowAutoRedirect = $false
  $response = $null
  $reader = $null
  try {
    $response = $request.GetResponse()
    if ([int]$response.StatusCode -ne 200) { return $null }
    $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
    return ($reader.ReadToEnd() | ConvertFrom-Json)
  } catch { return $null }
  finally {
    if ($null -ne $reader) { $reader.Dispose() }
    if ($null -ne $response) { $response.Dispose() }
  }
}

function Test-JdmServer {
  $health = Read-LocalJson "$appUrl/api/health"
  if ($null -eq $health -or $health.PSObject.Properties.Name -notcontains 'ok' -or $health.ok -ne $true) { return $false }
  if ($health.PSObject.Properties.Name -contains 'application') { return $health.application -eq 'JDM' }
  # Compatibility with the first local build, before the application identity
  # field was added. A second JDM-specific endpoint verifies that old server.
  if ($health.PSObject.Properties.Name -notcontains 'storage' -or $health.storage -ne 'local') { return $false }
  $settings = Read-LocalJson "$appUrl/api/workspace"
  return $null -ne $settings -and $settings.PSObject.Properties.Name -contains 'profiles' -and $settings.PSObject.Properties.Name -contains 'defaultPalette' -and $settings.PSObject.Properties.Name -contains 'defaultProfileId'
}

function Open-Jdm {
  Write-Host "JDM is ready: $appUrl" -ForegroundColor Green
  if (-not $NoBrowser) { Start-Process -FilePath $appUrl | Out-Null }
}

function Test-PortOccupied {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $connection = $client.ConnectAsync('127.0.0.1', 4317)
    if (-not $connection.Wait(800)) { return $false }
    return $client.Connected
  } catch { return $false }
  finally { $client.Dispose() }
}

function Find-Executable([string[]]$Names, [string[]]$Fallbacks) {
  foreach ($name in $Names) {
    $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command) { return $command.Source }
  }
  foreach ($candidate in $Fallbacks) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
  }
  return $null
}

function Test-BuildNeeded {
  $artifacts = @($serverEntry, $workerEntry, $webEntry)
  foreach ($file in $artifacts) { if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $true } }
  $oldestBuild = ($artifacts | ForEach-Object { (Get-Item -LiteralPath $_).LastWriteTimeUtc } | Sort-Object | Select-Object -First 1)
  $inputFiles = @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'scripts\build.ts', 'apps\web\index.html', 'apps\web\vite.config.ts', 'apps\web\package.json')
  foreach ($relative in $inputFiles) {
    $file = Join-Path $projectRoot $relative
    if ((Test-Path -LiteralPath $file -PathType Leaf) -and (Get-Item -LiteralPath $file).LastWriteTimeUtc -gt $oldestBuild) { return $true }
  }
  foreach ($relative in @('apps\server\src', 'apps\web\src', 'apps\web\public', 'packages\core\src', 'packages\app-model\src')) {
    $folder = Join-Path $projectRoot $relative
    if (-not (Test-Path -LiteralPath $folder -PathType Container)) { continue }
    foreach ($file in Get-ChildItem -LiteralPath $folder -Recurse -File) {
      if ($file.Name -match '\.test\.[cm]?[jt]sx?$') { continue }
      if ($file.LastWriteTimeUtc -gt $oldestBuild) { return $true }
    }
  }
  return $false
}

$launchMutex = $null
$ownsMutex = $false
$pushedLocation = $false
try {
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'package.json') -PathType Leaf)) { throw 'Keep Start-JDM.cmd and the scripts folder inside the JDM project folder.' }
  if (Test-JdmServer) { Write-Host 'Using the JDM server already running on this PC.'; Open-Jdm; exit 0 }
  $hasher = [System.Security.Cryptography.SHA256]::Create()
  try { $workspaceHash = ([System.BitConverter]::ToString($hasher.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($projectRoot.ToLowerInvariant())))).Replace('-', '').Substring(0, 20) }
  finally { $hasher.Dispose() }
  $launchMutex = New-Object System.Threading.Mutex($false, "Local\JDM-$workspaceHash")
  try { $ownsMutex = $launchMutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
  if (-not $ownsMutex) {
    Write-Host 'Another JDM launcher is preparing the app. Waiting for it...'
    $deadline = [DateTime]::UtcNow.AddMinutes(3)
    while ([DateTime]::UtcNow -lt $deadline) { if (Test-JdmServer) { Open-Jdm; exit 0 }; Start-Sleep -Milliseconds 500 }
    throw 'Another JDM launcher is still preparing the app. Check its window and try again when it finishes.'
  }
  if (Test-JdmServer) { Open-Jdm; exit 0 }
  if (Test-PortOccupied) { throw 'Port 4317 is already occupied by another or unready service. No process was stopped. Close that service yourself, then launch JDM again.' }

  $nodeExecutable = Find-Executable @('node.exe', 'node') @((Join-Path $env:ProgramFiles 'nodejs\node.exe'), (Join-Path $runtimeRoot 'node\bin\node.exe'))
  if (-not $nodeExecutable) { throw 'Node.js was not found. Install Node.js 22.12 or newer, or restore the installed Codex Node runtime, then try again.' }
  $nodeVersionText = (& $nodeExecutable --version).Trim()
  if ($LASTEXITCODE -ne 0 -or $nodeVersionText -notmatch '^v(\d+)\.(\d+)\.(\d+)') { throw 'The installed Node.js runtime could not report its version.' }
  if ([int]$Matches[1] -lt 22 -or ([int]$Matches[1] -eq 22 -and [int]$Matches[2] -lt 12)) { throw "JDM needs Node.js 22.12 or newer. Found $nodeVersionText." }
  $env:Path = (Split-Path -Parent $nodeExecutable) + ';' + $env:Path
  Push-Location -LiteralPath $projectRoot
  $pushedLocation = $true

  $needInstall = $false
  foreach ($module in @('fastify', '@fastify\static', 'pngjs', 'zod', 'tsx', 'esbuild', 'vite', 'react', 'react-dom')) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "node_modules\$module\package.json") -PathType Leaf)) { $needInstall = $true }
  }
  $lockFile = Join-Path $projectRoot 'pnpm-lock.yaml'
  $installedLock = Join-Path $projectRoot 'node_modules\.pnpm\lock.yaml'
  if (-not (Test-Path -LiteralPath $lockFile -PathType Leaf)) { throw 'pnpm-lock.yaml is missing. Restore the project lockfile before launching.' }
  if (-not (Test-Path -LiteralPath $installedLock -PathType Leaf)) { $needInstall = $true }
  elseif ((Get-FileHash -LiteralPath $lockFile -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $installedLock -Algorithm SHA256).Hash) { $needInstall = $true }
  $needBuild = Test-BuildNeeded
  if ($needInstall -or $needBuild) {
    $pnpmExecutable = Find-Executable @('pnpm.cmd', 'pnpm.exe', 'pnpm') @((Join-Path $env:APPDATA 'npm\pnpm.cmd'), (Join-Path $runtimeRoot 'bin\fallback\pnpm.cmd'))
    if (-not $pnpmExecutable) { throw 'pnpm was not found. Install or restore pnpm, then launch JDM again.' }
    if ($needInstall) {
      Write-Host 'Preparing project dependencies. The first setup may need an internet connection...'
      & $pnpmExecutable install --frozen-lockfile
      if ($LASTEXITCODE -ne 0) { throw 'Dependency setup failed. Check the package-manager output above, then try again.' }
      $needBuild = $true
    }
    if ($needBuild) {
      Write-Host 'Building the local JDM app...'
      & $pnpmExecutable build
      if ($LASTEXITCODE -ne 0) { throw 'The JDM build failed. Check the build output above. Your saved designs have not been changed.' }
    }
  }
  foreach ($file in @($serverEntry, $workerEntry, $webEntry)) { if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'The build did not produce every required app file. Run pnpm build and inspect its output.' } }
  # Recheck after a build in case a different launcher/server started meanwhile.
  if (Test-JdmServer) { Open-Jdm; exit 0 }
  if (Test-PortOccupied) { throw 'Port 4317 became occupied while JDM was preparing. No existing process was stopped.' }
  $logDirectory = Join-Path $projectRoot 'data\jdm\logs'
  New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  $logStem = 'server-' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss-fff')
  $outputLog = Join-Path $logDirectory "$logStem.log"
  $errorLog = Join-Path $logDirectory "$logStem.error.log"
  $env:JDM_PORT = '4317'
  $env:JDM_DATA_DIR = Join-Path $projectRoot 'data\jdm'
  $env:JDM_STATIC_DIR = Join-Path $projectRoot 'apps\web\dist'
  Write-Host 'Starting JDM on this PC...'
  $serverProcess = Start-Process -FilePath $nodeExecutable -ArgumentList @('"' + $serverEntry + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $outputLog -RedirectStandardError $errorLog -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-JdmServer) { Open-Jdm; exit 0 }
    $serverProcess.Refresh()
    if ($serverProcess.HasExited) {
      if (Test-Path -LiteralPath $errorLog) { Get-Content -LiteralPath $errorLog -Tail 12 | Write-Host }
      throw "JDM stopped during startup. Details: $errorLog"
    }
    Start-Sleep -Milliseconds 350
  }
  throw "JDM has not become ready yet. Check $outputLog and $errorLog. No process was stopped."
} catch {
  Write-Host ''
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
} finally {
  if ($pushedLocation) { Pop-Location }
  if ($ownsMutex -and $null -ne $launchMutex) { $launchMutex.ReleaseMutex() }
  if ($null -ne $launchMutex) { $launchMutex.Dispose() }
}
