; electron-builder UUID v5 for com.leisurefire.opengamesave. Do not discover
; uninstallers by display name or execute arbitrary registry command strings.
!define OGS_ELECTRON_ID "4cc94751-e365-5f27-95ea-388f4d0e40fc"
!define OGS_ELECTRON_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${OGS_ELECTRON_ID}"
Var OgsLegacyDir
Var OgsLegacyResult
Var OgsLegacyLaunchFailed
Var OgsLegacyAutostart
Var OgsAssociationBackup
Var OgsAssociationAtUninstall
Var OgsDiagnosticMode

!macro OGS_TRACE MESSAGE
  ${If} $OgsDiagnosticMode = 1
    FileOpen $9 "$EXEDIR\OpenGameSave-installer.log" a
    ${IfNot} ${Errors}
      FileSeek $9 0 END
      FileWrite $9 "${MESSAGE}$\r$\n"
      FileClose $9
    ${EndIf}
  ${EndIf}
!macroend

; Silent installers otherwise return only exit code 1, hiding the actionable
; reason. Keep a per-user diagnostic with fixed messages (no settings/secrets).
!macro OGS_ABORT MESSAGE
  !insertmacro OGS_TRACE "ERROR: ${MESSAGE}"
  FileOpen $9 "$TEMP\OpenGameSave-installer-error.log" w
  IfErrors +3 0
    FileWrite $9 "${MESSAGE}$\r$\n"
    FileClose $9
  Abort "${MESSAGE}"
!macroend

!macro NSIS_HOOK_PREINSTALL
  ${GetOptions} $CMDLINE "/OGSLOG" $OgsDiagnosticMode
  ${IfNot} ${Errors}
    StrCpy $OgsDiagnosticMode 1
  ${EndIf}
  !insertmacro OGS_TRACE "Preinstall started"
  Delete "$TEMP\OpenGameSave-installer-error.log"
  ; This distribution is per-user. Never silently remove a machine-wide app.
  ReadRegStr $0 HKLM "${OGS_ELECTRON_KEY}" "UninstallString"
  ${If} $0 != ""
    !insertmacro OGS_TRACE "Electron registration detected"
    SetErrorLevel 1
    !insertmacro OGS_ABORT "Uninstall the all-users Electron version first, keeping its app data, then run this installer again."
  ${EndIf}
  ReadRegStr $0 HKCU "${OGS_ELECTRON_KEY}" "UninstallString"
  ${If} $0 != ""
    ReadRegStr $OgsLegacyDir HKCU "Software\${OGS_ELECTRON_ID}" "InstallLocation"
    ReadRegStr $1 HKCU "${OGS_ELECTRON_KEY}" "Publisher"
    ${If} $OgsLegacyDir == ""
    ${OrIf} $1 != "leisurefire"
      SetErrorLevel 1
      !insertmacro OGS_ABORT "Cannot verify the previous Electron installation. Uninstall it manually, keeping app data."
    ${EndIf}
    ; Match the exact command written by electron-builder, including its scope.
    ${If} $0 != '$\"$OgsLegacyDir\Uninstall OpenGameSave.exe$\" /currentuser'
      SetErrorLevel 1
      !insertmacro OGS_ABORT "Unexpected Electron uninstall command. Uninstall it manually, keeping app data."
    ${EndIf}
    ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OpenGameSave"
    ${If} $1 == '$\"$OgsLegacyDir\OpenGameSave.exe$\"'
    ${OrIf} $1 == '$OgsLegacyDir\OpenGameSave.exe'
      StrCpy $OgsLegacyAutostart 1
    ${EndIf}
    ${IfNot} ${FileExists} "$OgsLegacyDir\Uninstall OpenGameSave.exe"
      SetErrorLevel 1
      !insertmacro OGS_ABORT "The Electron uninstaller is missing. Repair or uninstall that installation first."
    ${EndIf}
    ; Fail rather than force-kill a backup/restore operation in the old runtime.
    nsis_tauri_utils::FindProcessCurrentUser "OpenGameSave.exe"
    Pop $1
    ${If} $1 = 0
      SetErrorLevel 1
      !insertmacro OGS_ABORT "Close OpenGameSave before upgrading from Electron."
    ${EndIf}
    SetOutPath $TEMP
    !insertmacro OGS_TRACE "Invoking Electron uninstaller"
    ; Match electron-builder's upgrade protocol: run a copy outside the old
    ; application directory. In-place --updated uninstall can fail because
    ; that directory (including the running uninstaller) must be removed.
    InitPluginsDir
    ClearErrors
    CopyFiles /SILENT "$OgsLegacyDir\Uninstall OpenGameSave.exe" "$PLUGINSDIR\ogs-electron-uninstall.exe"
    ${If} ${Errors}
      SetErrorLevel 1
      !insertmacro OGS_ABORT "Cannot prepare the Electron uninstaller. The previous installation has been retained."
    ${EndIf}
    ; --updated prevents data deletion even in deleteAppDataOnUninstall builds.
    ; _?= keeps execution synchronous; it MUST be the final, unquoted argument.
    StrCpy $OgsLegacyLaunchFailed 0
    ClearErrors
    ExecWait '$\"$PLUGINSDIR\ogs-electron-uninstall.exe$\" /S /KEEP_APP_DATA /currentuser --updated _?=$OgsLegacyDir' $OgsLegacyResult
    ${If} ${Errors}
      StrCpy $OgsLegacyLaunchFailed 1
    ${EndIf}
    ${If} $OgsLegacyLaunchFailed = 1
    ${OrIf} $OgsLegacyResult != 0
      SetErrorLevel 1
      !insertmacro OGS_ABORT "Electron could not be removed (launch error=$OgsLegacyLaunchFailed, exit=$OgsLegacyResult). Your settings and backups have been retained."
    ${EndIf}
    ReadRegStr $0 HKCU "${OGS_ELECTRON_KEY}" "UninstallString"
    ${If} $0 != ""
      SetErrorLevel 1
      !insertmacro OGS_ABORT "Electron removal is incomplete. Resolve it before installing OpenGameSave."
    ${EndIf}
    ; NSIS cannot delete its running uninstaller. Only remove that known file,
    ; then the empty directory; never recursively delete a legacy install path.
    Delete "$OgsLegacyDir\Uninstall OpenGameSave.exe"
    RMDir "$OgsLegacyDir"
    CreateDirectory "$INSTDIR"
    SetOutPath $INSTDIR
    !insertmacro OGS_TRACE "Electron removal completed"
  ${EndIf}
  ; The upstream association macro otherwise backs up our own ProgID on
  ; reinstall, losing the original association when subsequently uninstalled.
  ReadRegStr $0 SHCTX "Software\Classes\.gsmr" ""
  ${If} $0 == "OpenGameSave Archive"
    ReadRegStr $OgsAssociationBackup SHCTX "Software\Classes\.gsmr" "OpenGameSave Archive_backup"
  ${Else}
    StrCpy $OgsAssociationBackup $0
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro OGS_TRACE "Postinstall started"
  ${If} $OgsLegacyAutostart = 1
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OpenGameSave" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\"'
  ${EndIf}
  WriteRegStr SHCTX "Software\Classes\.gsmr" "OpenGameSave Archive_backup" "$OgsAssociationBackup"
  ; Both executable and document must be quoted for installation paths with spaces.
  WriteRegStr SHCTX "Software\Classes\OpenGameSave Archive\shell\open\command" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ReadRegStr $OgsAssociationAtUninstall SHCTX "Software\Classes\.gsmr" ""
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Another application may have claimed .gsmr since we installed it.
  ${If} $OgsAssociationAtUninstall != "OpenGameSave Archive"
    WriteRegStr SHCTX "Software\Classes\.gsmr" "" "$OgsAssociationAtUninstall"
  ${EndIf}
  DeleteRegValue SHCTX "Software\Classes\.gsmr" "OpenGameSave Archive_backup"
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; The runtime intentionally shares Electron's data directory. Delete only
    ; known settings/catalog files, never backupPath or this entire directory:
    ; users may have placed custom backups inside it.
    Delete "$APPDATA\opengamesave\OGS Settings\settings.json"
    Delete "$APPDATA\opengamesave\OGS Database\database.db"
    RMDir "$APPDATA\opengamesave\OGS Settings"
    RMDir "$APPDATA\opengamesave\OGS Database"
  ${EndIf}
!macroend
