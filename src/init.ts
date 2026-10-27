import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { analyze, resolveTarget } from "./analyze/index.js";
import { probeVideo, type VideoInfo } from "./util/media.js";

export interface InitOptions {
  out?: string;
  voice?: string;
  force?: boolean;
  /** Pre-fill segments (idle cut) and zooms (from clicks) using `analyze`. */
  suggest?: boolean;
}

/** Write a starter storyboard.json for a video or a `demoreel record` session. */
export async function initStoryboard(target: string, o: InitOptions = {}): Promise<{ storyboard: string; source: VideoInfo }> {
  const { video, events, dir, canvasScreens } = await resolveTarget(target);
  const info = await probeVideo(video);
  const out = resolve(o.out ?? join(dir, "storyboard.json"));
  if (existsSync(out) && !o.force) throw new Error(`${out} already exists (pass force to overwrite)`);
  const base = resolve(out, "..");

  let segments = [{ in: 0, out: Math.round(info.duration * 100) / 100, speed: 1 }];
  let zooms: unknown[] = [];
  let views: unknown[] = [];
  const screens = canvasScreens && canvasScreens.length >= 2 ? canvasScreens : [];
  if (o.suggest) {
    const a = await analyze(target);
    segments = a.suggestedSegments;
    zooms = a.suggestedZooms;
    if (screens.length) views = a.suggestedViews ?? [];
  }

  const sb = {
    version: 1,
    source: relative(base, video),
    ...(events ? { events: relative(base, events) } : {}),
    voice: { name: o.voice ?? "en-US-AndrewNeural" },
    segments,
    zooms,
    ...(screens.length ? { screens: screens.map(({ name, x, y, w, h }) => ({ name, x, y, w, h })), views } : {}),
    captions: [],
    narration: [],
  };
  await writeFile(out, `${JSON.stringify(sb, null, 2)}\n`);
  return { storyboard: out, source: info };
}
