# Removes Hey Aside from login, stops it, and deletes its settings, models and logs. Keeps this folder.
$ErrorActionPreference = 'SilentlyContinue'
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'HeyAside'
Get-CimInstance Win32_Process -Filter "Name = 'pythonw.exe'" | Where-Object { $_.CommandLine -like '*-m heyaside*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Remove-Item -Recurse -Force "$env:APPDATA\HeyAside", "$env:LOCALAPPDATA\HeyAside", "$env:TEMP\heyaside-tts"
Write-Host 'Hey Aside removed from login and its data deleted. Delete this folder to remove the program itself.'
