param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class OgsUninstallDialog {
  public delegate bool EnumProc(IntPtr handle, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr parent, int id);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
  public static IntPtr Find(int process) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((window, data) => {
      uint pid; GetWindowThreadProcessId(window, out pid);
      if (pid == process && GetDlgItem(window, 1) != IntPtr.Zero) found = window;
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static IntPtr Checkbox(IntPtr parent) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(parent, (window, data) => {
      var text = new StringBuilder(512); GetWindowText(window, text, text.Capacity);
      if (text.ToString().Contains("keep backups") || text.ToString().Contains("\u4fdd\u7559\u5907\u4efd")) found = window;
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
$uninstaller = Join-Path $Directory 'uninstall.exe'
$process = Start-Process -FilePath $uninstaller -ArgumentList "_?=$Directory" -WindowStyle Hidden -PassThru
$deadline = [DateTime]::UtcNow.AddSeconds(30)
try {
    $window = [IntPtr]::Zero
    $checkbox = [IntPtr]::Zero
    while ($checkbox -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $deadline) {
        $window = [OgsUninstallDialog]::Find($process.Id)
        if ($window -ne [IntPtr]::Zero) { $checkbox = [OgsUninstallDialog]::Checkbox($window) }
        Start-Sleep -Milliseconds 100
    }
    if ($checkbox -eq [IntPtr]::Zero) { throw 'Reset checkbox did not appear in the actual uninstaller dialog.' }
    if ([OgsUninstallDialog]::SendMessage($checkbox, 0xF0, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32() -ne 0) { throw 'Reset must be unchecked by default.' }
    [OgsUninstallDialog]::SendMessage($checkbox, 0xF1, [IntPtr]1, [IntPtr]::Zero) | Out-Null
    [OgsUninstallDialog]::PostMessage($window, 0x111, [IntPtr]1, [OgsUninstallDialog]::GetDlgItem($window, 1)) | Out-Null
    while ((Test-Path -LiteralPath (Join-Path $Directory 'opengamesave.exe')) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if (Test-Path -LiteralPath (Join-Path $Directory 'opengamesave.exe')) { throw 'Uninstaller did not remove the application.' }
    # The last page uses the same button ID for Close.
    while (-not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
        [OgsUninstallDialog]::PostMessage($window, 0x111, [IntPtr]1, [OgsUninstallDialog]::GetDlgItem($window, 1)) | Out-Null
        Start-Sleep -Milliseconds 100
        $process.Refresh()
    }
    if (-not $process.HasExited) { throw 'Uninstaller did not close.' }
    if ($process.ExitCode -ne 0) { throw "Uninstaller failed: $($process.ExitCode)" }
    @{ defaultUnchecked=$true; resetSelected=$true; exitCode=$process.ExitCode } | ConvertTo-Json
} finally {
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
}
