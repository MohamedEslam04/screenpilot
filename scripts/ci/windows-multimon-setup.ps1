# Adds a second (virtual) monitor to a Windows desktop and arranges it for the multi-monitor smoke test:
#   1. installs the signed Virtual Display Driver (an Indirect Display driver) with nefcon,
#   2. places its monitor to the right of the primary one with a vertical offset,
#   3. sets a different DPI scale on it (DisplayConfigSetDeviceInfo, what the "SetDpi" tools use).
# Needs administrator rights and an interactive desktop session. Prints what it did and what took effect.
param(
  [int]$Scale = 150, # percent, one of 100,125,150,175,200,225,250,300,350,400,450,500
  [int]$OffsetY = -200, # vertical offset of the 2nd monitor's top edge relative to the primary's top edge
  [string]$DriverUrl = 'https://github.com/VirtualDrivers/Virtual-Display-Driver/releases/download/25.7.23/VirtualDisplayDriver-x86.Driver.Only.zip',
  [string]$NefconUrl = 'https://github.com/nefarius/nefcon/releases/download/v1.14.0/nefcon_v1.14.0.zip'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class Mm {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DISPLAY_DEVICE {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
    public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public ushort dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
    public uint dmFields;
    public int dmPositionX, dmPositionY;
    public uint dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public ushort dmLogPixels;
    public uint dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
    public uint dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
  }

  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplayDevices(string dev, uint i, ref DISPLAY_DEVICE dd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettings(string dev, int mode, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int ChangeDisplaySettingsEx(string dev, ref DEVMODE dm, IntPtr hwnd, uint flags, IntPtr lp);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "ChangeDisplaySettingsExW")] static extern int ApplyDisplaySettings(string dev, IntPtr dm, IntPtr hwnd, uint flags, IntPtr lp);
  [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint np, out uint nm);
  [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint np, IntPtr paths, ref uint nm, IntPtr modes, IntPtr topo);
  [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(IntPtr p);
  [DllImport("user32.dll")] static extern int DisplayConfigSetDeviceInfo(IntPtr p);

  public static void Aware() { SetProcessDpiAwarenessContext(new IntPtr(-4)); }

  public static List<DISPLAY_DEVICE> Adapters() {
    var l = new List<DISPLAY_DEVICE>();
    for (uint i = 0; ; i++) {
      var d = new DISPLAY_DEVICE(); d.cb = Marshal.SizeOf(d);
      if (!EnumDisplayDevices(null, i, ref d, 0)) break;
      l.Add(d);
    }
    return l;
  }

  public static DEVMODE Current(string dev) {
    var m = new DEVMODE(); m.dmSize = (ushort)Marshal.SizeOf(m);
    if (!EnumDisplaySettings(dev, -1, ref m)) m.dmPelsWidth = 0;
    return m;
  }

  /** Attach `dev` (or move it) to x,y at its current/default size; staged, applied by Apply(). */
  public static int Place(string dev, int x, int y, uint w, uint h, uint flags) {
    var m = Current(dev);
    if (w > 0) { m.dmPelsWidth = w; m.dmPelsHeight = h; }
    m.dmPositionX = x; m.dmPositionY = y;
    m.dmBitsPerPel = 32;
    m.dmFields = 0x20 | 0x40000 | 0x80000 | 0x100000; // POSITION | BITSPERPEL | PELSWIDTH | PELSHEIGHT
    return ChangeDisplaySettingsEx(dev, ref m, IntPtr.Zero, flags, IntPtr.Zero);
  }

  public static int ModeSize() { return Marshal.SizeOf(typeof(DEVMODE)); }

  public static int Apply() { return ApplyDisplaySettings(null, IntPtr.Zero, IntPtr.Zero, 0, IntPtr.Zero); }

  static readonly int[] Steps = { 100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500 };

  static IntPtr Packet(int size, int type, int lo, int hi, uint id) {
    IntPtr p = Marshal.AllocHGlobal(size);
    for (int i = 0; i < size; i += 4) Marshal.WriteInt32(p, i, 0);
    Marshal.WriteInt32(p, 0, type); Marshal.WriteInt32(p, 4, size);
    Marshal.WriteInt32(p, 8, lo); Marshal.WriteInt32(p, 12, hi); Marshal.WriteInt32(p, 16, (int)id);
    return p;
  }

  /** DPI scale (percent) of source `gdi` ("\\.\DISPLAY2") before/after via the undocumented DPI-scale device info types. */
  public static string SetScale(string gdi, int percent) {
    uint np, nm;
    int rc = GetDisplayConfigBufferSizes(2, out np, out nm); // QDC_ONLY_ACTIVE_PATHS
    if (rc != 0) throw new Exception("GetDisplayConfigBufferSizes " + rc);
    IntPtr paths = Marshal.AllocHGlobal((int)np * 72), modes = Marshal.AllocHGlobal((int)nm * 64);
    rc = QueryDisplayConfig(2, ref np, paths, ref nm, modes, IntPtr.Zero);
    if (rc != 0) throw new Exception("QueryDisplayConfig " + rc);
    var seen = new StringBuilder();
    for (int i = 0; i < np; i++) {
      IntPtr path = IntPtr.Add(paths, i * 72);
      int lo = Marshal.ReadInt32(path, 0), hi = Marshal.ReadInt32(path, 4); uint id = (uint)Marshal.ReadInt32(path, 8);
      IntPtr q = Packet(84, 1, lo, hi, id); // GET_SOURCE_NAME
      if (DisplayConfigGetDeviceInfo(q) != 0) continue;
      string name = Marshal.PtrToStringUni(IntPtr.Add(q, 20));
      seen.Append(name).Append(' ');
      if (!string.Equals(name, gdi, StringComparison.OrdinalIgnoreCase)) continue;
      IntPtr g = Packet(32, -3, lo, hi, id); // GET_DPI_SCALE
      rc = DisplayConfigGetDeviceInfo(g);
      if (rc != 0) throw new Exception("GET_DPI_SCALE " + rc);
      int min = Marshal.ReadInt32(g, 20), cur = Marshal.ReadInt32(g, 24), max = Marshal.ReadInt32(g, 28);
      int rec = -min, want = Array.IndexOf(Steps, percent);
      if (want < 0) throw new Exception("unsupported scale " + percent);
      int rel = want - rec;
      string before = "rec=" + Steps[rec] + "% cur=" + Steps[rec + cur] + "% max=" + Steps[rec + max] + "%";
      if (rel < min || rel > max) throw new Exception(percent + "% is outside " + Steps[0] + ".." + Steps[rec + max] + "% (" + before + ")");
      IntPtr s = Packet(24, -4, lo, hi, id); // SET_DPI_SCALE
      Marshal.WriteInt32(s, 20, rel);
      rc = DisplayConfigSetDeviceInfo(s);
      if (rc != 0) throw new Exception("SET_DPI_SCALE " + rc);
      return gdi + ": " + before + " -> " + percent + "%";
    }
    throw new Exception("no active display path for " + gdi + " (saw: " + seen + ")");
  }
}
'@
[Mm]::Aware()

function Show-Displays($title) {
  Write-Host "---- $title"
  foreach ($a in [Mm]::Adapters()) {
    $m = [Mm]::Current($a.DeviceName)
    '{0} flags=0x{1:x} [{2}] mode {3}x{4} at {5},{6}' -f $a.DeviceName, $a.StateFlags, $a.DeviceString, $m.dmPelsWidth, $m.dmPelsHeight, $m.dmPositionX, $m.dmPositionY | Write-Host
  }
}

Show-Displays 'before'
$before = @([Mm]::Adapters() | Where-Object { $_.StateFlags -band 1 }).Count
$knownNames = @([Mm]::Adapters() | ForEach-Object { $_.DeviceName })

# --- 1. install the Indirect Display driver
$tmp = Join-Path $env:RUNNER_TEMP 'vdd'
New-Item -ItemType Directory -Force $tmp | Out-Null
Invoke-WebRequest $NefconUrl -OutFile "$tmp\nefcon.zip"
Invoke-WebRequest $DriverUrl -OutFile "$tmp\driver.zip"
Expand-Archive "$tmp\nefcon.zip" "$tmp\nefcon" -Force
Expand-Archive "$tmp\driver.zip" "$tmp\driver" -Force
Get-ChildItem $tmp -Recurse -File | ForEach-Object { $_.FullName.Substring($tmp.Length) } | Write-Host
$inf = Get-ChildItem "$tmp\driver" -Recurse -Filter 'MttVDD.inf' | Select-Object -First 1
$cat = Get-ChildItem "$tmp\driver" -Recurse -Filter '*.cat' | Select-Object -First 1
$nefcon = Get-ChildItem "$tmp\nefcon" -Recurse -Filter 'nefconw.exe' | Where-Object { $_.FullName -match 'x64' } | Select-Object -First 1
if (-not $inf -or -not $cat -or -not $nefcon) { throw "driver files missing: inf=$inf cat=$cat nefcon=$nefcon" }

# The catalog is signed by SignPath; trust its signer so the install is silent.
$sig = Get-AuthenticodeSignature $cat.FullName
Write-Host "catalog signature: $($sig.Status) $($sig.SignerCertificate.Subject)"
$certs = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2Collection
$certs.Import([IO.File]::ReadAllBytes($cat.FullName))
foreach ($c in $certs) {
  $f = Join-Path $tmp "$($c.Thumbprint).cer"
  [IO.File]::WriteAllBytes($f, $c.Export('Cert'))
  Import-Certificate -FilePath $f -CertStoreLocation Cert:\LocalMachine\TrustedPublisher | Out-Null
}

# The driver reads its monitor list from here: one 1920x1080@60 monitor (large enough for DPI scales up to 300%).
New-Item -ItemType Directory -Force C:\VirtualDisplayDriver | Out-Null
@'
<?xml version='1.0' encoding='utf-8'?>
<vdd_settings>
  <monitors><count>1</count></monitors>
  <gpu><friendlyname>default</friendlyname></gpu>
  <resolutions>
    <resolution><width>1920</width><height>1080</height><refresh_rate>60</refresh_rate></resolution>
  </resolutions>
  <options><CustomEdid>false</CustomEdid><PreventSpoof>false</PreventSpoof><EdidCeaOverride>false</EdidCeaOverride><HardwareCursor>true</HardwareCursor><SDR10bit>false</SDR10bit><HDRPlus>false</HDRPlus><logging>false</logging><debuglogging>false</debuglogging></options>
</vdd_settings>
'@ | Set-Content -Encoding utf8 C:\VirtualDisplayDriver\vdd_settings.xml

Write-Host "installing $($inf.FullName)"
Push-Location $inf.DirectoryName
& $nefcon.FullName install $inf.Name 'Root\MttVDD' 2>&1 | Write-Host
Write-Host "nefcon exit $LASTEXITCODE"
Pop-Location
Get-PnpDevice -Class Display -ErrorAction SilentlyContinue | Format-Table Status, FriendlyName, InstanceId -AutoSize | Out-String -Width 200 | Write-Host

# --- 2. wait for the new monitor, then arrange: primary at 0,0, new one to its right, shifted by OffsetY
$deadline = (Get-Date).AddSeconds(60)
$vdd = $null
do {
  Start-Sleep 1
  $vdd = [Mm]::Adapters() | Where-Object { $_.DeviceString -match 'Virtual Display|MttVDD|IddSample' -or $knownNames -notcontains $_.DeviceName } | Select-Object -First 1
} until ($vdd -or (Get-Date) -gt $deadline)
Show-Displays 'after driver install'
if (-not $vdd) { throw 'the virtual display adapter never appeared' }
$primary = [Mm]::Adapters() | Where-Object { $_.StateFlags -band 4 } | Select-Object -First 1
$pm = [Mm]::Current($primary.DeviceName)
Write-Host "primary $($primary.DeviceName) $($pm.dmPelsWidth)x$($pm.dmPelsHeight); virtual $($vdd.DeviceName)"

$vm = [Mm]::Current($vdd.DeviceName)
$w = $vm.dmPelsWidth; $h = $vm.dmPelsHeight
if ($w -eq 0) { $w = 1920; $h = 1080 }
Write-Host "sizeof DEVMODE = $([Mm]::ModeSize()) (want 220)"
foreach ($flags in 0x10001, 0x1, 0x0) {
  $rc = [Mm]::Place($vdd.DeviceName, [int]$pm.dmPelsWidth, $OffsetY, $w, $h, $flags)
  Write-Host ('place flags=0x{0:x} rc={1}' -f $flags, $rc)
  if ($rc -eq 0) { break }
}
Write-Host ("apply rc={0}" -f [Mm]::Apply())
Start-Sleep 3
Show-Displays 'after arrange'

# --- 3. per-monitor DPI scale on the virtual monitor only
Write-Host (([Mm]::SetScale($vdd.DeviceName, $Scale)))
Start-Sleep 3
Show-Displays 'final'
$now = @([Mm]::Adapters() | Where-Object { $_.StateFlags -band 1 }).Count
Write-Host "attached monitors: $before -> $now"
if ($now -lt 2) { throw 'fewer than 2 monitors are attached' }
