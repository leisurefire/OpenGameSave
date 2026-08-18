param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedVersion,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedPublisher
)

$ErrorActionPreference = 'Stop'
$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
$versionInfo = (Get-Item -LiteralPath $resolvedInstaller).VersionInfo
if ($versionInfo.ProductVersion -ne $ExpectedVersion) {
    throw "Installer ProductVersion mismatch: expected '$ExpectedVersion', received '$($versionInfo.ProductVersion)'"
}

$signature = Get-AuthenticodeSignature -LiteralPath $resolvedInstaller
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Installer Authenticode signature is not valid: $($signature.Status) $($signature.StatusMessage)"
}
if ($null -eq $signature.SignerCertificate) {
    throw 'Installer signature did not include a signer certificate'
}

$simpleName = $signature.SignerCertificate.GetNameInfo(
    [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
    $false
)
$subject = $signature.SignerCertificate.Subject
if ($ExpectedPublisher -ne $simpleName -and $ExpectedPublisher -ne $subject) {
    throw "Installer signer mismatch: expected '$ExpectedPublisher', received '$simpleName' ($subject)"
}

Write-Output "Verified ProductVersion $ExpectedVersion and Authenticode signer $simpleName"
