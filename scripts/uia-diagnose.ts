// Diagnostic for the Windows UI Automation source: what does each tree view
// (control, content, raw, plain descendants search) see for a process? Prints a
// compact text summary. Informational: used by windows-smoke to find out why a
// tree is empty, never fails a check.
import { run } from "../src/util/exec.js";

const script = (pid: number) => `$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$root = $AE::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, [int]${pid})
$wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
"top-level windows for pid ${pid}: $($wins.Count)"
function Walk($walker, $el, $depth, $max, $hist, $lines, $lim) {
  if ($depth -gt $max -or $hist.Total -ge 400) { return }
  $c = $walker.GetFirstChild($el)
  while ($c -ne $null -and $hist.Total -lt 400) {
    $hist.Total++
    $t = $c.Current.ControlType.ProgrammaticName -replace 'ControlType\\.', ''
    $hist[$t] = 1 + [int]$hist[$t]
    if ($lines.Count -lt $lim) { [void]$lines.Add(('  ' * $depth) + $t + " '" + $c.Current.Name + "' class=" + $c.Current.ClassName + " off=" + $c.Current.IsOffscreen) }
    Walk $walker $c ($depth + 1) $max $hist $lines $lim
    $c = $walker.GetNextSibling($c)
  }
}
foreach ($w in $wins) {
  "WINDOW '$($w.Current.Name)' type=$($w.Current.ControlType.ProgrammaticName) class=$($w.Current.ClassName) framework=$($w.Current.FrameworkId) native=$($w.Current.NativeWindowHandle)"
  foreach ($name in 'Control', 'Content', 'Raw') {
    $walker = switch ($name) { 'Control' { [System.Windows.Automation.TreeWalker]::ControlViewWalker } 'Content' { [System.Windows.Automation.TreeWalker]::ContentViewWalker } default { [System.Windows.Automation.TreeWalker]::RawViewWalker } }
    $hist = @{ Total = 0 }
    $lines = New-Object System.Collections.ArrayList
    Walk $walker $w 0 10 $hist $lines 25
    $summary = ($hist.GetEnumerator() | Where-Object { $_.Key -ne 'Total' } | Sort-Object Name | ForEach-Object { "$($_.Key)x$($_.Value)" }) -join ', '
    "  $name walker: total=$($hist.Total) [$summary]"
    if ($name -eq 'Raw') { $lines | ForEach-Object { "    $_" } }
  }
  try {
    $all = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    "  FindAll(Descendants) count=$($all.Count)"
  } catch { "  FindAll(Descendants) failed: $($_.Exception.Message)" }
}
$procName = (Get-Process -Id ${pid} -ErrorAction SilentlyContinue).ProcessName
"process: $procName"
`;

/** Text report for a process id. */
export async function uiaDiagnose(pid: number): Promise<string> {
  const enc = Buffer.from(script(pid), "utf16le").toString("base64");
  const { stdout, stderr } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc], { timeoutMs: 90_000 });
  return `${stdout.trim()}${stderr.trim() ? `\nstderr: ${stderr.trim().slice(0, 400)}` : ""}`;
}
