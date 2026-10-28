// Music ducking as a pure envelope: linear volume ramps in OUTPUT seconds that the
// composition plays through GSAP, so headless renders are deterministic.

export interface DuckOptions {
  amount: number;
  attack: number;
  release: number;
}

export interface DuckTween {
  t: number;
  dur: number;
  from: number;
  to: number;
}

const r = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Ramps for music at `volume` under the given voice spans. The music is fully
 * ducked (volume * (1 - amount)) when a line starts, `attack` seconds after the
 * ramp begins, and returns over `release` seconds after the line ends. Lines
 * closer together than attack + release keep it ducked in between.
 */
export function planDuck(spans: { start: number; end: number }[], volume: number, opts: DuckOptions, total: number): DuckTween[] {
  if (opts.amount <= 0) return [];
  const ducked = r(volume * (1 - opts.amount));
  const merged: { start: number; end: number }[] = [];
  const sorted = spans
    .map((s) => ({ start: Math.max(0, s.start), end: Math.min(total, s.end) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  for (const s of sorted) {
    const last = merged.at(-1);
    if (last && s.start - opts.attack <= last.end + opts.release) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  const tweens: DuckTween[] = [];
  for (const s of merged) {
    const t = Math.max(0, s.start - opts.attack);
    tweens.push({ t: r(t), dur: r(s.start - t), from: volume, to: ducked });
    if (s.end < total) tweens.push({ t: r(s.end), dur: r(Math.min(opts.release, total - s.end)), from: ducked, to: volume });
  }
  return tweens;
}
