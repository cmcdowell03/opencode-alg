#requires -Version 5.1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $root "scripts\manager-cli.ts"

if (Get-Command bun -ErrorAction SilentlyContinue) {
  & bun run $cli @args
  exit $LASTEXITCODE
}
if (Get-Command node -ErrorAction SilentlyContinue) {
  & node --disable-warning=ExperimentalWarning --experimental-strip-types $cli @args
  exit $LASTEXITCODE
}
throw "Install Bun or Node.js 22+ to run the ALG release manager"
