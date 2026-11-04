// ffmpeg xfade transition names for the transition types a segment (or a sequence part) can use.
export const XFADE: Record<string, string> = {
  crossfade: "fade",
  "fade-black": "fadeblack",
  "fade-white": "fadewhite",
  "wipe-left": "wipeleft",
  "wipe-right": "wiperight",
  "slide-left": "slideleft",
  "slide-right": "slideright",
};
