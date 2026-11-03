const RE = /^(\d+)\.(\d+)\.(\d+)/;

export function parseVersion(v: string): [number, number, number] {
  const m = RE.exec(v.trim());
  if (!m) throw new Error(`Not a version: "${v}"`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** -1 when a is older than b, 1 when newer, 0 when equal (major.minor.patch, compared as numbers). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i]! !== y[i]!) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}
