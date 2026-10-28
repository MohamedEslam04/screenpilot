import { extname } from "node:path";

const IMAGES = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"]);
const VIDEOS = new Set([".mp4", ".webm", ".mov", ".m4v", ".mkv"]);

/** Image or video, by file extension; undefined when it is neither. */
export function overlayKind(src: string): "image" | "video" | undefined {
  const ext = extname(src).toLowerCase();
  if (IMAGES.has(ext)) return "image";
  if (VIDEOS.has(ext)) return "video";
  return undefined;
}
