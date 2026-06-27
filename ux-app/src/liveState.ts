// In the JSONUIProvider + Renderer composition, action handlers receive only
// `params` — the form state is NOT passed to them. JSONUIProvider does expose
// an `onStateChange` callback that emits incremental {path, value} changes, so
// we mirror those into a plain object and let ux_submit read the snapshot.
import type { Spec } from "@json-render/core";

let mirror: Record<string, unknown> = {};

export function resetMirror(initial: Spec["state"]): void {
  // deep clone so we never mutate the spec's state
  mirror = initial ? structuredClone(initial as Record<string, unknown>) : {};
}

export function getMirror(): Record<string, unknown> {
  return mirror;
}

// Apply json-pointer-style changes ("/name", "/__ms/0/1") onto the mirror,
// creating intermediate objects as needed.
export function applyChanges(changes: Array<{ path: string; value: unknown }>): void {
  for (const { path, value } of changes) {
    const segments = path.split("/").filter(Boolean).map(decodePointerSegment);
    if (segments.length === 0) continue;
    let node = mirror;
    for (let i = 0; i < segments.length - 1; i++) {
      const key = segments[i]!;
      if (typeof node[key] !== "object" || node[key] === null) node[key] = {};
      node = node[key] as Record<string, unknown>;
    }
    node[segments[segments.length - 1]!] = value;
  }
}

// RFC6901 unescape (~1 -> /, ~0 -> ~)
function decodePointerSegment(seg: string): string {
  return seg.replace(/~1/g, "/").replace(/~0/g, "~");
}
