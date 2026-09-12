param(
    [string]$Stage,
    [switch]$PrepareOnly,
    [string]$CleanupAccount
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if (-not $Stage) {
    $repository = Split-Path $PSScriptRoot -Parent
    $version = (Get-Content -LiteralPath (Join-Path $repository 'package.json') -Raw | ConvertFrom-Json).version
    $tauri = Join-Path $repository "src-tauri/target/release/bundle/nsis/OpenGameSave_${version}_x64-setup.exe"
    $electron = Join-Path $repository 'dist/Electron-OpenGameSave-Setup-0.7.3.exe'
    if ((Get-FileHash -LiteralPath $electron -Algorithm SHA256).Hash -ne '72DAC47FEE4DCF686CECF477ABF714C3525A073C5BB8446613A34EA60E758EA3') {
        throw 'Download and verify the documented Electron 0.7.3 installer first.'
    }
    if (-not (Test-Path -LiteralPath $tauri -PathType Leaf)) { throw 'Build the Tauri installer first.' }
    $Stage = Join-Path $env:PUBLIC ('OGSInstallerVerification-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $Stage | Out-Null
    foreach ($folder in @('scripts', 'dist', 'node_modules')) {
        New-Item -ItemType Directory -Path (Join-Path $Stage $folder) | Out-Null
    }
    foreach ($script in @('smoke-tauri.cjs', 'verify-windows-installer.cjs', 'verify-windows-isolated.ps1', 'verify-uninstall-dialog.ps1')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $script) -Destination (Join-Path $Stage 'scripts')
    }
    foreach ($module in @('better-sqlite3', 'bindings', 'file-uri-to-path')) {
        Copy-Item -LiteralPath (Join-Path $repository "node_modules/$module") -Destination (Join-Path $Stage 'node_modules') -Recurse
    }
    Copy-Item -LiteralPath (Join-Path $repository 'database') -Destination $Stage -Recurse
    Copy-Item -LiteralPath (Join-Path $repository 'THIRD_PARTY_NOTICES.md') -Destination $Stage
    Copy-Item -LiteralPath $tauri -Destination (Join-Path $Stage 'dist/tauri-setup.exe')
    Copy-Item -LiteralPath $electron -Destination (Join-Path $Stage 'dist/electron-setup.exe')
    @{ stage=$Stage; node=(Get-Command node.exe).Source; tauriSha256=(Get-FileHash -LiteralPath $tauri -Algorithm SHA256).Hash } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Stage 'stage.json') -Encoding UTF8
    # No passwords, account tokens or user data are copied into this directory.
    Write-Output $Stage
    if ($PrepareOnly) { return }
    $helper = Join-Path $Stage 'scripts/verify-windows-isolated.ps1'
    $coordinator = Start-Process -FilePath "$env:SystemRoot/System32/WindowsPowerShell/v1.0/powershell.exe" -Verb RunAs -WindowStyle Hidden -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$helper`"", '-Stage', "`"$Stage`""
    ) -PassThru
    if (-not $coordinator.WaitForExit(960000)) { throw "Coordinator timed out. Inspect $Stage before retrying." }
    $resultPath = Join-Path $Stage 'isolated-result.json'
    $completed = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    if (-not $completed.passed -or -not $completed.accountRemoved -or -not $completed.profileRemoved) {
        throw "Isolated verification or cleanup failed. Inspect $resultPath"
    }
    Write-Output "PASS: $resultPath"
    return
}

# Elevation is only used for account lifecycle and ACLs, never for the installer.
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Windows administrator approval is required to create a temporary standard test account.'
}
$Stage = [IO.Path]::GetFullPath($Stage)
$publicRoot = [IO.Path]::GetFullPath($env:PUBLIC).TrimEnd('\')
if ((Split-Path $Stage -Parent) -ne $publicRoot -or (Split-Path $Stage -Leaf) -notmatch '^OGSInstallerVerification-[0-9a-f]{32}$') {
    throw 'Unexpected staging directory.'
}
if ((Get-Item -LiteralPath $Stage).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Stage must not be a junction.' }
$manifest = Get-Content -LiteralPath (Join-Path $Stage 'stage.json') -Raw | ConvertFrom-Json
$result = [ordered]@{ startedAt=[DateTime]::UtcNow.ToString('o'); stage=$Stage; passed=$false; accountRemoved=$false; profileRemoved=$false }
$account = $null
$process = $null
try {
    if ($CleanupAccount) {
        $account = Get-LocalUser -Name $CleanupAccount
        if ($account.Name -notmatch '^OGSVerify[0-9a-f]{10}$' -or $account.Description -ne 'Temporary OpenGameSave installer verification') {
            $account = $null
            throw 'Refusing to clean up an account not created for this test.'
        }
        $name = $account.Name
        $result.cleanupOnly = $true
    } else {
    $name = 'OGSVerify' + [guid]::NewGuid().ToString('N').Substring(0, 10)
    $password = ConvertTo-SecureString ('OGS!aA1' + [guid]::NewGuid().ToString('N')) -AsPlainText -Force
    $account = New-LocalUser -Name $name -Password $password -Description 'Temporary OpenGameSave installer verification' -AccountNeverExpires
    $users = Get-LocalGroup -SID 'S-1-5-32-545'
    Add-LocalGroupMember -Group $users -Member $account
    $result.accountSid = $account.SID.Value
    $acl = Get-Acl -LiteralPath $Stage
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($account.SID, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    Set-Acl -LiteralPath $Stage -AclObject $acl
    # The child runner is a file: neither credentials nor fixture paths are
    # interpolated into a shell command string or exposed on a command line.
    $runner = @'
$ErrorActionPreference = 'Stop'
$stage = $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $stage 'stage.json') -Raw | ConvertFrom-Json
Set-Location -LiteralPath $stage
try {
    $nodeRun = Start-Process -FilePath $manifest.node -ArgumentList @('scripts/verify-windows-installer.cjs', '--run', '--installer', 'dist/tauri-setup.exe', '--electron', 'dist/electron-setup.exe') -WorkingDirectory $stage -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $stage 'test-output.log') -RedirectStandardError (Join-Path $stage 'test-errors.log')
    $code = $nodeRun.ExitCode
} catch {
    $_ | Out-String | Add-Content -LiteralPath (Join-Path $stage 'test-output.log')
    $code = 1
}
@{ exitCode=$code; finishedAt=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'child-result.json')
exit $code
'@
    Set-Content -LiteralPath (Join-Path $Stage 'run-test.ps1') -Value $runner -Encoding UTF8
    $credential = [PSCredential]::new("$env:COMPUTERNAME\$name", $password)
    $process = Start-Process -FilePath "$env:SystemRoot/System32/WindowsPowerShell/v1.0/powershell.exe" -Credential $credential -LoadUserProfile -WindowStyle Hidden -WorkingDirectory $Stage -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$(Join-Path $Stage 'run-test.ps1')`""
    ) -PassThru
    if (-not $process.WaitForExit(900000)) { throw 'Isolated verification timed out after 15 minutes.' }
    $childResult = Get-Content -LiteralPath (Join-Path $Stage 'child-result.json') -Raw | ConvertFrom-Json
    $result.exitCode = $childResult.exitCode
    $result.passed = $childResult.exitCode -eq 0
    }
} catch {
    $result.error = $_.Exception.Message
} finally {
    try {
    if ($account) {
        # Query process tokens directly, avoiding a slow WMI call for every
        # unrelated system process. The account name was created by this run.
        Get-Process -IncludeUserName -ErrorAction SilentlyContinue |
            Where-Object { $_.UserName -eq "$env:COMPUTERNAME\$name" } |
            Stop-Process -Force -ErrorAction SilentlyContinue
        Remove-LocalUser -SID $account.SID
        $result.accountRemoved = $true
        $profile = Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $account.SID.Value }
        if ($profile) {
            $profilePath = [IO.Path]::GetFullPath($profile.LocalPath)
            $usersRoot = [IO.Path]::GetFullPath((Join-Path $env:SystemDrive 'Users'))
            if ((Split-Path $profilePath -Parent) -eq $usersRoot -and (Split-Path $profilePath -Leaf) -eq $name -and -not $profile.Special) {
                # Retain test profile evidence before removing only this known profile.
                $data = Join-Path $profilePath 'AppData/Roaming/opengamesave'
                if (Test-Path -LiteralPath $data) { Copy-Item -LiteralPath $data -Destination (Join-Path $Stage 'retained-user-data') -Recurse }
                $defaultBackups = Join-Path $profilePath 'AppData/Roaming/OGS Backups'
                if (Test-Path -LiteralPath $defaultBackups) { Copy-Item -LiteralPath $defaultBackups -Destination (Join-Path $Stage 'retained-default-backups') -Recurse }
                $profile | Remove-CimInstance
                $result.profileRemoved = $true
            } else { $result.cleanupError = 'Unexpected profile path; retained for inspection.' }
        }
    }
    } catch { $result.cleanupError = $_.Exception.Message; $result.passed = $false }
    $result.finishedAt = [DateTime]::UtcNow.ToString('o')
    $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Stage 'isolated-result.json') -Encoding UTF8
}
