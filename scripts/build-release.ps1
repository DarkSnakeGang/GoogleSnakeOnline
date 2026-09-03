# Build native release binaries

param(
  [string]$Bind = "0.0.0.0:7777"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location "$root\server"
cargo build --release
Write-Host "Built: $root\server\target\release\multiplayer-server.exe"
Write-Host "Run: .\target\release\multiplayer-server.exe --bind $Bind"
Write-Host "Allow firewall TCP port, then share ws://<LAN-IP>:7777/ws"
