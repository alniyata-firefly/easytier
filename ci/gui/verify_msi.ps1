param([Parameter(Mandatory=$true)][string]$MsiPath)
$ErrorActionPreference = 'Stop'
$installer = New-Object -ComObject WindowsInstaller.Installer
$database = $installer.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $installer, @((Resolve-Path $MsiPath).Path, 0))
$properties = @{}
foreach ($name in @('ProductName', 'ProductVersion', 'Manufacturer', 'ProductCode', 'UpgradeCode')) {
    $query = "SELECT ``Value`` FROM ``Property`` WHERE ``Property``='$name'"
    $view = $database.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $database, @($query))
    $view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null) | Out-Null
    $record = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)
    if ($null -eq $record) { throw 'Missing MSI identity property' }
    $properties[$name] = $record.GetType().InvokeMember('StringData', 'GetProperty', $null, $record, @(1))
    $view.GetType().InvokeMember('Close', 'InvokeMethod', $null, $view, $null) | Out-Null
}
$properties | ConvertTo-Json -Compress
