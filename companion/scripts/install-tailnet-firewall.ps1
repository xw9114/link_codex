[CmdletBinding()]
param(
  [int]$Port = 9443,
  [string]$RulePrefix = 'CodexLink Tailnet'
)

$ErrorActionPreference = 'Stop'

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this script from an elevated PowerShell prompt.'
}

$tailscale = Get-Command tailscale.exe -ErrorAction Stop
$ipv4 = @(& $tailscale.Source ip -4 2>$null | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ })
$ipv6 = @(& $tailscale.Source ip -6 2>$null | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ })
$tailIps = @($ipv4 + $ipv6 | Where-Object {
  $_ -match '^100\.(6[4-9]|[78][0-9]|9[0-9]|1[01][0-9]|12[0-7])\.(25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})\.(25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})$' -or
  $_ -match '^fd7a:115c:a1e0:[0-9a-f:]+$'
})
if ($tailIps.Count -eq 0) {
  throw 'Tailscale did not report a Tailnet CGNAT or ULA address. Is Tailscale running?'
}
$tailIp = $tailIps[0]

$tailnetRanges = @('100.64.0.0/10', 'fd7a:115c:a1e0::/48')
$tailscaleAdapters = @(Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match 'Tailscale' -or $_.InterfaceDescription -match 'Tailscale' } |
  Select-Object -ExpandProperty Name)

Get-NetFirewallRule -DisplayName "$RulePrefix*" -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule -ErrorAction SilentlyContinue

$common = @{
  Direction = 'Inbound'
  Action = 'Allow'
  Protocol = 'TCP'
  LocalPort = $Port
  RemoteAddress = $tailnetRanges
  Profile = 'Any'
}
if ($tailscaleAdapters.Count -gt 0) {
  New-NetFirewallRule -DisplayName "$RulePrefix - interface" @common `
    -InterfaceAlias $tailscaleAdapters | Out-Null
}
foreach ($address in $tailIps) {
  New-NetFirewallRule -DisplayName "$RulePrefix - address $address" @common `
    -LocalAddress $address | Out-Null
}

Write-Output "CodexLink firewall enabled for $($tailIps -join ', ')`:$Port on Tailnet sources."
