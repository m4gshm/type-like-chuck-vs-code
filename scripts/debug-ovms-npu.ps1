# Manual NPU debug launcher for ovms + Qwen2.5-Coder OV IR model.
# Mirrors the exact args the TLC extension passes (device.ts ovmsDeviceOptions).
# PowerShell 5.1 mangles embedded quotes with plain `&`, so the command line is
# built by hand and start via Start-Process ("" escapes a quote in the raw line).
$ErrorActionPreference = 'Continue'

$engineRoot = "$env:APPDATA\Code\User\globalStorage\m4gshm.tlc"
$ovms   = Join-Path $engineRoot 'engine\v2026.4.1\ovms\ovms.exe'
$model  = Join-Path $engineRoot 'models\OpenVINO\Qwen2.5-Coder-1.5B-Instruct-int4-ov'
$cache  = Join-Path $engineRoot 'ov-cache'
$port   = 8887

if (-not (Test-Path $ovms))  { Write-Error "ovms.exe not found: $ovms"; exit 1 }
if (-not (Test-Path $model)) { Write-Error "model dir not found: $model"; exit 1 }
New-Item -ItemType Directory -Force -Path $cache | Out-Null

# Same plugin config as device.ts ovmsDeviceOptions('npu', cacheDir)
# ovms composes its own NPUW_LLM_* properties internally — passing them here
# fails with "Doubled ... parameter", so only generic plugin keys are sent.
$pluginConfig = @{
  PERFORMANCE_HINT                        = 'LATENCY'
  ENABLE_MMAP                             = 'YES'
  CACHE_DIR                               = $cache
  CACHE_MODE                              = 'OPTIMIZE_SPEED'
  NPUW_PARALLEL_COMPILE                   = 'YES'
  LOG_LEVEL                               = 'LOG_TRACE'
} | ConvertTo-Json -Compress

$env:API_KEY = 'testkey'
$argLine = "--model_name Qwen2.5-Coder-1.5B-Instruct-int4-ov" +
  " --model_path `"$model`"" +
  " --task text_generation" +
  " --target_device NPU" +
  " --plugin_config `"" + $pluginConfig.Replace('"', '""') + "`"" +
  " --log_level DEBUG" +
  " --rest_bind_address 127.0.0.1" +
  " --rest_port $port"

Write-Host "ovms:   $ovms"
Write-Host "model:  $model"
Write-Host "cache:  $cache"
Write-Host "plugin: $pluginConfig"
Write-Host "endpoint: http://127.0.0.1:$port/v3  (API_KEY env: testkey)"
Write-Host 'Stop with: Get-Process ovms | Stop-Process'
Write-Host ''

$outFile = "$env:TEMP\ovms-debug-out.log"
$errFile = "$env:TEMP\ovms-debug-err.log"
Remove-Item $outFile, $errFile -ErrorAction SilentlyContinue
$p = Start-Process -FilePath $ovms -ArgumentList $argLine -NoNewWindow -PassThru `
  -RedirectStandardOutput $outFile -RedirectStandardError $errFile
Write-Host "ovms pid: $($p.Id); streaming logs (Ctrl+C stops the stream)..."
Get-Content $outFile, $errFile -Wait -ErrorAction SilentlyContinue
