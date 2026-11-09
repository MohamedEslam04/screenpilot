export type Json = Record<string, unknown>;
export const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Objects merge key by key; anything else (arrays too) is replaced by the child. */
export function deepMerge(base: unknown, child: unknown): unknown {
  if (!isObject(base) || !isObject(child)) return child === undefined ? base : child;
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(child)) out[k] = deepMerge(base[k], v);
  return out;
}
