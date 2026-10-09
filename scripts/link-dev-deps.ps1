<#
  开发期依赖链接 —— 仅供本机源码调试使用。

  背景：插件以 pnpm link（junction）装进 profile，Node 按真实路径解析依赖，
  于是 @deepseek-ai/* 必须能从插件目录向上找到。宿主的实际运行时依赖在
  DSH 安装目录的 node_modules 下，而 .dsh\profiles\node_modules 里是一套旧版本
  （0.1.1-rc.2 / cordis 4.0.1），不能用作开发期依赖源。

  做法：在插件目录下建 node_modules/，把宿主树的 peer 依赖以 junction 接进来。
  这不是发布内容（已在 .gitignore），换机器或升级 DSH 后重跑本脚本即可。

  用法：pwsh -File scripts/link-dev-deps.ps1 [-Force]
#>
[CmdletBinding()]
param([switch]$Force)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$appNodeModules = Join-Path "D:\Program software\DSH NEXT\resources\app" "node_modules"

$peers = @(
  "@deepseek-ai\schemastery",
  "@deepseek-ai\dsh-tools",
  "@deepseek-ai\dsh-skill-filesystem",
  "@deepseek-ai\cordis",
  "react"
)

$destRoot = Join-Path $projectRoot "node_modules"
New-Item -ItemType Directory -Path $destRoot -Force | Out-Null

$made = 0; $skipped = 0; $missing = @()

foreach ($peer in $peers) {
  $source = Join-Path $appNodeModules $peer
  $dest = Join-Path $destRoot $peer

  if (-not (Test-Path (Join-Path $source "package.json"))) {
    $missing += $peer
    continue
  }
  if (Test-Path $dest) {
    if (-not $Force) { $skipped++; continue }
    Remove-Item $dest -Recurse -Force
  }
  New-Item -ItemType Junction -Path $dest -Target $source -Force | Out-Null
  $ver = (Get-Content (Join-Path $source "package.json") -Raw | ConvertFrom-Json).version
  Write-Host ("  linked {0,-38} v{1}" -f $peer, $ver)
  $made++
}

Write-Host ""
Write-Host ("source : {0}" -f $appNodeModules)
Write-Host ("dest   : {0}" -f $destRoot)
Write-Host ("made={0}  skipped(existing)={1}  missing={2}" -f $made, $skipped, $missing.Count)
if ($missing.Count -gt 0) { Write-Host ("missing: " + ($missing -join ", ")); exit 1 }
exit 0
