// Creates one virtual display with the private CGVirtualDisplay API and keeps
// it alive until killed. CI helper for scripts/macos-multidisplay-smoke.ts.
//
//   vdisplay <pointW> <pointH> <hiDPI 0|1> <modeUnit px|pt> <offsetY> <report.json>
//
// The new display is placed to the right of the main display, `offsetY` points
// lower. Writes <report.json> (what Quartz says took effect) once it is ready.
import CoreGraphics
import Foundation

func fail(_ msg: String) -> Never {
  FileHandle.standardError.write(Data("vdisplay: \(msg)\n".utf8))
  exit(1)
}

let a = CommandLine.arguments
guard a.count >= 7, let ptW = UInt32(a[1]), let ptH = UInt32(a[2]), let hidpi = UInt32(a[3]), let offY = Int32(a[5]) else {
  fail("usage: vdisplay <pointW> <pointH> <hiDPI> <px|pt> <offsetY> <report.json>")
}
let modeUnit = a[4]
let reportPath = a[6]
let scale: UInt32 = hidpi == 1 ? 2 : 1
// The widely used convention: with hiDPI the mode is given in pixels and the display shows up at half that in points.
let modeW = modeUnit == "px" ? ptW * scale : ptW
let modeH = modeUnit == "px" ? ptH * scale : ptH

func active() -> [CGDirectDisplayID] {
  var n: UInt32 = 0
  CGGetActiveDisplayList(0, nil, &n)
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(n))
  CGGetActiveDisplayList(n, &ids, &n)
  return Array(ids.prefix(Int(n)))
}

let before = active()
let desc = CGVirtualDisplayDescriptor()
desc.queue = DispatchQueue.main
desc.name = "ScreenPilot Virtual \(ptW)x\(ptH)"
desc.maxPixelsWide = ptW * scale
desc.maxPixelsHigh = ptH * scale
desc.sizeInMillimeters = CGSize(width: 330, height: 215)
desc.vendorID = 0x3456
desc.productID = 0x1234
desc.serialNum = 0x0001

let vd = CGVirtualDisplay(descriptor: desc)
let settings = CGVirtualDisplaySettings()
settings.hiDPI = hidpi
settings.modes = [CGVirtualDisplayMode(width: modeW, height: modeH, refreshRate: 60)]
let applied = vd.applySettings(settings)
let id = vd.displayID
if id == 0 { fail("CGVirtualDisplay has displayID 0 (not created); applySettings=\(applied)") }

// Wait for the display to show up as active.
var waited = 0
while !active().contains(id) && waited < 100 { usleep(100_000); waited += 1 }
if !active().contains(id) { fail("display \(id) never became active; active=\(active())") }

// Place it right of the main display, offsetY lower.
let main = CGMainDisplayID()
let mb = CGDisplayBounds(main)
var cfg: CGDisplayConfigRef?
CGBeginDisplayConfiguration(&cfg)
let err = CGConfigureDisplayOrigin(cfg, id, Int32(mb.origin.x + mb.size.width), offY)
let done = CGCompleteDisplayConfiguration(cfg, .forSession)
usleep(1_500_000)

func describe(_ d: CGDirectDisplayID) -> [String: Any] {
  let b = CGDisplayBounds(d)
  var o: [String: Any] = [
    "id": d, "main": d == main, "virtual": d == id,
    "x": b.origin.x, "y": b.origin.y, "w": b.size.width, "h": b.size.height,
  ]
  if let m = CGDisplayCopyDisplayMode(d) {
    o["mode"] = ["w": m.width, "h": m.height, "pixelW": m.pixelWidth, "pixelH": m.pixelHeight, "hz": m.refreshRate]
  }
  if let all = CGDisplayCopyAllDisplayModes(d, [kCGDisplayShowDuplicateLowResolutionModes: true] as CFDictionary) as? [CGDisplayMode] {
    o["modes"] = all.map { "\($0.width)x\($0.height)@\($0.pixelWidth)x\($0.pixelHeight)" }
  }
  return o
}
let report: [String: Any] = [
  "id": id, "applied": applied, "placeErr": err.rawValue, "completeErr": done.rawValue,
  "args": ["pointW": ptW, "pointH": ptH, "hiDPI": hidpi, "modeUnit": modeUnit, "offsetY": offY],
  "before": before, "active": active().map(describe),
]
let data = try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
try! data.write(to: URL(fileURLWithPath: reportPath))
print("vdisplay ready id=\(id)")
fflush(stdout)
withExtendedLifetime(vd) { dispatchMain() }
