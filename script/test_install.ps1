# Local in-memory fixtures only; dot-sourcing does not run the downloader.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/install.ps1"
function Assert-Fixture($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Assert-Fails([scriptblock]$Action) {
    $failed = $false
    try { & $Action | Out-Null } catch { $failed = $true }
    if (-not $failed) { throw 'Invalid fixture was unexpectedly accepted' }
}
function New-Asset([string]$Name) {
    return @{ name = $Name; browser_download_url = "https://github.com/alniyata-firefly/easytier/releases/download/v2.7.2/$Name" }
}
$nsis = New-Asset 'easytier-gui_2.7.2_x64-setup.exe'
$msi = New-Asset 'easytier-gui_2.7.2_x64_en-US.msi'
$release = @{ tag_name = 'v2.7.2'; draft = $false; prerelease = $false; assets = @($nsis, $msi, (New-Asset 'SHA256SUMS')) }
Assert-Fixture ((Select-ReleaseAssets $release 'nsis').Package.name -ceq $nsis.name) 'NSIS selection failed'
Assert-Fixture ((Select-ReleaseAssets $release 'msi').Package.name -ceq $msi.name) 'MSI selection failed'
$branded = $release.Clone()
$branded.assets = @((New-Asset 'EasyTier_2.7.2_x64-setup.exe'), (New-Asset 'EasyTier_2.7.2_x64_en-US.msi'), (New-Asset 'SHA256SUMS'))
Assert-Fixture ((Select-ReleaseAssets $branded 'nsis').Package.name -ceq 'EasyTier_2.7.2_x64-setup.exe') 'EasyTier NSIS selection failed'
Assert-Fixture ((Select-ReleaseAssets $branded 'msi').Package.name -ceq 'EasyTier_2.7.2_x64_en-US.msi') 'EasyTier MSI selection failed'
$mixed = $branded.Clone(); $mixed.assets += $nsis
Assert-Fails { Select-ReleaseAssets $mixed 'nsis' }
$fixTag = 'fix-2.7.2-product-name-20261018'
$fix = $branded.Clone(); $fix.tag_name = $fixTag; $fix.prerelease = $true
$fix.assets = @($branded.assets | ForEach-Object { @{ name = $_.name; browser_download_url = $_.browser_download_url.Replace('/v2.7.2/', "/$fixTag/") } })
Assert-Fixture ((Get-ReleaseApiUrl $fixTag).EndsWith("/tags/$fixTag")) 'Explicit prerelease API URL failed'
Assert-Fixture ((Select-ReleaseAssets $fix 'nsis' $fixTag).Package.name -ceq 'EasyTier_2.7.2_x64-setup.exe') 'Explicit EasyTier prerelease selection failed'
Assert-Fails { Select-ReleaseAssets $fix 'nsis' }
Assert-Fails { Select-ReleaseAssets $fix 'nsis' 'fix-2.7.2-other' }
$draft = $fix.Clone(); $draft.draft = $true
Assert-Fails { Select-ReleaseAssets $draft 'nsis' $fixTag }
Assert-Fixture ((Get-ReleaseApiUrl '2.7.2').EndsWith('/tags/v2.7.2')) 'Version normalization failed'
$hash = 'a' * 64
Assert-Fixture ((Get-ExpectedChecksum ("$hash  " + $nsis.name) $nsis.name) -ceq $hash) 'Checksum selection failed'
Assert-Fails { Get-ExpectedChecksum ("$hash  other.exe") $nsis.name }
Assert-Fails { Get-ExpectedChecksum (("$hash  " + $nsis.name + "`n") * 2) $nsis.name }
Assert-Fails { Get-ReleaseApiUrl '../../upstream' }
$ambiguous = $release.Clone(); $ambiguous.assets += $nsis
Assert-Fails { Select-ReleaseAssets $ambiguous 'nsis' }
$prerelease = $release.Clone(); $prerelease.prerelease = $true
Assert-Fails { Select-ReleaseAssets $prerelease 'nsis' }
$upstream = @{ name = $nsis.name; browser_download_url = $nsis.browser_download_url.Replace('alniyata-firefly/easytier', 'EasyTier/EasyTier') }
Assert-Fails { Assert-ReleaseAssetUrl $upstream 'v2.7.2' }
Write-Host 'Windows release selection/checksum fixtures PASS; no download or installation performed.'
