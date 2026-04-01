# Launch Claude CLI through llm-agent SmartServer.
#
# The server starts in the background, Claude CLI connects via ANTHROPIC_BASE_URL,
# and the server stops when Claude exits.
#
# Usage:
#   .\tools\claude-via-agent.ps1                          # uses defaults from .env
#   $env:LLM_MODEL="gpt-4o"; .\tools\claude-via-agent.ps1  # override model
#
# Required environment (set in .env or before running):
#   LLM_PROVIDER  — openai | anthropic | deepseek | sap-ai-sdk
#   LLM_API_KEY   — provider API key (or AICORE_SERVICE_KEY for sap-ai-sdk)
#   LLM_MODEL     — model name as the provider expects
#
# Optional:
#   MCP_ENDPOINT  — MCP server URL (default: none)
#   PORT          — llm-agent port (default: 4004)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir

# Load .env if present
$EnvFile = Join-Path $ProjectDir ".env"
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#")) {
            $parts = $line -split "=", 2
            if ($parts.Length -eq 2) {
                [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), "Process")
            }
        }
    }
}

$Port = if ($env:PORT) { $env:PORT } else { "4004" }
$AgentProcess = $null

try {
    # Start llm-agent in background
    Write-Host "Starting llm-agent on port $Port..."
    $AgentProcess = Start-Process -FilePath "npx" -ArgumentList "llm-agent" `
        -WorkingDirectory $ProjectDir -PassThru -NoNewWindow

    # Wait for server to be ready
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        if ($AgentProcess.HasExited) {
            Write-Error "llm-agent failed to start"
            exit 1
        }
        try {
            $null = Invoke-RestMethod -Uri "http://localhost:$Port/v1/models" -TimeoutSec 2
            $ready = $true
            break
        } catch {
            Start-Sleep -Seconds 1
        }
    }

    if (-not $ready) {
        Write-Error "llm-agent did not become ready in 30 seconds"
        exit 1
    }

    Write-Host "llm-agent ready. Launching Claude CLI..."
    Write-Host ""

    # Launch Claude CLI pointing to llm-agent
    $env:ANTHROPIC_BASE_URL = "http://localhost:$Port"
    if (-not $env:ANTHROPIC_API_KEY) {
        $env:ANTHROPIC_API_KEY = "placeholder"
    }
    & claude @args
}
finally {
    # Stop llm-agent
    if ($AgentProcess -and -not $AgentProcess.HasExited) {
        Stop-Process -Id $AgentProcess.Id -Force -ErrorAction SilentlyContinue
        $AgentProcess.WaitForExit(5000) | Out-Null
    }
}
