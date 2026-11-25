[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PackageDirectory,
    [Parameter(Mandatory)][hashtable]$ApprovedThumbprints
)
$ErrorActionPreference = 'Stop'
$package = Get-Item -LiteralPath $PackageDirectory
$required = @('DueByte.exe', 'cometbft.exe', 'duebyte-abci.exe', 'node.exe')
$executables = @(Get-ChildItem -LiteralPath $package.FullName -Recurse -File -Filter '*.exe')
$failures = @()
foreach ($name in $required) {
    if ($name -notin $executables.Name) { $failures += "Missing executable $name" }
}
foreach ($item in $executables) {
    $sig = Get-AuthenticodeSignature -LiteralPath $item.FullName
    $allowed = @($ApprovedThumbprints[$item.Name])
    $id = $sig.SignerCertificate.Thumbprint
    $accepted = $sig.Status -eq 'Valid' -and $id -and $id -in $allowed
    $relative = $item.FullName.Substring($package.FullName.Length + 1)
    [pscustomobject]@{ File = $relative; Status = $sig.Status; PublisherThumbprint = $id; Accepted = [bool]$accepted }
    if (!$accepted) { $failures += $relative }
}
if ($failures.Count) { throw ("Publisher acceptance failed for " + ($failures -join ', ')) }
