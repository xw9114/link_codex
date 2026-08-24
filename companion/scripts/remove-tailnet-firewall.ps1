[CmdletBinding()]
param([string]$RulePrefix = 'CodexLink Tailnet')

$ErrorActionPreference = 'Stop'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this script from an elevated PowerShell prompt.'
}

Get-NetFirewallRule -DisplayName "$RulePrefix*" -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule -ErrorAction SilentlyContinue
Write-Output 'CodexLink Tailnet firewall rules removed.'
