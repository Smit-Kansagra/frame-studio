$ErrorActionPreference = 'Stop'
$taskStatus = Join-Path $PSScriptRoot '..\local-model-install-status.json'
$modelManifest = Join-Path $env:USERPROFILE '.ollama\models\manifests\registry.ollama.ai\library\qwen3\4b-instruct'
$modelBlobs = Join-Path $env:USERPROFILE '.ollama\models\blobs'
$ollamaExecutable = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
$deadline = (Get-Date).AddHours(2)
@{ state='downloading'; model='qwen3:4b-instruct'; oldModel='qwen2.5:1.5b'; updatedAt=(Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $taskStatus
try {
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $modelManifest) {
      $manifestValue = Get-Content -LiteralPath $modelManifest -Raw | ConvertFrom-Json
      $allFilesReady = $true
      foreach ($layer in @($manifestValue.config) + @($manifestValue.layers)) {
        $blobPath = Join-Path $modelBlobs ($layer.digest.Replace(':','-'))
        if (!(Test-Path -LiteralPath $blobPath) -or (Get-Item -LiteralPath $blobPath).Length -ne $layer.size) { $allFilesReady = $false; break }
      }
      if ($allFilesReady) {
        & $ollamaExecutable rm qwen2.5:1.5b *> (Join-Path $PSScriptRoot '..\local-model-cleanup.log')
        if ($LASTEXITCODE -ne 0) { throw 'New model installed, but old-model removal failed. See local-model-cleanup.log.' }
        @{ state='complete'; model='qwen3:4b-instruct'; oldModelRemoved=$true; updatedAt=(Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $taskStatus
        exit 0
      }
    }
    Start-Sleep -Seconds 15
  }
  throw 'Download did not finish within two hours. Old model was preserved.'
} catch {
  @{ state='needs-attention'; model='qwen3:4b-instruct'; message=$_.Exception.Message; updatedAt=(Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $taskStatus
  exit 1
}
