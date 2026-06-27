// Registry binds catalog entries to real shadcn components. Runtime action
// handlers are created per rendered spec so they can close over that spec's
// state store. This keeps forms, confirms, and live data pages isolated.
import { defineRegistry } from "@json-render/react";
import { shadcnComponents } from "@json-render/shadcn";
import type { StateStore } from "@json-render/core";
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { uxCatalog } from "./catalog";
import { postCallback, postData, type UxDataRequest } from "./api";
import { getFormMeta, normalizeFormValues } from "./toJsonRender";
import { getMirror } from "./liveState";

// Lets App show a terminal "done" panel after a callback fires.
let doneListener: ((label: string) => void) | null = null;
export function onDone(cb: (label: string) => void) {
  doneListener = cb;
  return () => {
    doneListener = null;
  };
}
const fireDone = (label: string) => doneListener?.(label);

// ── Custom styled template components ────────────────────────────────────────
// These live in real React/CSS (full styling power), audited once. The LLM only
// references them by name + fills data, so generated specs stay compact.
type Tone = "blue" | "pink" | "red" | "amber" | "emerald" | "violet" | "slate";

type StatItem = {
  label: string;
  value: string | number;
  delta?: string;
  sub?: string;
  trend?: "up" | "down" | "flat";
  tone?: Tone;
  href?: string;
};

type FeedItem = {
  title: string;
  url?: string;
  source?: string;
  meta?: string;
  snippet?: string;
  rank?: string | number;
  score?: string;
  tone?: Tone;
};

const toneClasses: Record<Tone, { chip: string; icon: string; ring: string; soft: string }> = {
  blue: {
    chip: "text-blue-700 bg-blue-500/10 dark:text-blue-300",
    icon: "bg-blue-500 text-white",
    ring: "border-blue-500/25",
    soft: "bg-blue-500/10",
  },
  pink: {
    chip: "text-pink-700 bg-pink-500/10 dark:text-pink-300",
    icon: "bg-pink-500 text-white",
    ring: "border-pink-500/25",
    soft: "bg-pink-500/10",
  },
  red: {
    chip: "text-red-700 bg-red-500/10 dark:text-red-300",
    icon: "bg-red-600 text-white",
    ring: "border-red-500/25",
    soft: "bg-red-500/10",
  },
  amber: {
    chip: "text-amber-700 bg-amber-500/12 dark:text-amber-300",
    icon: "bg-amber-500 text-slate-950",
    ring: "border-amber-500/25",
    soft: "bg-amber-500/10",
  },
  emerald: {
    chip: "text-emerald-700 bg-emerald-500/10 dark:text-emerald-300",
    icon: "bg-emerald-500 text-white",
    ring: "border-emerald-500/25",
    soft: "bg-emerald-500/10",
  },
  violet: {
    chip: "text-violet-700 bg-violet-500/10 dark:text-violet-300",
    icon: "bg-violet-500 text-white",
    ring: "border-violet-500/25",
    soft: "bg-violet-500/10",
  },
  slate: {
    chip: "text-slate-700 bg-slate-500/10 dark:text-slate-300",
    icon: "bg-slate-700 text-white dark:bg-slate-200 dark:text-slate-950",
    ring: "border-slate-500/20",
    soft: "bg-slate-500/10",
  },
};

const autoMountFired = new Set<string>();

function useAutoMount(
  emit: ((event: string) => void | Promise<void>) | undefined,
  signature: string,
  enabled: boolean,
): boolean {
  const shouldFire = Boolean(emit) && enabled && !autoMountFired.has(signature);
  useEffect(() => {
    if (!shouldFire || !emit || autoMountFired.has(signature)) return;
    autoMountFired.add(signature);
    void emit("mount");
  }, [emit, signature, shouldFire]);
  return shouldFire;
}

function trendTone(delta?: string, trend?: StatItem["trend"], tone?: Tone): string {
  if (tone) return toneClasses[tone].chip;
  const t = trend ?? (!delta ? "flat" : delta.trim().startsWith("-") ? "down" : "up");
  if (t === "up") return "text-emerald-700 dark:text-emerald-300 bg-emerald-500/10";
  if (t === "down") return "text-rose-700 dark:text-rose-300 bg-rose-500/10";
  return "text-muted-foreground bg-muted";
}

function pickTone(seed: string | number | undefined, fallback: Tone = "slate"): Tone {
  if (typeof seed === "string" && seed.toLowerCase().includes("arxiv")) return "red";
  if (typeof seed === "string" && seed.includes("36")) return "blue";
  if (typeof seed === "string" && seed.toLowerCase().includes("bili")) return "pink";
  return fallback;
}

function rowsOf(data: unknown): Record<string, unknown>[] {
  const candidate =
    Array.isArray(data) ? data :
    data && typeof data === "object" && Array.isArray((data as { rows?: unknown }).rows) ? (data as { rows: unknown[] }).rows :
    data && typeof data === "object" && Array.isArray((data as { items?: unknown }).items) ? (data as { items: unknown[] }).items :
    data && typeof data === "object" && Array.isArray((data as { data?: unknown }).data) ? (data as { data: unknown[] }).data :
    data ? [data] :
    [];
  return candidate.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x));
}

function text(value: unknown, fallback = ""): string {
  if (value == null) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function compactCurrency(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return text(value, "—");
  if (n >= 1000) return `$${Math.round(n).toLocaleString()}`;
  if (n >= 1) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  return `$${n.toLocaleString(undefined, { maximumSignificantDigits: 4 })}`;
}

function normalizeFeedItems(items: unknown, fallbackTone: Tone = "slate"): FeedItem[] {
  return rowsOf(items).map((r, i) => {
    const tone = (text(r.tone) as Tone) || pickTone(text(r.source ?? r.site), fallbackTone);
    return {
      title: text(r.title ?? r.name ?? r.headline, `Item ${i + 1}`),
      url: text(r.url ?? r.href ?? r.link) || undefined,
      source: text(r.source ?? r.site ?? r.author) || undefined,
      meta: text(r.meta ?? r.published ?? r.publishedAt ?? r.date ?? r.author ?? r.authors) || undefined,
      snippet: text(r.snippet ?? r.summary ?? r.description) || undefined,
      rank: r.rank == null ? i + 1 : text(r.rank),
      score: text(r.score ?? r.change24hPct ?? r.hot) || undefined,
      tone,
    };
  });
}

function normalizeStatItems(data: unknown, fallbackTone: Tone = "slate"): StatItem[] {
  return rowsOf(data).map((r, i) => {
    const symbol = text(r.symbol ?? r.label ?? r.ticker ?? r.name, `#${i + 1}`);
    const name = text(r.name ?? r.sub ?? r.description);
    const rawDelta = r.change24hPct ?? r.delta ?? r.change ?? r.changePct;
    const deltaNum = Number(rawDelta);
    const delta = rawDelta == null || rawDelta === ""
      ? undefined
      : Number.isFinite(deltaNum)
        ? `${deltaNum >= 0 ? "+" : ""}${deltaNum.toFixed(2)}%`
        : text(rawDelta);
    return {
      label: symbol.toUpperCase(),
      value: r.price == null ? text(r.value, "—") : compactCurrency(r.price),
      delta,
      sub: name || undefined,
      tone: (text(r.tone) as Tone) || fallbackTone,
    };
  });
}

function StatCard({ label, value, delta, sub, trend, tone, href }: StatItem) {
  const body = (
    <div className={`ux-stat-card group min-w-0 ${tone ? toneClasses[tone].ring : ""}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {label}
        </div>
        {delta ? (
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${trendTone(delta, trend, tone)}`}>
            {delta}
          </span>
        ) : null}
      </div>
      <div className="mt-2 truncate text-2xl font-black leading-none tabular-nums text-foreground md:text-[26px]">
        {value}
      </div>
      {sub ? <div className="mt-2 truncate text-xs text-muted-foreground">{sub}</div> : null}
    </div>
  );
  if (!href) return body;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {body}
    </a>
  );
}

function MetricGrid({
  title,
  eyebrow,
  columns = 3,
  items = [],
  data,
  status = "ready",
  loadingText = "加载中…",
  emptyText = "暂无数据",
  errorText = "加载失败",
  compact = false,
  emit,
}: {
  title?: string;
  eyebrow?: string;
  columns?: number;
  items?: StatItem[];
  data?: unknown;
  status?: "idle" | "loading" | "ready" | "error";
  loadingText?: string;
  emptyText?: string;
  errorText?: string;
  compact?: boolean;
  emit?: (event: string) => void | Promise<void>;
}) {
  const liveItems = normalizeStatItems(data, "amber");
  const normalized = liveItems.length ? liveItems : items;
  const autoLoading = useAutoMount(emit, `metric:${title ?? ""}:${eyebrow ?? ""}`, status === "idle" && !liveItems.length);
  const showLoading = status === "loading" || (autoLoading && !normalized.length) || (status === "idle" && !normalized.length);
  const showReady = status === "ready" || status === "idle" || (status === "error" && normalized.length);
  return (
    <section className="ux-panel">
      {title || eyebrow ? (
        <div className="ux-panel-head">
          <div>
            {eyebrow ? <div className="ux-eyebrow">{eyebrow}</div> : null}
            {title ? <h2>{title}</h2> : null}
          </div>
        </div>
      ) : null}
      {showLoading ? <StateLine label={loadingText} loading /> : null}
      {status === "error" ? <StateLine label={errorText} tone="error" /> : null}
      {showReady && !normalized.length ? <StateLine label={emptyText} /> : null}
      {showReady && normalized.length ? (
        <div
          className={`ux-metric-grid ${compact ? "ux-metric-grid-compact" : ""}`}
          style={{ "--metric-cols": String(Math.max(1, Math.min(6, columns))) } as CSSProperties}
        >
          {normalized.map((it, i) => (
            <StatCard key={`${it.label}-${i}`} {...it} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function FeedList({
  title,
  source,
  accent = "slate",
  items,
  emptyText = "暂无数据",
  loadingText = "加载中…",
  errorText = "加载失败",
  status = "ready",
  limit = 8,
  emit,
}: {
  title: string;
  source?: string;
  accent?: Tone;
  items?: FeedItem[];
  emptyText?: string;
  loadingText?: string;
  errorText?: string;
  status?: "idle" | "loading" | "ready" | "error";
  limit?: number;
  emit?: (event: string) => void | Promise<void>;
}) {
  const normalized = normalizeFeedItems(items, accent).slice(0, limit);
  const autoLoading = useAutoMount(emit, `feed:${title}:${source ?? ""}:${accent}:${limit}`, status === "idle" && !normalized.length);
  const showLoading = status === "loading" || autoLoading;
  const showReady = status === "ready" || (status === "idle" && !autoLoading) || (status === "error" && normalized.length);
  return (
    <section className="ux-panel ux-feed">
      <div className="ux-panel-head">
        <div className={`ux-source-icon ${toneClasses[accent].icon}`}>{title.slice(0, 1)}</div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate">{title}</h2>
          {source ? <div className="ux-source-label truncate">{source}</div> : null}
        </div>
      </div>
      {showLoading ? <StateLine label={loadingText} loading /> : null}
      {status === "idle" && !autoLoading ? <StateLine label={emptyText} /> : null}
      {status === "error" ? <StateLine label={errorText} tone="error" /> : null}
      {showReady && !normalized.length ? <StateLine label={emptyText} /> : null}
      {showReady && normalized.length ? (
        <div className="ux-feed-list">
          {normalized.map((item, i) => (
            <FeedRow item={item} accent={item.tone ?? accent} fallbackRank={i + 1} key={`${item.title}-${i}`} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function FeedRow({ item, accent, fallbackRank }: { item: FeedItem; accent: Tone; fallbackRank: number }) {
  const content = (
    <>
      <span className={`ux-rank ${fallbackRank <= 3 ? toneClasses[accent].chip : ""}`}>
        {item.rank ?? fallbackRank}
      </span>
      <span className="min-w-0 flex-1">
        <span className="ux-feed-title">{item.title}</span>
        {item.snippet ? <span className="ux-feed-snippet">{item.snippet}</span> : null}
      </span>
      <span className="ux-feed-meta">
        {item.score ? <b>{item.score}</b> : null}
        {item.meta ?? item.source ?? ""}
      </span>
    </>
  );
  const className = `ux-feed-row ${item.url ? "ux-feed-row-link" : ""}`;
  if (!item.url) return <div className={className}>{content}</div>;
  return (
    <a className={className} href={item.url} target="_blank" rel="noreferrer">
      {content}
    </a>
  );
}

function WeatherPanel({
  title = "天气",
  source = "wttr current",
  location,
  data,
  status = "ready",
  emptyText = "点击刷新天气",
  errorText = "天气加载失败",
  emit,
}: {
  title?: string;
  source?: string;
  location?: string;
  data?: unknown;
  status?: "idle" | "loading" | "ready" | "error";
  emptyText?: string;
  errorText?: string;
  emit?: (event: string) => void | Promise<void>;
}) {
  const row = rowsOf(data)[0] ?? {};
  const loc = text(row.location ?? row.area ?? row.city, location ?? "Shanghai");
  const temp = text(row.temperature ?? row.temp_C ?? row.tempC ?? row.temperatureC ?? row.temp ?? row.feelsLike, "—");
  const cond = text(row.condition ?? row.weatherDesc ?? row.description ?? row.summary);
  const facts = Object.entries(row)
    .filter(([k]) => /humid|wind|feel|uv|pressure|visib/i.test(k))
    .slice(0, 4)
    .map(([k, v]) => ({ label: k, value: text(v, "—") }));
  const autoLoading = useAutoMount(emit, `weather:${title}:${source}:${location ?? ""}`, status === "idle" && !data);
  const showLoading = status === "loading" || autoLoading;
  const showReady = status === "ready" || (status === "idle" && !autoLoading);

  return (
    <section className="ux-panel ux-weather">
      <div className="ux-panel-head">
        <div className={`ux-source-icon ${toneClasses.blue.icon}`}>天</div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate">{title}</h2>
          <div className="ux-source-label truncate">{source}</div>
        </div>
      </div>
      {showLoading ? <StateLine label="天气加载中…" loading /> : null}
      {status === "idle" && !autoLoading ? <StateLine label={emptyText} /> : null}
      {status === "error" ? <StateLine label={errorText} tone="error" /> : null}
      {showReady ? (
        <div className="ux-weather-body">
          <div className="text-[34px] font-black leading-none tabular-nums">
            {temp}
            {/\d$/.test(temp) ? "°" : ""}
          </div>
          <div className="mt-2 text-sm text-muted-foreground">{loc}{cond ? ` · ${cond}` : ""}</div>
          {facts.length ? (
            <div className="ux-weather-facts">
              {facts.map((f) => (
                <div key={f.label}>
                  <span>{f.label}</span>
                  <b>{f.value}</b>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// ── Map (Leaflet + 高德 raster tiles) ────────────────────────────────────────
// Both the tiles and the amap data are GCJ-02, so pins land correctly with NO
// coordinate conversion anywhere. Tiles load as <img> over https, which the
// served-page CSP (img-src https:) already permits.
type MapPoint = {
  lat: number;
  lng: number;
  title: string;
  subtitle?: string;
  rating?: string;
  href?: string;
  id?: string;
  tone?: Tone;
};

const toneHex: Record<Tone, string> = {
  blue: "#3b82f6",
  pink: "#ec4899",
  red: "#ef4444",
  amber: "#f59e0b",
  emerald: "#10b981",
  violet: "#8b5cf6",
  slate: "#475569",
};

// Resolve a field path ("lat", "geo.lat") off a row. amap rows are flat (lat/lng).
function pickPath(row: Record<string, unknown>, path: string): unknown {
  if (!path) return undefined;
  if (path in row) return row[path];
  return path.split(".").reduce<unknown>(
    (acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined),
    row,
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch] ?? ch));
}

function popupHtml(p: MapPoint): string {
  const parts = [`<div class="ux-map-pop-title">${escapeHtml(p.title)}</div>`];
  const meta = [p.rating ? `★ ${escapeHtml(p.rating)}` : "", p.subtitle ? escapeHtml(p.subtitle) : ""]
    .filter(Boolean)
    .join(" · ");
  if (meta) parts.push(`<div class="ux-map-pop-meta">${meta}</div>`);
  if (p.href) {
    parts.push(`<a class="ux-map-pop-link" href="${escapeHtml(p.href)}" target="_blank" rel="noreferrer">查看详情 →</a>`);
  }
  return parts.join("");
}

function pinIcon(tone: Tone = "blue", selected = false): L.DivIcon {
  const color = toneHex[tone];
  const scale = selected ? 1.18 : 1;
  const w = Math.round(26 * scale);
  const h = Math.round(34 * scale);
  const svg =
    `<svg width="${w}" height="${h}" viewBox="0 0 26 34" xmlns="http://www.w3.org/2000/svg">` +
    `<path d="M13 0C5.8 0 0 5.8 0 13c0 9.2 13 21 13 21s13-11.8 13-21C26 5.8 20.2 0 13 0z" ` +
    `fill="${color}" stroke="#ffffff" stroke-width="1.5"/>` +
    `<circle cx="13" cy="13" r="5" fill="#ffffff"/></svg>`;
  return L.divIcon({
    className: "ux-map-pin",
    html: svg,
    iconSize: [w, h],
    iconAnchor: [Math.round(w / 2), h],
    popupAnchor: [0, -Math.round(h * 0.85)],
  });
}

function toMapPoints(rows: Record<string, unknown>[], latPath: string, lngPath: string, titlePath: string): MapPoint[] {
  return rows.map((r, i) => ({
    lat: Number(pickPath(r, latPath)),
    lng: Number(pickPath(r, lngPath)),
    title: text(pickPath(r, titlePath) ?? r.title ?? r.name, `地点 ${i + 1}`),
    subtitle: text(r.subtitle ?? r.address ?? r.district) || undefined,
    rating: text(r.rating) || undefined,
    href: text(r.href ?? r.url ?? r.link) || undefined,
    id: text(r.id ?? r.poiId) || undefined,
    tone: (text(r.tone) as Tone) || undefined,
  }));
}

function MapView({
  title = "地图",
  source,
  center,
  zoom,
  height = 400,
  markers,
  data,
  latPath = "lat",
  lngPath = "lng",
  titlePath = "name",
  selectedId,
  status = "ready",
  loadingText = "地图加载中…",
  emptyText = "暂无可定位的地点",
  errorText = "地图数据加载失败",
  emit,
}: {
  title?: string;
  source?: string;
  center?: { lat: number; lng: number };
  zoom?: number;
  height?: number;
  markers?: MapPoint[];
  data?: unknown;
  latPath?: string;
  lngPath?: string;
  titlePath?: string;
  selectedId?: string;
  status?: "idle" | "loading" | "ready" | "error";
  loadingText?: string;
  emptyText?: string;
  errorText?: string;
  emit?: (event: string, payload?: unknown) => void | Promise<void>;
}) {
  const rows = markers ?? rowsOf(data);
  const allPts = toMapPoints(rows, latPath, lngPath, titlePath);
  const pts = allPts.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  const missing = allPts.length - pts.length;

  const autoLoading = useAutoMount(emit, `map:${title}:${source ?? ""}`, status === "idle" && !data);
  const showLoading = status === "loading" || (autoLoading && !pts.length);
  const showError = status === "error" && !pts.length;
  const showEmpty = !showLoading && !showError && !pts.length;

  const ref = useRef<HTMLDivElement | null>(null);
  // Keep emit stable across renders so the map is not torn down on every render.
  const emitRef = useRef(emit);
  emitRef.current = emit;

  const signature = JSON.stringify({
    pts: pts.map((p) => [p.lat, p.lng, p.id, p.tone]),
    center,
    zoom,
    selectedId,
  });

  useEffect(() => {
    const el = ref.current;
    if (!el || !pts.length) return;
    const map = L.map(el, { attributionControl: true, zoomControl: true });
    L.tileLayer("https://wprd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&style=7&x={x}&y={y}&z={z}", {
      subdomains: ["1", "2", "3", "4"],
      maxZoom: 19,
      attribution: "© 高德地图",
    }).addTo(map);

    pts.forEach((p) => {
      const marker = L.marker([p.lat, p.lng], {
        icon: pinIcon(p.tone, !!selectedId && p.id === selectedId),
        title: p.title,
      }).addTo(map);
      marker.bindPopup(popupHtml(p));
      marker.on("click", () => {
        void emitRef.current?.("select", { id: p.id });
      });
    });

    if (center) {
      map.setView([center.lat, center.lng], zoom ?? 13);
    } else if (pts.length === 1) {
      map.setView([pts[0].lat, pts[0].lng], zoom ?? 15);
    } else {
      map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng] as [number, number])), { padding: [42, 42] });
    }

    // The container is sized via flex/CSS after mount; nudge Leaflet to remeasure.
    const t = window.setTimeout(() => map.invalidateSize(), 60);
    return () => {
      window.clearTimeout(t);
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return (
    <section className="ux-panel ux-map">
      <div className="ux-panel-head">
        <div className={`ux-source-icon ${toneClasses.emerald.icon}`}>图</div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate">{title}</h2>
          {source ? <div className="ux-source-label truncate">{source}</div> : null}
        </div>
        {pts.length ? <span className="ux-map-count">{pts.length} 个地点</span> : null}
      </div>
      {showLoading ? <StateLine label={loadingText} loading /> : null}
      {showError ? <StateLine label={errorText} tone="error" /> : null}
      {showEmpty ? <StateLine label={emptyText} /> : null}
      {pts.length ? (
        <>
          <div className="ux-map-canvas" ref={ref} style={{ height }} />
          {missing > 0 ? <div className="ux-map-note">{missing} 个地点缺少坐标，未在地图上显示</div> : null}
        </>
      ) : null}
    </section>
  );
}

function SearchPanel({
  title = "全网聚合搜索",
  placeholder = "搜索 opencli / 产品 / 城市生活…",
  source = "agg search",
  queryPath,
  queryValue = "",
  status = "idle",
  errorText = "搜索失败",
  items,
  emit,
}: {
  title?: string;
  placeholder?: string;
  source?: string;
  queryPath?: string;
  queryValue?: string;
  status?: "idle" | "loading" | "ready" | "error";
  errorText?: string;
  items?: FeedItem[];
  emit?: (event: string) => void;
}) {
  const inputId = `ux-search-${(queryPath ?? "q").replace(/[^a-z0-9]/gi, "-")}`;
  return (
    <section className="ux-search-panel">
      <div className="ux-search-head">
        <div>
          <h2>{title}</h2>
          <p>{source}</p>
        </div>
        <span className="ux-live-pill">live</span>
      </div>
      <div className="ux-searchbar">
        <input
          id={inputId}
          name={queryPath ?? "q"}
          placeholder={placeholder}
          defaultValue={queryValue}
          onChange={(event) => {
            if (!queryPath) return;
            window.dispatchEvent(new CustomEvent("ux:set-state", { detail: { path: queryPath, value: event.currentTarget.value } }));
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") emit?.("search");
          }}
        />
        <button type="button" onClick={() => emit?.("search")}>搜索</button>
      </div>
      {status === "loading" ? <StateLine label="聚合多平台中…" loading /> : null}
      {status === "error" ? <StateLine label={errorText} tone="error" /> : null}
      {status === "ready" ? (
        <div className="mt-4">
          <FeedList title="搜索结果" source={source} accent="violet" items={items} status="ready" limit={10} />
        </div>
      ) : null}
    </section>
  );
}

function PortalShell({
  title,
  accentText,
  subtitle,
  tags = [],
  footer,
  emit,
  children,
}: {
  title: string;
  accentText?: string;
  subtitle?: string;
  tags?: string[];
  footer?: string;
  emit?: (event: string) => void | Promise<void>;
  children?: ReactNode;
}) {
  useAutoMount(emit, `portal:${title}:${accentText ?? ""}:${subtitle ?? ""}:${tags.join("|")}:${footer ?? ""}`);
  return (
    <main className="ux-portal-shell">
      <header className="ux-portal-header">
        <div className="ux-brand">
          {title}
          {accentText ? <span>{accentText}</span> : null}
        </div>
        {subtitle ? <p>{subtitle}</p> : null}
        {tags.length ? (
          <nav className="ux-tag-row" aria-label="quick links">
            {tags.map((tag) => <span key={tag}>{tag}</span>)}
          </nav>
        ) : null}
      </header>
      <div className="ux-portal-content">{children}</div>
      {footer ? <footer className="ux-portal-footer">{footer}</footer> : null}
    </main>
  );
}

function StateLine({ label, loading, tone }: { label: string; loading?: boolean; tone?: "error" }) {
  return (
    <div className={`ux-state-line ${tone === "error" ? "ux-state-error" : ""}`}>
      {loading ? <span className="ux-spinner" /> : null}
      {label}
    </div>
  );
}

type ActionHandler = (params: Record<string, unknown>) => void | Promise<void>;

function statePathSegment(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function readBoundQuery(store: StateStore | null, path?: unknown): string | undefined {
  if (!store || typeof path !== "string" || !path) return undefined;
  return text(store.get(path)).trim() || undefined;
}

function parseDataParams(params: Record<string, unknown>, store: StateStore | null): { key: string; request: UxDataRequest } {
  const key = text(params.key);
  const rawRequest = params.request;
  if (!key) throw new Error("ux_data requires key");
  if (!rawRequest || typeof rawRequest !== "object" || Array.isArray(rawRequest)) throw new Error("ux_data requires request");
  const request = rawRequest as Record<string, unknown>;
  const args = request.args && typeof request.args === "object" && !Array.isArray(request.args)
    ? { ...(request.args as Record<string, unknown>) }
    : {};
  const query = readBoundQuery(store, params.queryPath);
  const positional = Array.isArray(request.positional)
    ? request.positional.filter((v): v is string | number | boolean => ["string", "number", "boolean"].includes(typeof v))
    : [];
  if (query) {
    if (typeof params.queryArg === "string") args[params.queryArg] = query;
    else if (typeof params.queryIndex === "number") positional[params.queryIndex] = query;
    else if (!positional.length) positional.push(query);
  }
  return {
    key,
    request: {
      site: text(request.site),
      command: text(request.command),
      positional: positional as Array<string | number | boolean>,
      args,
    },
  };
}

export function createActionHandlers(store: StateStore | null): Record<string, ActionHandler> {
  return {
    ux_submit: async () => {
      const state = store ? store.getSnapshot() : getMirror();
      const values = getFormMeta().fields.length ? normalizeFormValues(state) : state;
      await postCallback({ submitted: true, action: "ux_submit", values });
      fireDone("已提交 ✓");
    },
    ux_confirm: async (params) => {
      const choice = params?.choice;
      await postCallback({ action: "ux_confirm", choice });
      fireDone(`已选择：${choice ?? ""} ✓`);
    },
    ux_cancel: async () => {
      await postCallback({ action: "ux_cancel" });
      fireDone("已取消");
    },
    ux_data: async (params) => {
      if (!store) throw new Error("ux_data requires a state store");
      const { key, request } = parseDataParams(params, store);
      const seg = statePathSegment(key);
      store.set(`/status/${seg}`, "loading");
      store.set(`/error/${seg}`, "");
      const result = await postData(request);
      if (result.ok) {
        store.set(`/data/${seg}`, result.data);
        store.set(`/status/${seg}`, "ready");
        return;
      }
      store.set(`/error/${seg}`, result.error ?? result.code ?? "opencli error");
      store.set(`/status/${seg}`, "error");
    },
  };
}

// Component registry — shadcn primitives + our styled templates. The `actions`
// entries satisfy defineRegistry's typed contract; per-surface handlers above
// are what JSONUIProvider executes.
const noop = async () => {};
export const { registry } = defineRegistry(uxCatalog, {
  components: {
    ...shadcnComponents,
    StatCard: ({ props }) => <StatCard {...props} />,
    MetricGrid: ({ props, emit }) => <MetricGrid {...props} emit={emit} />,
    FeedList: ({ props, emit }) => <FeedList {...props} emit={emit} />,
    WeatherPanel: ({ props, emit }) => <WeatherPanel {...props} emit={emit} />,
    Map: ({ props, emit }) => <MapView {...props} emit={emit} />,
    SearchPanel: ({ props, emit }) => <SearchPanel {...props} emit={emit} />,
    PortalShell: ({ props, children, emit }) => <PortalShell {...props} emit={emit}>{children}</PortalShell>,
  },
  actions: {
    ux_submit: noop,
    ux_confirm: noop,
    ux_cancel: noop,
    ux_data: noop,
  },
});
