# One-time Google Cloud setup for the laptop worker (safe to run again).
# Needs gcloud signed in as the project owner:  gcloud auth login danilomagbual@gmail.com
#   powershell -ExecutionPolicy Bypass -File worker\setup-gcp.ps1
# Creates:
#   - bucket gs://accaza-ai-task-files (asia-southeast1, private, files deleted after 90 days)
#   - service account laptop-worker@accaza-ai with only what the worker needs:
#       Firestore read/write, that one bucket, and read access to 4 AI secrets
#   - a key for it in %USERPROFILE%\.accaza-ai\worker-key.json, readable only by you
# Native command errors are checked through $LASTEXITCODE (gcloud writes progress to stderr).
$ErrorActionPreference = "Continue"
$Project = "accaza-ai"
$Bucket = "accaza-ai-task-files"
$Sa = "laptop-worker@$Project.iam.gserviceaccount.com"
$DataDir = Join-Path $env:USERPROFILE ".accaza-ai"
$KeyFile = Join-Path $DataDir "worker-key.json"
$Secrets = @("GEMINI_API_KEY", "WEB_SEARCH_KEY", "DEEPSEEK_API_KEY", "CEREBRAS_API_KEY")

function Run($what, [scriptblock]$cmd) { Write-Host "-> $what"; & $cmd; if ($LASTEXITCODE -ne 0) { throw "$what failed ($LASTEXITCODE)" } }

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

# Bucket
gcloud storage buckets describe "gs://$Bucket" --project $Project *> $null
if ($LASTEXITCODE -ne 0) {
  Run "create bucket" { gcloud storage buckets create "gs://$Bucket" --project $Project --location asia-southeast1 --uniform-bucket-level-access --public-access-prevention }
}
$lifecycle = Join-Path $env:TEMP "accaza-lifecycle.json"
'{"rule":[{"action":{"type":"Delete"},"condition":{"age":90}}]}' | Out-File -Encoding ascii $lifecycle
Run "bucket lifecycle (delete after 90 days)" { gcloud storage buckets update "gs://$Bucket" --lifecycle-file $lifecycle --project $Project }

# Service account and its permissions
gcloud iam service-accounts describe $Sa --project $Project *> $null
if ($LASTEXITCODE -ne 0) {
  Run "create service account" { gcloud iam service-accounts create laptop-worker --project $Project --display-name "Accaza AI laptop worker" --description "Runs laptop tasks on SUPERDAD: Firestore, task files bucket, 4 AI secrets" }
}
Run "Firestore access" { gcloud projects add-iam-policy-binding $Project --member "serviceAccount:$Sa" --role roles/datastore.user --condition None --quiet *> $null }
Run "bucket access" { gcloud storage buckets add-iam-policy-binding "gs://$Bucket" --member "serviceAccount:$Sa" --role roles/storage.objectAdmin --project $Project *> $null }
foreach ($s in $Secrets) {
  Run "secret $s" { gcloud secrets add-iam-policy-binding $s --project $Project --member "serviceAccount:$Sa" --role roles/secretmanager.secretAccessor *> $null }
}

# Key (only if there is none yet)
if (-not (Test-Path $KeyFile)) {
  Run "create key" { gcloud iam service-accounts keys create $KeyFile --iam-account $Sa --project $Project }
  icacls $KeyFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
}
Write-Host "Done. Key: $KeyFile"
