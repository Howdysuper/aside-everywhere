# aside-wake.ps1 — fired by Task Scheduler just before a sweep window.
# Wakes the machine (WakeToRun) and holds it awake long enough for the
# Schoology sweep guard slot + the morning digest push, then lets the
# normal power policy take over again.
param([int]$Minutes = 45)

$log = "$env:LOCALAPPDATA\AsideMobile\Logs\wake-task.log"
function Write-Log([string]$msg) {
  "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Out-File -FilePath $log -Append -Encoding utf8
}

try {
  Add-Type -Namespace Win32 -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint es);' -ErrorAction Stop
  $ES_CONTINUOUS = [uint32]'0x80000000'
  $ES_SYSTEM_REQUIRED = [uint32]'0x00000001'
  $ES_AWAYMODE = [uint32]'0x00000040'
  [void][Win32.Power]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED -bor $ES_AWAYMODE)
  Write-Log "awake-hold started for $Minutes min"
  Start-Sleep -Seconds ($Minutes * 60)
  [void][Win32.Power]::SetThreadExecutionState($ES_CONTINUOUS)
  Write-Log "awake-hold released"
} catch {
  Write-Log "ERROR: $($_.Exception.Message)"
}
