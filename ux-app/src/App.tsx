import { useEffect, useMemo, useState } from "react";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { createStateStore, type Spec } from "@json-render/core";
import type { UxConfig } from "./api";
import { registry, createActionHandlers, onDone } from "./registry";
import { toJsonRenderSpec } from "./toJsonRender";
import { resetMirror } from "./liveState";

export function App({ config }: { config: UxConfig }) {
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => onDone(setDone), []);

  const spec = useMemo<Spec>(
    () => toJsonRenderSpec(config.mode, config.spec),
    [config],
  );

  const store = useMemo(() => createStateStore(spec.state ?? {}), [spec]);
  const handlers = useMemo(() => createActionHandlers(store), [store]);

  // Preserve the legacy mirror for any uncontrolled fallback path; the store is
  // the source of truth when JSONUIProvider runs in controlled mode below.
  useMemo(() => resetMirror(spec.state), [spec]);

  useEffect(() => {
    const onSetState = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: unknown; value?: unknown }>).detail;
      if (typeof detail?.path === "string") store.set(detail.path, detail.value);
    };
    window.addEventListener("ux:set-state", onSetState);
    return () => window.removeEventListener("ux:set-state", onSetState);
  }, [store]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-[1180px] px-4 py-6 md:px-6 md:py-8">
        <div className="mb-4 flex flex-wrap gap-2 font-mono text-[11px] text-muted-foreground">
          <span className="border border-border rounded px-2 py-0.5">opencli ux</span>
          <span className="border border-border rounded px-2 py-0.5">{config.mode}</span>
          <span className="border border-border rounded px-2 py-0.5">isolated origin</span>
          <span className="border border-border rounded px-2 py-0.5 text-emerald-600">
            json-render
          </span>
          {config.allow?.length ? (
            <span className="border border-border rounded px-2 py-0.5">{config.allow.length} data grants</span>
          ) : null}
        </div>

        {done ? (
          <div className="rounded-xl border border-border bg-card text-card-foreground p-6 text-center">
            <p className="text-lg">{done}</p>
            <p className="text-sm text-muted-foreground mt-2">可关闭本页。</p>
          </div>
        ) : (
          <JSONUIProvider
            registry={registry}
            store={store}
            handlers={handlers}
          >
            <Renderer spec={spec} registry={registry} />
          </JSONUIProvider>
        )}
      </div>
    </div>
  );
}
