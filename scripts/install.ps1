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
    & bun install
    if ($LASTEXITCODE -ne 0) { throw "bun install failed ($LASTEXITCODE)" }
    & bun run "scripts/installer-core.ts" @coreArgs
    if ($LASTEXITCODE -ne 0) { throw "ALG installer failed ($LASTEXITCODE)" }
  } elseif (Get-Command npm -ErrorAction SilentlyContinue) {
    & npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed ($LASTEXITCODE)" }
    & npx --no-install tsx "scripts/installer-core.ts" @coreArgs
    if ($LASTEXITCODE -ne 0) { throw "ALG installer failed ($LASTEXITCODE)" }
  } else {
    throw "Install Bun or Node.js/npm before installing ALG"
  }
} finally {
  Pop-Location
}
