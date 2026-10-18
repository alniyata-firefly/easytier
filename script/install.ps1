<#
.SYNOPSIS
Download and verify this fork's published Windows x64 EasyTier installer.
.DESCRIPTION
Default is download-only. -RunInstaller explicitly starts the verified installer.
Project origin: https://github.com/EasyTier/EasyTier. GNU LGPL v3; see ../LICENSE.
.EXAMPLE
.\install.ps1 -Version v2.7.2 -Directory C:\Downloads\EasyTier -Format nsis
.EXAMPLE
.\install.ps1 -Version fix-2.7.2-product-name-20261018 -Directory C:\Downloads\EasyTier
#>
[CmdletBinding()]
param(
    [string]$Version = 'latest',
    [string]$Directory = (Join-Path (Get-Location) 'easytier-downloads'),
    [ValidateSet('nsis', 'msi')][string]$Format = 'nsis',
    [switch]$RunInstaller
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:Repository = 'alniyata-firefly/easytier'

function Get-ReleaseApiUrl([string]$RequestedVersion) {
    $base = "https://api.github.com/repos/$script:Repository/releases"
    if ($RequestedVersion -eq 'latest') { return "$base/latest" }
    if ($RequestedVersion.Length -le 84 -and $RequestedVersion -cmatch '^fix-\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?$') {
        return "$base/tags/$([Uri]::EscapeDataString($RequestedVersion))"
    }
    if ($RequestedVersion -notmatch '^v?\d+\.\d+\.\d+$') { throw 'Version must be latest, a release version such as v2.7.2, or an explicit fix-2.7.2-* tag' }
    $tag = if ($RequestedVersion.StartsWith('v')) { $RequestedVersion } else { 'v' + $RequestedVersion }
    return "$base/tags/$([Uri]::EscapeDataString($tag))"
}

function Assert-ReleaseAssetUrl($Asset, [string]$Tag) {
    $url = [Uri]$Asset.browser_download_url
    $expected = "/$script:Repository/releases/download/$Tag/$($Asset.name)"
    if ($url.Scheme -cne 'https' -or $url.Host -cne 'github.com' -or $url.UserInfo -or $url.Port -ne 443 `
        -or [Uri]::UnescapeDataString($url.AbsolutePath) -cne $expected -or $url.Query -or $url.Fragment) {
        throw 'Release asset does not belong to this fork'
    }
}

function Select-ReleaseAssets($Release, [string]$InstallerFormat, [string]$RequestedVersion = 'latest') {
    $explicitFix = $RequestedVersion.Length -le 84 -and $RequestedVersion -cmatch '^fix-\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?$'
    if ($Release.draft -ne $false -or ($Release.prerelease -ne $false -and -not ($explicitFix -and $Release.prerelease -eq $true))) {
        throw 'A published stable release or an explicitly requested fix-* prerelease is required'
    }
    $tag = [string]$Release.tag_name
    if ($explicitFix) {
        $fixVersion = [Regex]::Match($tag, '^fix-(\d+\.\d+\.\d+)(?:-|$)')
        if ($tag -cne $RequestedVersion -or -not $fixVersion.Success) { throw 'Unexpected requested prerelease tag' }
        $number = [Regex]::Escape($fixVersion.Groups[1].Value)
    } else {
        if ($tag -cnotmatch '^v\d+\.\d+\.\d+$') { throw 'Unexpected release version tag' }
        $number = [Regex]::Escape($tag.Substring(1))
    }
    $pattern = if ($InstallerFormat -eq 'msi') { '^(?:EasyTier|easytier-gui)_' + $number + '_x64_[A-Za-z0-9-]+\.msi$' } `
               else { '^(?:EasyTier|easytier-gui)_' + $number + '_x64-setup\.exe$' }
    $packages = @($Release.assets | Where-Object { $_.name -cmatch $pattern })
    $checksums = @($Release.assets | Where-Object { $_.name -ceq 'SHA256SUMS' })
    if ($packages.Count -ne 1 -or $checksums.Count -ne 1) { throw 'Release must contain exactly one requested x64 EasyTier installer and SHA256SUMS' }
    Assert-ReleaseAssetUrl $packages[0] $tag
    Assert-ReleaseAssetUrl $checksums[0] $tag
    return @{ Package = $packages[0]; Checksums = $checksums[0] }
}

function Get-ExpectedChecksum([string]$Text, [string]$Name) {
    $hashes = @()
    foreach ($line in ($Text -split '\r?\n')) {
        if ($line -cmatch '^([0-9A-Fa-f]{64}) [ *](.+)$' -and $Matches[2] -ceq $Name) {
            $hashes += $Matches[1].ToLowerInvariant()
        }
    }
    if ($hashes.Count -ne 1) { throw 'SHA256SUMS must contain exactly one entry for the selected installer' }
    return $hashes[0]
}

function Invoke-EasyTierDownload {
    $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    if ($architecture -ne 'AMD64') { throw 'Only the Windows x64 EasyTier installer is currently published by this fork' }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $api = Get-ReleaseApiUrl $Version
    $headers = @{ 'User-Agent' = 'EasyTier-Fork-Installer'; Accept = 'application/vnd.github+json' }
    try { $release = Invoke-RestMethod -Uri $api -Headers $headers }
    catch { throw "No published release could be read from this fork/version. See https://github.com/$script:Repository/releases. There is no upstream fallback." }
    $choice = Select-ReleaseAssets $release $Format $Version
    $destinationDirectory = [IO.Path]::GetFullPath($Directory)
    [IO.Directory]::CreateDirectory($destinationDirectory) | Out-Null
    $destination = Join-Path $destinationDirectory $choice.Package.name
    if (Test-Path -LiteralPath $destination) { throw 'The destination installer already exists; choose another directory. Existing files are never replaced.' }
    $temporary = Join-Path $destinationDirectory ('.easytier-download-' + [Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($temporary) | Out-Null
    try {
        $sums = Join-Path $temporary 'SHA256SUMS'
        Invoke-WebRequest -UseBasicParsing -Uri $choice.Checksums.browser_download_url -Headers $headers -OutFile $sums
        $expected = Get-ExpectedChecksum ([IO.File]::ReadAllText($sums)) $choice.Package.name
        $download = Join-Path $temporary $choice.Package.name
        Invoke-WebRequest -UseBasicParsing -Uri $choice.Package.browser_download_url -Headers $headers -OutFile $download
        if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expected) { throw 'SHA256 verification failed; the installer was not started' }
        [IO.File]::Move($download, $destination)
    } finally { Remove-Item -LiteralPath $temporary -Recurse -Force }
    Write-Host "Verified installer: $destination"
    if ($RunInstaller) {
        $process = if ($Format -eq 'msi') {
            Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', ('"' + $destination + '"')) -Wait -PassThru
        } else { Start-Process -FilePath $destination -Wait -PassThru }
        if ($process.ExitCode -notin @(0, 3010)) { throw "Installer exited with code $($process.ExitCode)" }
    } elseif ($Format -eq 'msi') { Write-Host ('To install: msiexec.exe /i "' + $destination + '"') }
    else { Write-Host ("To install in PowerShell: & '" + $destination.Replace("'", "''") + "'") }
}

if ($MyInvocation.InvocationName -ne '.') {
    try { Invoke-EasyTierDownload }
    catch { Write-Error $_.Exception.Message; exit 1 }
}
