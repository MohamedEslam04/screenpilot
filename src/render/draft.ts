/** Draft renders capture at most this many frames per second (Chrome capture is the slow part). */
const DRAFT_FPS = 15;

export function draftFps(fps: number): number {
  return Math.min(fps, DRAFT_FPS);
}
