[CmdletBinding()]
param(
    [string]$NodePath = "node",
    [string]$BridgeRoot = (Split-Path -Parent $PSScriptRoot),
    [ValidateRange(1, 300)]
    [int]$BaseDelaySeconds = 2,
    [ValidateRange(1, 300)]
    [int]$MaxDelaySeconds = 30,
    [switch]$Check
)

$ErrorActionPreference = "Stop"
$cliPath = Join-Path $BridgeRoot "dist/cli.js"

if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
    throw "找不到已构建的 CLI：$cliPath。请先运行 npm run build。"
}

& $NodePath --version | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "无法运行 Node.js：$NodePath"
}

if ($Check) {
    Write-Host "PowerShell 保活脚本检查通过：$cliPath"
    exit 0
}

$delaySeconds = $BaseDelaySeconds
while ($true) {
    $startedAt = Get-Date
    & $NodePath $cliPath run
    $exitCode = $LASTEXITCODE

    if ($exitCode -eq 0) {
        Write-Host "唤醒桥已正常停止，不再重启。"
        exit 0
    }

    if ($exitCode -eq 2) {
        Write-Error "唤醒桥因永久配置、认证或协议错误退出，不会自动重启。请修复配置后重新运行。" -ErrorAction Continue
        exit 2
    }

    $uptimeSeconds = ((Get-Date) - $startedAt).TotalSeconds
    if ($uptimeSeconds -ge 60) {
        $delaySeconds = $BaseDelaySeconds
    }

    Write-Warning "唤醒桥意外退出（退出码 $exitCode），将在 $delaySeconds 秒后重启。"
    Start-Sleep -Seconds $delaySeconds
    $delaySeconds = [Math]::Min($delaySeconds * 2, $MaxDelaySeconds)
}
