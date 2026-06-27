// Bridge to ux.mjs: fetch the page config on load, post captured input back
// through the one-time-token callback. Same-origin (the page IS the dist),
// so relative paths are correct.

export type UxMode = "render" | "form" | "confirm";

export interface UxConfig {
  session: string;
  token: string;
  mode: UxMode;
  spec: unknown;
  allow?: string[];
}

export interface UxDataRequest {
  site: string;
  command: string;
  positional?: Array<string | number | boolean>;
  args?: Record<string, unknown>;
}

export interface UxDataEnvelope {
  ok: boolean;
  data?: unknown;
  error?: string;
  code?: string;
}

let current: UxConfig | null = null;

export async function fetchConfig(): Promise<UxConfig> {
  const res = await fetch("/ux/config", { cache: "no-store" });
  if (!res.ok) throw new Error(`/ux/config -> ${res.status}`);
  const cfg = (await res.json()) as UxConfig;
  current = cfg;
  return cfg;
}

// POST /ux/callback/<session> with the x-ux-token header. ux.mjs answers 204
// and resolves its blocking capture promise.
export async function postCallback(body: unknown): Promise<void> {
  if (!current) throw new Error("postCallback before config loaded");
  try {
    await fetch(`/ux/callback/${current.session}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ux-token": current.token,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // The server closes the socket right after 204 + process.exit on form/
    // confirm, which can surface as a network error here. The payload was
    // already delivered, so this is non-fatal.
    console.warn("[ux] callback post settled with", err);
  }
}

export async function postData(request: UxDataRequest): Promise<UxDataEnvelope> {
  if (!current) throw new Error("postData before config loaded");
  const res = await fetch("/ux/data", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ux-token": current.token,
    },
    body: JSON.stringify(request),
  });
  let body: UxDataEnvelope;
  try {
    body = (await res.json()) as UxDataEnvelope;
  } catch {
    body = { ok: false, error: `/ux/data -> ${res.status}`, code: "bad_json" };
  }
  if (!res.ok && body.ok !== false) {
    return { ok: false, error: body.error ?? `/ux/data -> ${res.status}`, code: body.code ?? "http" };
  }
  return body;
}
