import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** icon.png → a multi-size .ico (PNG frames, which Windows has read since Vista). Scaling uses ffmpeg. */
export async function makeIco(
  ffmpeg: string,
  png: string,
  tmp: string,
  dest: string,
  run: (cmd: string, args: string[]) => Promise<void>,
): Promise<void> {
  const sizes = [256, 64, 48, 32, 16];
  mkdirSync(tmp, { recursive: true });
  const frames: Buffer[] = [];
  for (const size of sizes) {
    const f = join(tmp, `${size}.png`);
    await run(ffmpeg, ["-y", "-loglevel", "error", "-i", png, "-vf", `scale=${size}:${size}:flags=lanczos,format=rgba`, "-frames:v", "1", f]);
    frames.push(readFileSync(f));
  }
  rmSync(tmp, { recursive: true, force: true });
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((size, i) => {
    const e = 6 + i * 16;
    head[e] = size === 256 ? 0 : size; // 0 means 256
    head[e + 1] = size === 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4); // planes
    head.writeUInt16LE(32, e + 6); // bits per pixel
    head.writeUInt32LE(frames[i]!.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += frames[i]!.length;
  });
  writeFileSync(dest, Buffer.concat([head, ...frames]));
}
