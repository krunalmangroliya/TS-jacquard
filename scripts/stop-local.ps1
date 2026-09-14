[CmdletBinding()]
param([switch]$CheckOnly)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$serverEntry = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'apps\server\dist\main.mjs'))

function Get-JdmListener {
  # Querying the listener list, then filtering, distinguishes an unused port
  # from a failed/denied system query. A failed query must never permit a stop.
  $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq 4317 })
  if ($listeners.Count -eq 0) { return $null }
  $owners = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
  if ($owners.Count -ne 1 -or @($listeners | Where-Object { $_.LocalAddress -ne '127.0.0.1' }).Count -gt 0) {
    throw 'Port 4317 is not owned by a single loopback JDM server. No process was stopped.'
  }
  return [int]$owners[0]
}

function Assert-JdmProcess($ProcessInfo, [string]$ExpectedEntry) {
  if ($null -eq $ProcessInfo -or [string]::IsNullOrWhiteSpace($ProcessInfo.ExecutablePath) -or [string]::IsNullOrWhiteSpace($ProcessInfo.CommandLine)) {
    throw 'The server process identity could not be read. No process was stopped.'
  }
  $executable = [System.IO.Path]::GetFullPath($ProcessInfo.ExecutablePath)
  if ([System.IO.Path]::GetFileName($executable) -ine 'node.exe' -or -not [System.IO.Path]::IsPathRooted($ProcessInfo.ExecutablePath)) {
    throw 'Port 4317 belongs to another application. No process was stopped.'
  }
  # The launcher supplies exactly two arguments: the Node executable and this
  # absolute script path. Anchoring the complete command rejects other workspaces,
  # eval/preload wrappers and paths that only happen to contain the expected text.
  $quotedExe = '"' + [regex]::Escape($executable) + '"'
  $quotedEntry = '"' + [regex]::Escape($ExpectedEntry) + '"'
  $pattern = '^\s*(?:' + $quotedExe + '|' + [regex]::Escape($executable) + ')\s+(?:' + $quotedEntry + '|' + [regex]::Escape($ExpectedEntry) + ')\s*$'
  if (-not [regex]::IsMatch($ProcessInfo.CommandLine, $pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
    throw 'Port 4317 is running a different project or an unrecognized server command. Use the matching project to stop it. No process was stopped.'
  }
}

$targetProcess = $null
try {
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'package.json') -PathType Leaf)) {
    throw 'Keep Stop-JDM.cmd and the scripts folder inside the JDM project folder.'
  }
  $serverProcessId = Get-JdmListener
  if ($null -eq $serverProcessId) { Write-Host 'JDM is already stopped on port 4317.'; exit 0 }
  $identity = Get-CimInstance Win32_Process -Filter "ProcessId = $serverProcessId" -ErrorAction Stop
  Assert-JdmProcess $identity $serverEntry
  if ($CheckOnly) { Write-Host "Verified this project's JDM server (process $serverProcessId). Check only; it is still running." -ForegroundColor Green; exit 0 }

  # Hold the process handle across the last identity/listener checks. This avoids
  # stopping a replacement process if the original exits and its PID is reused.
  $targetProcess = [System.Diagnostics.Process]::GetProcessById($serverProcessId)
  $heldHandle = $targetProcess.Handle
  $latestIdentity = Get-CimInstance Win32_Process -Filter "ProcessId = $serverProcessId" -ErrorAction Stop
  Assert-JdmProcess $latestIdentity $serverEntry
  if ($identity.CreationDate -ne $latestIdentity.CreationDate -or $targetProcess.HasExited -or (Get-JdmListener) -ne $serverProcessId) {
    throw 'The server changed while it was being checked. No process was stopped. Try the shortcut again.'
  }
  Write-Host 'Stopping this project''s JDM server. Saved designs and retained files stay in data\jdm.'
  $targetProcess.Kill()
  if (-not $targetProcess.WaitForExit(5000)) { throw 'JDM has not exited yet. Wait before copying a backup of data\jdm.' }
  Write-Host 'JDM stopped. You can now back up data\jdm. Use Start-JDM.cmd to reopen the app.' -ForegroundColor Green
} catch {
  Write-Host ''
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
} finally {
  if ($null -ne $targetProcess) { $targetProcess.Dispose() }
}
