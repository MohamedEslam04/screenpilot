import type { RecorderBackend } from "../backend.js";
import type { ScreenInfo } from "../input/types.js";
import type { CaptureInfo, ObsRecorder } from "../obs.js";

/** OBS Studio as a backend (layout/scene preparation stays in startRecording, it is OBS-specific). */
export class ObsBackend implements RecorderBackend {
  readonly id = "obs" as const;

  constructor(readonly obs: ObsRecorder) {}

  get startedAt(): number {
    return this.obs.startedAt;
  }

  async prepare(_s: ScreenInfo[], _a: ScreenInfo[], _l: (m: string) => void): Promise<CaptureInfo> {
    throw new Error("OBS capture is prepared by startRecording");
  }

  start(dir: string): Promise<void> {
    return this.obs.start(dir);
  }

  stop(): Promise<string> {
    return this.obs.stop();
  }

  restore(): Promise<void> {
    return this.obs.restore();
  }

  dispose(): Promise<void> {
    return this.obs.disconnect().catch(() => {});
  }
}
