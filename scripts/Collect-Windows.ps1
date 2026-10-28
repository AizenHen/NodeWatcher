#requires -Version 5.1
<#
.SYNOPSIS
Collects read-only Windows and optional Active Directory diagnostics for NodeWatcher.
.EXAMPLE
.\Collect-Windows.ps1 -ServerId my-dc-01 -DomainController -DnsName example.test
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-zA-Z0-9_-]+$')][string]$ServerId,
    [string]$DnsName = $env:COMPUTERNAME,
    [switch]$DomainController,
    [string[]]$RequiredServices = @('EventLog', 'W32Time'),
    [ValidateRange(1, 100)][int]$DiskWarningPercent = 80,
    [ValidateRange(1, 100)][int]$DiskCriticalPercent = 95,
    [string]$OutputPath = './reports/windows-health.json'
)
$ErrorActionPreference = 'Stop'
if ($DiskWarningPercent -ge $DiskCriticalPercent) { throw 'Disk warning threshold must be below critical threshold.' }
$checks = [System.Collections.Generic.List[object]]::new()
function Add-Check([string]$Name, [string]$Status, [string]$Message, [string]$Category = 'system') {
    if ([string]::IsNullOrWhiteSpace($Message)) { $Message = 'The diagnostic returned no details. Inspect this check manually.' }
    $checks.Add([ordered]@{ name = $Name; status = $Status; message = $Message.Substring(0, [Math]::Min($Message.Length, 1900)); category = $Category })
}
function Invoke-Diagnostic([string]$Executable, [string]$Arguments, [int]$TimeoutSeconds = 90) {
    $command = Get-Command $Executable -ErrorAction Stop
    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $command.Source
    $info.Arguments = $Arguments
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $info
    try {
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill()
            throw "$Executable timed out after $TimeoutSeconds seconds."
        }
        $process.WaitForExit()
        return [pscustomobject]@{ ExitCode = $process.ExitCode; Output = ($stdout.Result + "`n" + $stderr.Result).Trim() }
    } finally { $process.Dispose() }
}
try {
    $records = Resolve-DnsName -Name $DnsName -DnsOnly -QuickTimeout -ErrorAction Stop
    $addresses = @($records | Where-Object { $_.IPAddress } | ForEach-Object { $_.IPAddress })
    if ($addresses.Count -eq 0) { Add-Check 'DNS resolution' 'warning' "No A/AAAA answers returned for $DnsName" 'network' }
    else { Add-Check 'DNS resolution' 'healthy' "$DnsName resolves to $($addresses -join ', ')" 'network' }
} catch { Add-Check 'DNS resolution' 'critical' $_.Exception.Message 'network' }
try {
    $disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3')
    if ($disks.Count -eq 0) { Add-Check 'Disk capacity' 'unknown' 'No fixed disks were returned.' }
    foreach ($disk in $disks) {
        if (-not $disk.Size) { Add-Check "Disk $($disk.DeviceID)" 'unknown' 'Disk capacity is unavailable.'; continue }
        $used = [Math]::Round(100 * (1 - $disk.FreeSpace / $disk.Size), 1)
        $status = if ($used -ge $DiskCriticalPercent) { 'critical' } elseif ($used -ge $DiskWarningPercent) { 'warning' } else { 'healthy' }
        Add-Check "Disk $($disk.DeviceID)" $status "$used% used; $([Math]::Round($disk.FreeSpace / 1GB, 1)) GiB free. Warning: $DiskWarningPercent%; critical: $DiskCriticalPercent%."
    }
} catch { Add-Check 'Disk capacity' 'unknown' $_.Exception.Message }
$serviceNames = @($RequiredServices)
if ($DomainController) { $serviceNames += @('NTDS', 'DNS', 'Netlogon', 'DFSR', 'Kdc') }
foreach ($name in ($serviceNames | Select-Object -Unique)) {
    try {
        $service = Get-Service -Name $name -ErrorAction Stop
        $status = if ($service.Status -eq 'Running') { 'healthy' } else { 'critical' }
        Add-Check "Service $name" $status "$($service.DisplayName): $($service.Status)"
    } catch { Add-Check "Service $name" 'unknown' $_.Exception.Message }
}
try {
    # Numeric leap indicator avoids depending on localized w32tm field names.
    $time = Invoke-Diagnostic 'w32tm.exe' '/query /status'
    if ($time.ExitCode -ne 0) { Add-Check 'Time synchronization' 'warning' $time.Output 'time' }
    elseif ($time.Output -match '^\s*[^:\r\n]+:\s*3\s*\(') { Add-Check 'Time synchronization' 'critical' 'Windows Time reports leap indicator 3 (not synchronized).' 'time' }
    elseif ($time.Output -match '^\s*[^:\r\n]+:\s*[012]\s*\(') { Add-Check 'Time synchronization' 'healthy' $time.Output 'time' }
    else { Add-Check 'Time synchronization' 'unknown' "w32tm output could not be interpreted. Inspect manually: $($time.Output)" 'time' }
} catch { Add-Check 'Time synchronization' 'unknown' $_.Exception.Message 'time' }
if ($DomainController) {
    try {
        Import-Module ActiveDirectory -ErrorAction Stop
        $partners = @(Get-ADReplicationPartnerMetadata -Target $env:COMPUTERNAME -Scope Server -ErrorAction Stop)
        if ($partners.Count -eq 0) { Add-Check 'AD replication' 'unknown' 'No replication partners found. Verify whether this is a single-DC domain.' 'ad' }
        else {
            $failed = @($partners | Where-Object { $_.ConsecutiveReplicationFailures -gt 0 -or $_.LastReplicationResult -ne 0 })
            $stale = @($partners | Where-Object { -not $_.LastReplicationSuccess -or $_.LastReplicationSuccess -lt (Get-Date).AddHours(-24) })
            if ($failed.Count) { Add-Check 'AD replication' 'critical' (($failed | ForEach-Object { "$($_.Partner): result $($_.LastReplicationResult), $($_.ConsecutiveReplicationFailures) consecutive failures" }) -join '; ') 'ad' }
            elseif ($stale.Count) { Add-Check 'AD replication' 'warning' "$($stale.Count) partner records have no successful replication within 24 hours." 'ad' }
            else { Add-Check 'AD replication' 'healthy' "$($partners.Count) replication partner records report successful replication within 24 hours." 'ad' }
        }
    } catch { Add-Check 'AD replication' 'unknown' "ActiveDirectory module and replication permissions are required: $($_.Exception.Message)" 'ad' }
    try {
        $diagnostic = Invoke-Diagnostic 'dcdiag.exe' '/q' 120
        if ($diagnostic.ExitCode -eq 0 -and [string]::IsNullOrWhiteSpace($diagnostic.Output)) { Add-Check 'Domain controller diagnostics' 'healthy' 'DCDiag /q completed with no diagnostic errors.' 'ad' }
        elseif ($diagnostic.ExitCode -ne 0) { Add-Check 'Domain controller diagnostics' 'critical' "DCDiag exit code $($diagnostic.ExitCode): $($diagnostic.Output)" 'ad' }
        else { Add-Check 'Domain controller diagnostics' 'warning' $diagnostic.Output 'ad' }
    } catch { Add-Check 'Domain controller diagnostics' 'unknown' $_.Exception.Message 'ad' }
}
$userSnapshot = [ordered]@{ status = 'unavailable'; scope = 'Windows console user only; remote desktop sessions are not included'; sessions = @() }
try {
    $computer = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
    if (-not $computer) { throw 'Computer system data unavailable.' }
    if ($computer.UserName) {
        $userSnapshot.sessions = @([ordered]@{ user = [string]$computer.UserName; connection = 'Console (may be locked)' })
    }
    $userSnapshot.status = 'collected'
} catch { $userSnapshot.status = 'unavailable' }
$document = [ordered]@{ version = 1; results = @([ordered]@{ serverId = $ServerId; checkedAt = [DateTime]::UtcNow.ToString('o'); userSnapshot = $userSnapshot; checks = @($checks.ToArray()) }) }
$destination = [System.IO.Path]::GetFullPath($OutputPath)
[void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($destination))
[System.IO.File]::WriteAllText($destination, ($document | ConvertTo-Json -Depth 8), [System.Text.UTF8Encoding]::new($false))
Write-Host "NodeWatcher: wrote $($checks.Count) checks to $destination"
