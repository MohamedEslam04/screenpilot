import type { A11yQuery } from "./types.js";

/** "button:Save" -> role+name; "::Save" or "Save" -> name only; "button:" -> role only. The name may contain colons. */
export function parseA11yTarget(spec: string): A11yQuery {
  const i = spec.indexOf(":");
  const role = i >= 0 ? spec.slice(0, i).trim() : "";
  const name = (i >= 0 ? spec.slice(i + 1) : spec).trim();
  if (!role && !name) throw new Error('Give a role and/or a name, e.g. a11y:button:Save');
  return { ...(role ? { role } : {}), ...(name ? { name } : {}) };
}
