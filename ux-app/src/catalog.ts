// Catalog = the security boundary. The renderer can ONLY instantiate the
// shadcn components listed here and ONLY dispatch the actions declared here, so
// an adversarial LLM-produced spec is structurally unable to inject anything
// outside this whitelist (opencli-ux-jsonrender-v2 §2).
import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { shadcnComponentDefinitions } from "@json-render/shadcn/catalog";
import { z } from "zod";

// A styled metric tile. `delta` like "+2.3%" / "-1.1%"; trend overrides the sign-based tone.
const statItemSchema = z.object({
  label: z.string(),
  value: z.union([z.string(), z.number()]),
  delta: z.string().optional(),
  sub: z.string().optional(),
  trend: z.enum(["up", "down", "flat"]).optional(),
  tone: z.enum(["blue", "pink", "red", "amber", "emerald", "violet", "slate"]).optional(),
  href: z.string().optional(),
});

const feedItemSchema = z.object({
  title: z.string(),
  url: z.string().optional(),
  source: z.string().optional(),
  meta: z.string().optional(),
  snippet: z.string().optional(),
  rank: z.union([z.string(), z.number()]).optional(),
  score: z.string().optional(),
  tone: z.enum(["blue", "pink", "red", "amber", "emerald", "violet", "slate"]).optional(),
});

// A single map marker. lat/lng are GCJ-02 (matches 高德 raster tiles + amap data,
// so NO datum conversion is done anywhere downstream).
const markerSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  title: z.string(),
  subtitle: z.string().optional(), // 地址 / 营业时间
  rating: z.union([z.string(), z.number()]).optional(),
  price: z.string().optional(),
  href: z.string().optional(), // 详情 / 导航链接（新标签打开）
  id: z.string().optional(),
  tone: z.enum(["blue", "pink", "red", "amber", "emerald", "violet", "slate"]).optional(),
});

const dataRequestSchema = z.object({
  site: z.string(),
  command: z.string(),
  positional: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  args: z.record(z.string(), z.unknown()).optional(),
});

export const uxCatalog = defineCatalog(schema, {
  components: {
    ...shadcnComponentDefinitions,
    // ── custom styled templates (the "preset catalog template" pattern) ──
    StatCard: {
      props: statItemSchema,
      description: "单个指标卡:标签 + 大数值 + 涨跌徽章(绿涨/红跌)+ 副标题",
    },
    MetricGrid: {
      props: z.object({
        title: z.string().optional(),
        eyebrow: z.string().optional(),
        columns: z.number().int().min(1).max(6).optional(),
        items: z.array(statItemSchema).optional(),
        data: z.unknown().optional(),
        status: z.enum(["idle", "loading", "ready", "error"]).optional(),
        loadingText: z.string().optional(),
        emptyText: z.string().optional(),
        errorText: z.string().optional(),
        compact: z.boolean().optional(),
      }),
      description: "指标卡网格:一组 StatCard 的响应式栅格,带可选小标题",
    },
    FeedList: {
      props: z.object({
        title: z.string(),
        source: z.string().optional(),
        accent: z.enum(["blue", "pink", "red", "amber", "emerald", "violet", "slate"]).optional(),
        items: z.array(feedItemSchema).optional(),
        emptyText: z.string().optional(),
        loadingText: z.string().optional(),
        errorText: z.string().optional(),
        status: z.enum(["idle", "loading", "ready", "error"]).optional(),
        limit: z.number().int().min(1).max(30).optional(),
      }),
      description: "新闻/论文/搜索结果列表模板:标题、来源、序号、摘要、元信息与加载/错误态",
    },
    WeatherPanel: {
      props: z.object({
        title: z.string().optional(),
        source: z.string().optional(),
        location: z.string().optional(),
        data: z.unknown().optional(),
        status: z.enum(["idle", "loading", "ready", "error"]).optional(),
        emptyText: z.string().optional(),
        errorText: z.string().optional(),
      }),
      description: "天气模板:城市、温度、描述和湿度/风力/体感等关键指标",
    },
    SearchPanel: {
      props: z.object({
        title: z.string().optional(),
        placeholder: z.string().optional(),
        source: z.string().optional(),
        queryPath: z.string().optional(),
        queryValue: z.string().optional(),
        status: z.enum(["idle", "loading", "ready", "error"]).optional(),
        errorText: z.string().optional(),
        items: z.array(feedItemSchema).optional(),
      }),
      events: ["search"],
      description: "聚合搜索模板:输入框 + 搜索按钮 + 结果列表; search 事件可绑定 ux_data",
    },
    Map: {
      props: z.object({
        title: z.string().optional(),
        source: z.string().optional(),
        center: z.object({ lat: z.number(), lng: z.number() }).optional(), // 缺省自动 fitBounds
        zoom: z.number().min(1).max(20).optional(),
        height: z.number().int().min(160).max(900).optional(),
        markers: z.array(markerSchema).optional(), // 静态标注
        data: z.unknown().optional(), // 实时数据（rows → markers）
        latPath: z.string().optional(), // 字段映射（默认 lat）
        lngPath: z.string().optional(), // 字段映射（默认 lng）
        titlePath: z.string().optional(), // 字段映射（默认 name）
        selectedId: z.string().optional(), // 与 state 绑定：列表↔地图联动
        status: z.enum(["idle", "loading", "ready", "error"]).optional(),
        loadingText: z.string().optional(),
        emptyText: z.string().optional(),
        errorText: z.string().optional(),
      }),
      events: ["mount", "select"], // select：点标记 → 可绑 ux_data 拉详情 / 写 selectedId
      description:
        "地理地图（Leaflet + 高德栅格瓦片，GCJ-02）：把地点（经纬度）标注为标记点，支持实时取数、自动聚焦与点选联动",
    },
    PortalShell: {
      props: z.object({
        title: z.string(),
        accentText: z.string().optional(),
        subtitle: z.string().optional(),
        tags: z.array(z.string()).optional(),
        footer: z.string().optional(),
      }),
      slots: ["default"],
      description: "Render 门户页外壳模板:品牌头、标签行、响应式内容容器和页脚",
    },
  },
  actions: {
    ux_submit: { params: z.object({}).passthrough(), description: "提交表单，回传当前 state 作为 values" },
    ux_confirm: {
      params: z.object({ choice: z.string().optional() }).passthrough(),
      description: "确认选择，回传 choice",
    },
    ux_cancel: { params: z.object({}).passthrough(), description: "取消" },
    ux_data: {
      params: z.object({
        key: z.string(),
        request: dataRequestSchema,
      }),
      description: "从同源 /ux/data 读取 opencli 数据,并写入 state:/data/<key>, /status/<key>, /error/<key>",
    },
  },
});
