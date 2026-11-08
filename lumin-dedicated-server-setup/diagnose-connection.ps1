param([string]$PublicUrl = 'https://desktop-qqh9t0j.tailf46d13.ts.net')

# Read-only diagnostics. Do not print configuration keys, patient files or logs.
$ErrorActionPreference = 'Stop'
$diagPort = 5000
$diagConfigPath = Join-Path $PSScriptRoot 'config.json'
if (Test-Path -LiteralPath $diagConfigPath) {
    try {
        $diagConfig = Get-Content -LiteralPath $diagConfigPath -Raw | ConvertFrom-Json
        if ($diagConfig.port -and [int]$diagConfig.port -ge 1 -and [int]$diagConfig.port -le 65535) {
            $diagPort = [int]$diagConfig.port
        }
    } catch { Write-Host 'Could not read the configured port; checking port 5000.' }
}

function Test-LuminEndpoint([string]$Label, [string]$BaseUrl) {
    $diagTimer = [Diagnostics.Stopwatch]::StartNew()
    try {
        $diagHealth = Invoke-RestMethod -Uri ($BaseUrl.TrimEnd('/') + '/api/health') -TimeoutSec 12
        $diagHealthy = $diagHealth.status -eq 'online' -and $diagHealth.service -eq 'Lumin Local Storage Server'
        $diagResult = if ($diagHealthy) { 'ONLINE' } else { 'UNEXPECTED RESPONSE' }
        Write-Host ("{0}: {1} ({2:N1} seconds)" -f $Label, $diagResult, $diagTimer.Elapsed.TotalSeconds)
        if ($diagHealthy -and $diagHealth.syncProtocol -ne 1) {
            Write-Host '  Sync support is missing. Update and restart this server before pairing.'
        }
        return $diagHealthy
    } catch {
        Write-Host ("{0}: UNREACHABLE ({1:N1} seconds)" -f $Label, $diagTimer.Elapsed.TotalSeconds)
        Write-Host ('  ' + $_.Exception.Message)
        return $false
    }
}

Write-Host 'Lumin storage connection check (read-only)'
Write-Host ('Time: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'))
Write-Host ''
$diagLocalOnline = Test-LuminEndpoint 'Local server' ("http://127.0.0.1:{0}" -f $diagPort)
$diagPublicOnline = Test-LuminEndpoint 'Public connection' $PublicUrl
Write-Host ''
Write-Host 'Tailscale Funnel status:'
$diagTailscale = Get-Command tailscale.exe -ErrorAction SilentlyContinue
if ($diagTailscale) {
    & $diagTailscale.Source funnel status
} else { Write-Host 'Tailscale was not found in PATH.' }
Write-Host ''
if ($diagLocalOnline -and $diagPublicOnline) {
    Write-Host 'Both connections work now. Run this check again DURING a Lumin disconnect.'
} elseif ($diagLocalOnline) {
    Write-Host 'The Python server works locally. The public Tailscale connection needs checking.'
} elseif ($diagPublicOnline) {
    Write-Host 'The public server works. Check that this tool is running on the dedicated PC in its server folder.'
} else {
    Write-Host 'The local server is unreachable. Check its running launcher and server.log on this PC.'
}
Write-Host 'Send the result above to troubleshoot; it contains no patient files or clinic keys.'
