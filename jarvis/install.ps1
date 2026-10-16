# Hey Aside for Windows: one-time setup. Run from this folder in PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1          (Bypass applies to this one run only)
#
# What it does, all inside your user account (no admin rights):
#   1. Creates a private Python environment in .venv next to this file.
#   2. Installs the exact packages in requirements.txt, each checked against its SHA-256 hash.
#   3. Downloads the wake-word model ("hey jarvis") and the speech-to-text model.
#   4. Adds Hey Aside to your login items (HKCU Run) and starts it.
# Undo everything with .\uninstall.ps1.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Find-Python {
  foreach ($v in @('3.13', '3.12')) {
    try { $p = & py "-$v" -c "import sys; print(sys.executable)" 2>$null; if ($LASTEXITCODE -eq 0 -and $p) { return $p.Trim() } } catch {}
  }
  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if ($cmd) {
    $ver = & $cmd.Source -c "import sys; print('%d.%d' % sys.version_info[:2])"
    if ($ver -in @('3.12', '3.13')) { return $cmd.Source }
  }
  return $null
}

$py = Find-Python
if (-not $py) { throw 'Python 3.12 or 3.13 is required. Install it with: winget install Python.Python.3.13  (then open a new PowerShell)' }
Write-Host "Using Python: $py"

if (-not (Test-Path .venv\Scripts\python.exe)) { & $py -m venv .venv }
$vpy = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
& $vpy -m pip install --require-virtualenv --require-hashes -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'Package install failed (see above).' }

Write-Host 'Downloading the wake-word and speech models (first run only)...'
& $vpy -c "from heyaside import audio, config; audio.ensure_wake_models(); from heyaside.stt import Transcriber; Transcriber(config.load()['whisperModel']); print('models ready')"
if ($LASTEXITCODE -ne 0) { throw 'Model download failed (see above).' }

$aside = Join-Path $env:LOCALAPPDATA 'Aside\CLI\current\aside.exe'
if (-not (Test-Path $aside) -and -not (Get-Command aside -ErrorAction SilentlyContinue)) {
  Write-Warning 'Aside CLI not found. Install it from Aside Settings > Developer (or Aside''s signed PowerShell installer), then restart Hey Aside.'
}

$pyw = Join-Path $PSScriptRoot '.venv\Scripts\pythonw.exe'
$watchdog = Join-Path $PSScriptRoot 'heyaside\watchdog.py'
$wdArgs = "`"$pyw`" `"$watchdog`""

# The watchdog (not the app) starts at login: it spawns Hey Aside, watches its
# heartbeat, and restarts it if it crashes or hangs. A bare Run entry could
# not do that, and a silently dead tray app is the failure this prevents.
try {
  $action = New-ScheduledTaskAction -Execute $pyw -Argument "`"$watchdog`"" -WorkingDirectory $PSScriptRoot
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName 'Hey Aside Watchdog' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Write-Host 'Registered the watchdog task to start at login.'
} catch {
  Write-Warning "Could not register the scheduled task ($_). Falling back to a Run entry."
}
Start-Process -FilePath $pyw -ArgumentList '-m', 'heyaside', '--enable-login' -WorkingDirectory $PSScriptRoot
Start-Process -FilePath $pyw -ArgumentList "`"$watchdog`"" -WorkingDirectory $PSScriptRoot
Write-Host ''
Write-Host 'Hey Aside is running (blue orb in the system tray), and the watchdog keeps it alive. Say "Hey Jarvis", or press Ctrl+Alt+J.'
Write-Host "Settings: $env:APPDATA\HeyAside\settings.json   Log: $env:LOCALAPPDATA\HeyAside\Logs\heyaside.log"
