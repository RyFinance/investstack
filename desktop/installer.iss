; Inno Setup script for the Windows installer.
;   1. python tools\make_app.py            (-> dist\InvestStack\InvestStack.exe)
;   2. iscc desktop\installer.iss          (-> dist\InvestStack-Setup-<version>.exe)
; Pass /DAppVersion=1.2.3 to iscc to stamp a version (CI does this from the tag).

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#define AppName "InvestStack"
#define AppExe "InvestStack.exe"
#define WebView2Guid "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

[Setup]
AppId={{6C1E8F0A-3B7D-4C2E-9A51-7D0F4B2C9E11}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=RyFinance
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=InvestStack-Setup-{#AppVersion}
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\{#AppExe}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequiredOverridesAllowed=dialog
; The data folder (%APPDATA%\Valora or %APPDATA%\InvestStack) is left alone on uninstall: it holds the user's database and keys.

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "..\dist\InvestStack\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[Code]
{ pywebview draws the window with Microsoft Edge WebView2. Windows 11 ships it; older systems may not. }
function WebView2Installed(): Boolean;
var
  V: String;
begin
  Result :=
    (RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{#WebView2Guid}', 'pv', V) and (V <> '') and (V <> '0.0.0.0')) or
    (RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{#WebView2Guid}', 'pv', V) and (V <> '') and (V <> '0.0.0.0')) or
    (RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{#WebView2Guid}', 'pv', V) and (V <> '') and (V <> '0.0.0.0'));
end;

procedure InstallWebView2();
var
  Bootstrapper: String;
  Code: Integer;
begin
  Bootstrapper := ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe');
  WizardForm.StatusLabel.Caption := 'Downloading the Microsoft Edge WebView2 Runtime...';
  try
    DownloadTemporaryFile('https://go.microsoft.com/fwlink/p/?LinkId=2124703', 'MicrosoftEdgeWebview2Setup.exe', '', nil);
  except
    MsgBox('Could not download the WebView2 Runtime. InvestStack needs it to show its window.' + #13#10 +
           'Install it from https://developer.microsoft.com/microsoft-edge/webview2/ and start InvestStack again.', mbError, MB_OK);
    Exit;
  end;
  WizardForm.StatusLabel.Caption := 'Installing the Microsoft Edge WebView2 Runtime...';
  if not Exec(Bootstrapper, '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then
    MsgBox('The WebView2 Runtime installer did not finish (code ' + IntToStr(Code) + '). InvestStack needs it to show its window.', mbError, MB_OK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and not WebView2Installed() then
    InstallWebView2();
end;
