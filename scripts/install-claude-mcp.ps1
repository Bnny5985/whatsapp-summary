# Adds the read-only "whatsapp-bot" MCP server to Claude Desktop, so Claude can search your
# WhatsApp history, see Tslil's requests, tasks and events. (Remove: run with -Remove.)
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot   # the bot folder (this script lives in scripts\)
$cfgPath = Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host 'Node.js not found in PATH.' -ForegroundColor Red; exit 1 }

if (Test-Path $cfgPath) {
  $raw = Get-Content $cfgPath -Raw -Encoding UTF8
  [IO.File]::WriteAllText("$cfgPath.backup-$(Get-Date -Format yyyyMMdd-HHmmss)", $raw, (New-Object Text.UTF8Encoding $false))
  $cfg = $raw | ConvertFrom-Json
} else {
  New-Item -ItemType Directory -Force -Path (Split-Path $cfgPath) | Out-Null
  $cfg = [pscustomobject]@{}
}
if (-not $cfg.mcpServers) { $cfg | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) }

if ($Remove) {
  $cfg.mcpServers.PSObject.Properties.Remove('whatsapp-bot')
  Write-Host 'Removed the whatsapp-bot MCP server.' -ForegroundColor Yellow
} else {
  $entry = [pscustomobject]@{ command = $node; args = @((Join-Path $Root 'mcp-server.js')) }
  $cfg.mcpServers | Add-Member -NotePropertyName 'whatsapp-bot' -NotePropertyValue $entry -Force
  Write-Host "Added: whatsapp-bot -> $(Join-Path $Root 'mcp-server.js')" -ForegroundColor Green
  Write-Host 'It is read-only: Claude can search and read, never send or delete.'
}
[IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Depth 30), (New-Object Text.UTF8Encoding $false))
Write-Host ''
Write-Host 'Fully quit Claude (tray icon -> Quit) and open it again.' -ForegroundColor Yellow
