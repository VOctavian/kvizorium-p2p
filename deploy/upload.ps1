# Builds Kvizorium and puts it on the server (first install and every update).
#   powershell -ExecutionPolicy Bypass -File deploy\upload.ps1 -Server 1.2.3.4 -Domain kvizorium.duckdns.org
# -Key: the private SSH key whose public half was given to Oracle when the server was created.
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [Parameter(Mandatory = $true)][string]$Domain,
  [string]$Key = "$HOME\.ssh\id_ed25519",
  [string]$User = "ubuntu"
)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

Write-Host "== Building" -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { throw "Build failed" }

Write-Host "== Packing" -ForegroundColor Cyan
$archive = Join-Path $env:TEMP "kvizorium.tgz"
if (Test-Path $archive) { Remove-Item $archive }
tar -czf $archive apps/server/dist/server.cjs apps/web/dist packs deploy
if ($LASTEXITCODE -ne 0) { throw "Packing failed" }

Write-Host "== Uploading to $Server" -ForegroundColor Cyan
scp -i $Key $archive "${User}@${Server}:/tmp/kvizorium.tgz"
if ($LASTEXITCODE -ne 0) { throw "Upload failed" }

Write-Host "== Installing" -ForegroundColor Cyan
# The script is unpacked first; Windows line endings would break bash, so they are stripped.
ssh -i $Key "${User}@${Server}" "tar -xzf /tmp/kvizorium.tgz -C /tmp deploy/setup.sh && sed -i 's/\r$//' /tmp/deploy/setup.sh && sudo bash /tmp/deploy/setup.sh $Domain /tmp/kvizorium.tgz"
if ($LASTEXITCODE -ne 0) { throw "Install failed" }

Remove-Item $archive
Write-Host "== Done: https://$Domain" -ForegroundColor Green
