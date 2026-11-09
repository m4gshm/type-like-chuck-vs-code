# Manual NPU debug launcher: llama.cpp (openvino build) + Qwen2.5-Coder GGUF on the Intel NPU.
# Mirrors what the TLC extension does (engine_manager.ts + engine_runner.ts).
param(
  [string]$Device = 'NPU',        # NPU | GPU | CPU
  [int]$Port = 8888,
  [string]$ModelPath = '',
  [string]$ReleaseTag = 'b11935'
)
$ErrorActionPreference = 'Continue'

$engineRoot = "$env:APPDATA\Code\User\globalStorage\m4gshm.tlc"
$variantDir = Join-Path $engineRoot "engine\$ReleaseTag-llama-openvino"
$server     = Join-Path $variantDir 'llama-server.exe'
$modelsDir  = Join-Path $engineRoot 'models'
$cache      = Join-Path $engineRoot 'ov-cache'
if (-not $ModelPath) { $ModelPath = Join-Path $modelsDir 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf' }

# 1. Engine: download + extract the openvino build when missing.
if (-not (Test-Path $server)) {
  $zipName = "llama-$ReleaseTag-bin-win-openvino-2026.4.1-x64.zip"
  $url = "https://github.com/ggml-org/llama.cpp/releases/download/$ReleaseTag/$zipName"
  $zip = Join-Path $engineRoot $zipName
  New-Item -ItemType Directory -Force -Path $engineRoot, $variantDir, $cache | Out-Null
  Write-Host "Downloading $url"
  curl.exe -fL $url -o $zip
  if ($LASTEXITCODE -ne 0) { Write-Error 'download failed'; exit 1 }
  Expand-Archive $zip $variantDir -Force
  Remove-Item $zip -Force
}

# 2. Model: the same GGUF the extension downloads.
if (-not (Test-Path $ModelPath)) {
  $url = 'https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf'
  Write-Host "Downloading model $url"
  curl.exe -fL $url -o $ModelPath
  if ($LASTEXITCODE -ne 0) { Write-Error 'model download failed'; exit 1 }
}
New-Item -ItemType Directory -Force -Path $cache | Out-Null

Write-Host "server: $server"
Write-Host "model:  $ModelPath"
Write-Host "device: $Device  cache: $cache"
Write-Host "endpoint: http://127.0.0.1:$Port/v1  (no key auth)"
Write-Host 'Stop with: Get-Process llama-server | Stop-Process'
Write-Host ''

$env:GGML_OPENVINO_DEVICE = $Device.ToUpper()
$env:GGML_OPENVINO_COMPILED_MODEL_CACHE_DIR = $cache
$env:GGML_OPENVINO_PREFILL_CHUNK_SIZE = '256'
$env:GGML_OPENVINO_NPU_COMPILE_CONFIG = 'optimization-level=3'
$env:GGML_OPENVINO_MANUAL_GQA_ATTN = '1'

& $server `
  --host 127.0.0.1 --port $Port `
  -m $ModelPath `
  -c 8192 `
  -ngl 999 `
  -b 256 -ub 256
