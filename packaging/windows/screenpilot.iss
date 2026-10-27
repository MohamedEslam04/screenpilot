; ScreenPilot installer (Inno Setup 6). Built by scripts/build-mcpb.ts, which passes:
;   /DAppName=ScreenPilot /DAppVersion=0.1.0 /DStageDir=<package folder> /DOutDir=<release folder> /DIconFile=<.ico>
; Per-user, no admin. Files go to their final place, then `setup --in-place` registers the
; MCP server with every AI app found and its summary is shown on the last page.

#ifndef AppName
  #define AppName "ScreenPilot"
#endif
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
; Never change this GUID: it is how upgrades find the old install.
AppId={{6B0E8F7C-2D41-4C57-9A3E-5C1F7A9D0E42}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Mohamed Eslam
AppPublisherURL=https://github.com/MohamedEslam04/screenpilot
DefaultDirName={localappdata}\{#AppName}
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Compression=lzma2/max
SolidCompression=yes
OutputDir={#OutDir}
OutputBaseFilename={#AppName}-{#AppVersion}-windows-setup
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\icon.ico
UninstallDisplayName={#AppName}
WizardStyle=modern
; Our own check (PrepareToInstall) asks the user to close AI apps that hold ScreenPilot's files.
CloseApplications=no
RestartApplications=no
SetupLogging=yes
UsePreviousAppDir=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[InstallDelete]
; An upgrade starts clean so files dropped in a new version do not linger.
Type: filesandordirs; Name: "{app}\dist"
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\skill"
Type: filesandordirs; Name: "{app}\bin"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#IconFile}"; DestDir: "{app}"; DestName: "icon.ico"; Flags: ignoreversion

[Code]
var
  SummaryPage: TWizardPage;
  SummaryMemo: TNewMemo;
  SummaryText: String;

function NodeExe(): String;
begin
  Result := ExpandConstant('{app}\bin\node.exe');
end;

{ True when a file of an earlier install cannot be replaced because a program is using it. }
function IsLocked(const FileName: String): Boolean;
var
  Probe: String;
begin
  Result := False;
  if not FileExists(FileName) then Exit;
  Probe := FileName + '.chk';
  DeleteFile(Probe);
  if RenameFile(FileName, Probe) then
    RenameFile(Probe, FileName)
  else
    Result := True;
end;

function AppIsInUse(): Boolean;
begin
  Result := IsLocked(NodeExe()) or
            IsLocked(ExpandConstant('{app}\bin\ffmpeg.exe')) or
            IsLocked(ExpandConstant('{app}\bin\ffprobe.exe'));
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Answer: Integer;
begin
  Result := '';
  while AppIsInUse() do
  begin
    if WizardSilent() then
    begin
      Result := 'ScreenPilot is in use. Close your AI apps (Claude, Codex, Cursor, VS Code, ...) and run the installer again.';
      Exit;
    end;
    Answer := MsgBox(
      'ScreenPilot is being used by one of your AI apps (Claude, Codex, Cursor, VS Code, ...).' + #13#10 + #13#10 +
      'Please close them completely, then click Retry. If Claude Desktop is open, quit it from its tray icon too.',
      mbError, MB_RETRYCANCEL);
    if Answer <> IDRETRY then
    begin
      Result := 'Setup was cancelled because ScreenPilot is in use. Close your AI apps and run the installer again.';
      Exit;
    end;
  end;
end;

function ReadText(const FileName: String): String;
var
  Raw: AnsiString;
begin
  Result := '';
  if LoadStringFromFile(FileName, Raw) then Result := String(Raw);
end;

{ Runs "node cli.js setup <args>" hidden; stderr (the human summary) goes to a file. Returns the exit code. }
function RunSetup(const Args, StderrFile: String): Integer;
var
  Cmd: String;
begin
  DeleteFile(StderrFile);
  { cmd /C "<outer quotes>" keeps every inner quote, so paths with spaces or Arabic letters work. }
  Cmd := '/C ""' + NodeExe() + '" "' + ExpandConstant('{app}\dist\cli.js') + '" setup ' + Args +
         ' > nul 2> "' + StderrFile + '""';
  if not Exec(ExpandConstant('{cmd}'), Cmd, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Result) then
    Result := -1;
end;

function PlainSummary(const Raw: String; Code: Integer): String;
begin
  if Code <> 0 then
    Result := 'ScreenPilot was installed, but it could not be added to your AI apps automatically.' + #13#10 + #13#10 +
              'Close your AI apps and run this installer again.' + #13#10 + #13#10 + 'Details:' + #13#10 + Raw
  else
    Result := 'ScreenPilot is installed.' + #13#10 + #13#10 +
              'What happened (each line is one AI app: "added" means ScreenPilot is now available in it, "not installed" means that app was not found on this computer):' +
              #13#10 + Raw + #13#10 + #13#10 +
              'Next: restart your AI app, then ask it something like "record my screen while I show the signup flow, then make a video".';
  StringChangeEx(Result, #10, #13#10, True);
  StringChangeEx(Result, #13#13#10, #13#10, True);
end;

procedure InitializeWizard();
begin
  SummaryPage := CreateCustomPage(wpInstalling, 'ScreenPilot is ready',
    'Here is what was set up on this computer.');
  SummaryMemo := TNewMemo.Create(SummaryPage);
  SummaryMemo.Parent := SummaryPage.Surface;
  SummaryMemo.Left := 0;
  SummaryMemo.Top := 0;
  SummaryMemo.Width := SummaryPage.SurfaceWidth;
  SummaryMemo.Height := SummaryPage.SurfaceHeight;
  SummaryMemo.ReadOnly := True;
  SummaryMemo.ScrollBars := ssVertical;
  SummaryMemo.WordWrap := True;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
  Tmp: String;
begin
  if CurStep = ssPostInstall then
  begin
    Tmp := ExpandConstant('{tmp}\screenpilot-setup.txt');
    Code := RunSetup('--in-place', Tmp);
    SummaryText := PlainSummary(Trim(ReadText(Tmp)), Code);
    SummaryMemo.Text := SummaryText;
    Log('setup --in-place exit code ' + IntToStr(Code) + #13#10 + SummaryText);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Code: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    { Take ScreenPilot out of the AI apps first, while its files are still here. }
    if FileExists(NodeExe()) then
    begin
      Code := RunSetup('--remove', ExpandConstant('{tmp}\screenpilot-remove.txt'));
      Log('setup --remove exit code ' + IntToStr(Code));
    end;
  end;
end;

function InitializeUninstall(): Boolean;
begin
  Result := True;
  while IsLocked(NodeExe()) do
  begin
    if UninstallSilent() then
    begin
      Result := False;
      Exit;
    end;
    if MsgBox('ScreenPilot is being used by one of your AI apps. Please close them completely, then click Retry.',
              mbError, MB_RETRYCANCEL) <> IDRETRY then
    begin
      Result := False;
      Exit;
    end;
  end;
end;
