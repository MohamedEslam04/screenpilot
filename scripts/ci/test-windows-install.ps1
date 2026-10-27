# Silent install -> doctor -> silent uninstall of the Windows .exe, against a throwaway home.
# The install folder and the fake home both contain a space; the install folder also has Arabic letters.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$exe = Get-ChildItem (Join-Path $root 'release') -Filter '*-windows-setup.exe' | Select-Object -First 1
if (-not $exe) { throw 'no *-windows-setup.exe in release/' }

$fake = Join-Path $env:RUNNER_TEMP 'fake home'
Remove-Item $fake -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$fake\.codex", "$fake\.config\opencode", "$fake\AppData\Roaming", "$fake\AppData\Local" | Out-Null
$dir = Join-Path $env:RUNNER_TEMP ([string]::Concat([char]0x062A, [char]0x062C, [char]0x0631, [char]0x0628, [char]0x0629) + ' ScreenPilot')
Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue

# The installer's last step runs node, which reads these to find the "home" folder.
$env:USERPROFILE = $fake
$env:HOME = $fake
$env:APPDATA = "$fake\AppData\Roaming"
$env:LOCALAPPDATA = "$fake\AppData\Local"
$log = Join-Path $env:RUNNER_TEMP 'install.log'

function Show-Log($path) { if (Test-Path $path) { Write-Host "---- $path"; Get-Content $path -Tail 60 } }

Write-Host "Installing $($exe.Name) to $dir"
$p = Start-Process -FilePath $exe.FullName -Wait -PassThru -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/CURRENTUSER', '/NORESTART', "/DIR=`"$dir`"", "/LOG=`"$log`"")
if ($p.ExitCode -ne 0) { Show-Log $log; throw "installer exited with $($p.ExitCode)" }
Show-Log $log

foreach ($f in 'bin\node.exe', 'bin\ffmpeg.exe', 'bin\ffprobe.exe', 'dist\cli.js', 'dist\mcp.js', 'unins000.exe') {
  if (-not (Test-Path (Join-Path $dir $f))) { throw "missing after install: $f" }
}

node (Join-Path $root 'scripts\ci\assert-registered.mjs') $fake present
if ($LASTEXITCODE -ne 0) { throw 'AI apps were not configured' }

Write-Host 'doctor (installed copy, its own node):'
& (Join-Path $dir 'bin\node.exe') (Join-Path $dir 'dist\cli.js') doctor | Set-Content -Encoding utf8 (Join-Path $env:RUNNER_TEMP 'doctor.json')
$doctor = Join-Path $env:RUNNER_TEMP 'doctor.json'
node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(d.summary);const f=d.checks.filter(c=>['ffmpeg','ffprobe','node'].includes(c.name)&&!c.ok);if(f.length){console.error(JSON.stringify(f));process.exit(1)}" $doctor
if ($LASTEXITCODE -ne 0) { throw 'doctor reports a problem with the installed copy' }

# Upgrade over the existing install (same version): must succeed and keep working.
$p = Start-Process -FilePath $exe.FullName -Wait -PassThru -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/CURRENTUSER', '/NORESTART', "/DIR=`"$dir`"")
if ($p.ExitCode -ne 0) { throw "upgrade install exited with $($p.ExitCode)" }
node (Join-Path $root 'scripts\ci\assert-registered.mjs') $fake present
if ($LASTEXITCODE -ne 0) { throw 'AI apps lost their entry after the upgrade' }

# The uninstaller re-launches itself from a temp copy, so wait for the folder to go away instead of for the process.
Write-Host 'Uninstalling'
Start-Process -FilePath (Join-Path $dir 'unins000.exe') -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') | Out-Null
$deadline = (Get-Date).AddSeconds(120)
while ((Test-Path (Join-Path $dir 'bin')) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
if (Test-Path (Join-Path $dir 'bin')) { throw 'uninstaller left files behind' }

node (Join-Path $root 'scripts\ci\assert-registered.mjs') $fake absent
if ($LASTEXITCODE -ne 0) { throw 'uninstaller left the AI app entries behind' }
Write-Host 'Windows installer test passed'
