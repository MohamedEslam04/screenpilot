/** Language of a narration line: Arabic when it has Arabic letters, else English. */
export function detectLang(text: string): "ar" | "en" {
  return /[؀-ۿ]/.test(text) ? "ar" : "en";
}

/** SSML-style rate ("+10%", "-5%") as a speed factor for engines that take one. */
export function rateToSpeed(rate: string): number {
  const m = /^([+-]?\d+(?:\.\d+)?)%$/.exec(rate.trim());
  if (!m) return 1;
  const speed = 1 + Number(m[1]) / 100;
  return speed > 0.2 ? Number(speed.toFixed(3)) : 1;
}
