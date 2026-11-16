# Edge 扩展加载冒烟测试
# 用独立的临时用户目录启动 headless Edge，加载扩展，检查 service worker 是否注册成功。
# 用法：pwsh -File tools/extension_smoke.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$ext = Join-Path $root 'extension'
$profile = Join-Path $root '.smoke-profile'
$port = 9223

if (-not (Test-Path $edge)) { Write-Error "找不到 Edge: $edge"; exit 1 }
if (-not (Test-Path $ext)) { Write-Error "找不到扩展目录: $ext"; exit 1 }

Write-Output "清理临时 profile: $profile"
Remove-Item -LiteralPath $profile -Recurse -Force -ErrorAction SilentlyContinue

$edgeArgs = @(
  '--headless=new'
  '--disable-gpu'
  '--no-first-run'
  '--no-default-browser-check'
  '--disable-features=msEdgeSidebarV2'
  "--user-data-dir=$profile"
  "--load-extension=$ext"
  "--remote-debugging-port=$port"
  'about:blank'
)

Write-Output "启动 Edge..."
$proc = Start-Process -FilePath $edge -ArgumentList $edgeArgs -PassThru -WindowStyle Hidden
try {
  $targets = $null
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 3
      if ($targets) { break }
    } catch { }
  }

  if (-not $targets) {
    Write-Output 'RESULT: FAIL 无法连接 CDP 调试端口'
    exit 1
  }

  $targets | ForEach-Object {
    Write-Output ("TARGET type={0} url={1}" -f $_.type, $_.url)
  }

  $sw = @($targets | Where-Object { $_.type -eq 'service_worker' -and $_.url -like 'chrome-extension://*' })
  if ($sw.Count -gt 0) {
    Write-Output ''
    Write-Output ('RESULT: PASS 扩展 service worker 已注册: ' + $sw[0].url)
    # 提取扩展 ID
    if ($sw[0].url -match 'chrome-extension://([a-p]{32})/') {
      Write-Output ('EXTENSION_ID: ' + $matches[1])
    }
    exit 0
  } else {
    Write-Output ''
    Write-Output 'RESULT: FAIL 未发现扩展 service worker（可能 manifest 有误或扩展加载失败）'
    exit 1
  }
} finally {
  Write-Output '停止 Edge...'
  try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
  Start-Sleep -Milliseconds 500
  Remove-Item -LiteralPath $profile -Recurse -Force -ErrorAction SilentlyContinue
}
