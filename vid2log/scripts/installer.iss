; Inno Setup script for the vid2log Windows installer.
; Compiled by scripts\build_windows.ps1 — that script builds the app and
; stages the sidecar first, so this file only packages what's already there.
;
; Install it from https://jrsoftware.org/isdl.php (Inno Setup 6).

#define MyAppName "Vid2Log"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Vid2Log"
; Must match BINARY_NAME in windows/CMakeLists.txt.
#define MyAppExeName "Vid2Log.exe"

[Setup]
AppId={{8F2A6C41-9B3D-4E7A-A1C5-2D6E8B4F0A93}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
OutputDir=..\dist
OutputBaseFilename=vid2log-windows-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; The app and its bundled TensorFlow are 64-bit only.
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Per-user install by default: it needs no admin rights, and it keeps the
; app out of Program Files, where a sandboxed process spawning a sibling
; executable can run into permission oddities.
PrivilegesRequiredOverridesAllowed=dialog
PrivilegesRequired=lowest
DisableProgramGroupPage=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
; The whole Release folder, which build_windows.ps1 has already populated
; with the Flutter app, its DLLs, and the frozen vid2log_sidecar\ directory
; (including the bundled Tesseract).
Source: "..\build\windows\x64\runner\Release\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; PyInstaller and the app write scratch files inside the install directory
; at runtime; without this the uninstaller leaves the folder behind.
Type: filesandordirs; Name: "{app}\vid2log_sidecar"

; NOTE: user data (~\.vid2log — the database, trained models, action
; datasets) is deliberately NOT removed on uninstall. It's the user's work,
; it can be large, and silently deleting a trained model because someone
; uninstalled to reinstall a newer version would be indefensible.
