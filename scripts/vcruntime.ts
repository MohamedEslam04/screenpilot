// App-local Visual C++ runtime: native modules built with MSVC import
// VCRUNTIME140.dll / MSVCP140.dll. A fresh Windows has them only when some
// other program installed the "VC++ Redistributable", so copy them next to each
// module that needs them (Microsoft permits app-local deployment of these DLLs).
//
//   tsx scripts/vcruntime.ts <folder>    report (and bundle, when run on Windows)

import { copyFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const VC_RUNTIME = /^(vcruntime140|msvcp140|concrt140|vcomp140|vccorlib140)[\w]*\.dll$/i;
const MODULE = /\.(node|dll|exe)$/i;

/** Names of the DLLs a PE file imports (normal and delay-load imports). */
export function peImports(file: string): string[] {
  const b = readFileSync(file);
  if (b.length < 0x40 || b.readUInt16LE(0) !== 0x5a4d) return [];
  const pe = b.readUInt32LE(0x3c);
  if (pe + 24 > b.length || b.readUInt32LE(pe) !== 0x4550) return [];
  const sections = b.readUInt16LE(pe + 6);
  const optSize = b.readUInt16LE(pe + 20);
  const opt = pe + 24;
  const magic = b.readUInt16LE(opt);
  const dirs = opt + (magic === 0x20b ? 112 : 96);
  const table = opt + optSize;
  const secs = Array.from({ length: sections }, (_, i) => {
    const s = table + i * 40;
    return { va: b.readUInt32LE(s + 12), size: Math.max(b.readUInt32LE(s + 8), b.readUInt32LE(s + 16)), raw: b.readUInt32LE(s + 20) };
  });
  const off = (rva: number): number => {
    const s = secs.find((x) => rva >= x.va && rva < x.va + x.size);
    return s ? rva - s.va + s.raw : -1;
  };
  const cstr = (rva: number): string => {
    const o = off(rva);
    if (o < 0) return "";
    let e = o;
    while (e < b.length && b[e] !== 0) e++;
    return b.toString("latin1", o, e);
  };
  const names = new Set<string>();
  const walk = (dirIndex: number, step: number, nameAt: number): void => {
    const d = dirs + dirIndex * 8;
    if (d + 8 > b.length) return;
    let o = off(b.readUInt32LE(d));
    if (o < 0) return;
    for (; o + step <= b.length; o += step) {
      const rva = b.readUInt32LE(o + nameAt);
      if (rva === 0) break;
      const n = cstr(rva);
      if (n) names.add(n.toLowerCase());
    }
  };
  walk(1, 20, 12); // import table
  walk(13, 32, 4); // delay-load import table
  return [...names];
}

function modulesIn(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) modulesIn(p, out);
    else if (MODULE.test(e.name) && statSync(p).size > 0) out.push(p);
  }
  return out;
}

export interface VcReport {
  /** module -> VC++ runtime DLLs it imports */
  needs: Map<string, string[]>;
  copied: string[];
  missingSource: string[];
}

/** Find modules needing the VC++ runtime and copy the DLLs beside them (when the runner has them). */
export function bundleVcRuntime(folder: string, log: (m: string) => void = console.error): VcReport {
  const sys = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const canCopy = process.platform === "win32";
  const needs = new Map<string, string[]>();
  const copied: string[] = [];
  const missingSource: string[] = [];
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const m of modulesIn(folder)) {
      let deps: string[];
      try {
        deps = peImports(m).filter((d) => VC_RUNTIME.test(d));
      } catch {
        continue;
      }
      if (!deps.length) continue;
      needs.set(m, deps);
      for (const d of deps) {
        const dest = join(dirname(m), d);
        if (existsSync(dest)) continue;
        const src = join(sys, d);
        if (canCopy && existsSync(src)) {
          copyFileSync(src, dest);
          copied.push(dest);
          changed = true;
        } else if (!missingSource.includes(d)) missingSource.push(d);
      }
    }
    if (!changed) break;
  }
  const rel = (p: string) => p.slice(resolve(folder).length + 1);
  if (!needs.size) log("vc runtime: no module imports VCRUNTIME140/MSVCP140 (nothing to bundle)");
  for (const [m, d] of needs) log(`vc runtime: ${rel(m)} needs ${d.join(", ")}`);
  for (const c of copied) log(`vc runtime: bundled ${rel(c)}`);
  if (missingSource.length) log(`vc runtime: not copied (not on this machine): ${missingSource.join(", ")}`);
  return { needs, copied, missingSource };
}

if (process.argv[1] && basename(process.argv[1]) === "vcruntime.ts") {
  const folder = process.argv[2];
  if (!folder) throw new Error("usage: tsx scripts/vcruntime.ts <folder>");
  bundleVcRuntime(folder);
}
