$ErrorActionPreference = 'Stop'
$root = 'E:\code\Strata'
$bot = 'E:\code\dingtalk-local-llm-agent-bot'
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script from an Administrator PowerShell window.'
}
$config = Join-Path $root 'strata-iq3_s.json'
$envFile = Join-Path $bot '.env'
$cfg = Get-Content -LiteralPath $config -Raw | ConvertFrom-Json
$headers = @{ Authorization = 'Bearer ' + $cfg.api_key }
function Wait-StrataIdle {
    do {
        $work = (Invoke-RestMethod 'http://127.0.0.1:18907/v1/telemetry' -Headers $headers -TimeoutSec 10).work
        $busy = $work.active -or $work.queued -or $work.admission_reserved
        if ($busy) { Write-Host 'Waiting for existing inference calls...'; Start-Sleep -Seconds 10 }
    } while ($busy)
}
Wait-StrataIdle
# Read-only database check; do not stop a bot that owns unfinished business work.
$check = @'
import sqlite3,sys
from pathlib import Path
p=Path(r'E:\code\dingtalk-local-llm-agent-bot\data\bot.db')
with sqlite3.connect(p.as_uri()+'?mode=ro',uri=True) as db:
    states=('ACCEPTED','QUEUED','RUNNING','REPORTING_INTERRUPTION','WAITING_CONFIRMATION','WAITING_CLARIFICATION')
    n=db.execute('SELECT COUNT(*) FROM agent_runs WHERE status IN ('+','.join('?' for _ in states)+')',states).fetchone()[0]
    n+=db.execute("SELECT COUNT(*) FROM tasks WHERE status NOT IN ('CANCELLED','COMPLETED','EXPIRED','FAILED')").fetchone()[0]
    if n: sys.exit('Bot has unfinished runs; wait before retrying.')
'@
$check | & "$bot\.venv\Scripts\python.exe" -B -
if ($LASTEXITCODE -ne 0) { throw 'Bot idle check failed; nothing changed.' }
Stop-Service -Name DingTalkLocalLLMAgentBot
Wait-StrataIdle
$stamp = Get-Date -Format yyyyMMdd-HHmmss
Copy-Item -LiteralPath $config -Destination "$config.before-four-$stamp"
Copy-Item -LiteralPath $envFile -Destination "$envFile.before-four-$stamp"
$raw = [IO.File]::ReadAllText($config)
if ($cfg.parallel -notin @(2,4)) { throw 'Unexpected parallel setting.' }
$raw = [regex]::Replace($raw, '("parallel"\s*:\s*)[24](?=\s*[,}])', '${1}4')
[IO.File]::WriteAllText($config, $raw, [Text.UTF8Encoding]::new($false))
$envText = [IO.File]::ReadAllText($envFile)
if ($envText -match '(?im)^AGENT_RUNTIME_WORKERS\s*=') {
    $envText = [regex]::Replace($envText, '(?im)^AGENT_RUNTIME_WORKERS\s*=.*$', 'AGENT_RUNTIME_WORKERS=4')
} else { $envText = $envText.TrimEnd() + "`r`nAGENT_RUNTIME_WORKERS=4`r`n" }
[IO.File]::WriteAllText($envFile, $envText, [Text.UTF8Encoding]::new($false))
Stop-ScheduledTask -TaskName Strata-Server
$processes = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'python.exe' -and $_.CommandLine -like '*E:\code\Strata\serve\server.py*' -and $_.CommandLine -like '*strata-iq3_s.json*'
})
$ids = @($processes.ProcessId)
foreach ($process in $processes) {
    if ($process.ParentProcessId -notin $ids) {
        & taskkill.exe /PID $process.ProcessId /T /F
        if ($LASTEXITCODE -ne 0) { throw 'Strata process stop failed.' }
    }
}
Start-ScheduledTask -TaskName Strata-Server
Start-Service -Name DingTalkLocalLLMAgentBot
Write-Host "Restart requested. Backups end with .before-four-$stamp. No inference or business tools were run."
