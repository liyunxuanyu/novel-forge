<#
  测试入口：跑完 novel-forge 全部测试。

  用法：
    pwsh -File scripts/test.ps1                         # 全部
    pwsh -File scripts/test.ps1 -Filter integration      # 只跑文件名含该串的

  本机踩过的坑，改这个脚本时别踩回去：
    1) DSH NEXT.exe 是 Windows GUI 子系统程序。在 .ps1 脚本里直接 & 调用它，
       子进程会静默失败 —— 0 字节输出、$LASTEXITCODE 根本没被赋值。
       必须用 Start-Process -RedirectStandardOutput，让它拿到真实文件句柄。
    2) 不要把 FileInfo 直接传给原生可执行文件，参数绑定不走 ToString()。
       先把路径取成字符串。
#>
[CmdletBinding()]
param([string[]]$Filter = @())

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$exe = "D:\Program software\DSH NEXT\DSH NEXT.exe"

if (-not (Test-Path $exe)) { Write-Host "找不到 DSH 可执行文件：$exe"; exit 1 }

if (-not (Test-Path (Join-Path $projectRoot "node_modules\@deepseek-ai\dsh-tools"))) {
  Write-Host "开发期依赖缺失，先建立链接……"
  & (Join-Path $PSScriptRoot "link-dev-deps.ps1") -Force
  if ($LASTEXITCODE -ne 0) { exit 1 }
}

$tests = @(
  Get-ChildItem (Join-Path $projectRoot "test") -Filter "*.test.mjs" -File |
    Sort-Object Name |
    ForEach-Object { $_.FullName }
)
if ($Filter.Count -gt 0) {
  $tests = @($tests | Where-Object {
    $leaf = Split-Path $_ -Leaf
    ($Filter | Where-Object { $leaf -like "*$_*" }).Count -gt 0
  })
}
if ($tests.Count -eq 0) { Write-Host "没有匹配的测试"; exit 1 }

$logDir = Join-Path $projectRoot ".test-logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

function Invoke-Test {
  param([string]$Script, [string]$StdOut, [string]$StdErr)
  $proc = Start-Process -FilePath $exe -ArgumentList "`"$Script`"" `
    -NoNewWindow -Wait -PassThru -RedirectStandardOutput $StdOut -RedirectStandardError $StdErr
  return $proc.ExitCode
}

$failed = @()
foreach ($testPath in $tests) {
  $leaf = Split-Path $testPath -Leaf
  $stdoutPath = Join-Path $logDir "$leaf.out"
  $stderrPath = Join-Path $logDir "$leaf.err"
  Remove-Item $stdoutPath, $stderrPath -ErrorAction SilentlyContinue

  Write-Host ""
  Write-Host ("=" * 66)

  $env:ELECTRON_RUN_AS_NODE = "1"
  $code = Invoke-Test -Script $testPath -StdOut $stdoutPath -StdErr $stderrPath

  if ((Test-Path $stdoutPath) -and (Get-Item $stdoutPath).Length -gt 0) {
    Get-Content $stdoutPath | Write-Host
  }
  if ((Test-Path $stderrPath) -and (Get-Item $stderrPath).Length -gt 0) {
    Write-Host "--- stderr ---"
    Get-Content $stderrPath | Write-Host
  }
  if ($code -ne 0) { $failed += "$leaf (exit=$code)" }
}

Write-Host ""
Write-Host ("=" * 66)
if ($failed.Count -gt 0) {
  Write-Host ("失败： " + ($failed -join ", "))
  exit 1
}
Write-Host "全部通过"
exit 0
