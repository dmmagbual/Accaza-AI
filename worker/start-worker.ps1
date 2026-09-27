# Starts the Accaza AI laptop worker and restarts it if it stops unexpectedly.
# Normally launched hidden at logon by the scheduled task from install-startup.ps1.
# Logs: %USERPROFILE%\.accaza-ai\logs\worker.log (plus console.log from this wrapper).
$ErrorActionPreference = "Continue"
$Repo = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $env:USERPROFILE ".accaza-ai\logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$DockerBin = "C:\Program Files\Docker\Docker\resources\bin"
if (Test-Path $DockerBin) { $env:Path = "$DockerBin;$env:Path" }

# Docker Desktop usually starts at sign-in; give it up to 3 minutes. The worker also copes with
# Docker starting later (queued tasks wait, and it re-checks every minute).
$DockerDesktop = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
if (-not (Get-Process "Docker Desktop" -ErrorAction SilentlyContinue) -and (Test-Path $DockerDesktop)) { Start-Process $DockerDesktop }
for ($i = 0; $i -lt 36; $i++) { docker version --format "{{.Server.Version}}" *> $null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep 5 }

Set-Location $Repo
$fails = 0
while ($true) {
  $started = Get-Date
  node worker/index.js *>> (Join-Path $LogDir "console.log")
  $code = $LASTEXITCODE
  Add-Content (Join-Path $LogDir "console.log") "$(Get-Date -Format s) worker exited with code $code"
  # Crash-looping (e.g. bad config): back off up to 5 minutes between tries.
  if (((Get-Date) - $started).TotalSeconds -lt 60) { $fails++ } else { $fails = 0 }
  Start-Sleep ([Math]::Min(300, 5 * [Math]::Pow(2, [Math]::Min($fails, 6))))
}
