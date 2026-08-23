#requires -Version 5.1
[CmdletBinding()]
param(
  [string]$ConfigDir = "",
  [switch]$SkipAgents,
  [switch]$ForceAgents,
  [switch]$UpdateAgents,
  [switch]$Uninstall,
  [switch]$RemoveAgents
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if (-not $ConfigDir) {
  $ConfigDir = Join-Path $env:USERPROFILE ".config\opencode"
}

$coreArgs = @("--config-dir", $ConfigDir)
if ($SkipAgents) { $coreArgs += "--skip-agents" }
if ($ForceAgents -or $UpdateAgents) { $coreArgs += "--force-agents" }
if ($Uninstall) { $coreArgs += "--uninstall" }
if ($RemoveAgents) { $coreArgs += "--remove-agents" }

Push-Location $root
try {
  if (Get-Command bun -ErrorAction SilentlyContinue) {
    if (-not (Test-Path -LiteralPath (Join-Path $root "bun.lock"))) { throw "bun.lock is required for frozen dependency installation" }
    & bun install --frozen-lockfile --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw "frozen Bun install failed ($LASTEXITCODE)" }
    & bun run "scripts/installer-core.ts" @coreArgs
    if ($LASTEXITCODE -ne 0) { throw "ALG installer failed ($LASTEXITCODE)" }
  } elseif (Get-Command npm -ErrorAction SilentlyContinue) {
    if (-not (Test-Path -LiteralPath (Join-Path $root "package-lock.json"))) { throw "package-lock.json is required for npm ci" }
    & npm ci --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed ($LASTEXITCODE)" }
    & npx --no-install tsx "scripts/installer-core.ts" @coreArgs
    if ($LASTEXITCODE -ne 0) { throw "ALG installer failed ($LASTEXITCODE)" }
  } else {
    throw "Install Bun or Node.js/npm before installing ALG"
  }
} finally {
  Pop-Location
}
