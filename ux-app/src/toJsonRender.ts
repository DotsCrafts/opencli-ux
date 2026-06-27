// Translate the simple opencli-ux spec contract (README) into a json-render
// Spec built from whitelisted shadcn components. The LLM may emit EITHER a full
// json-render Spec ({root, elements}) — passed straight through — OR one of the
// simple shapes below, which this module lowers.
//
//   render : {title, items:[{title,subtitle,image,url,fields:{k:v}}]}
//   form   : {title, fields:[{name,type,label,options?}], submitLabel}
//            type ∈ text|textarea|number|email|password|select|multiselect|checkbox|switch
//   confirm: {message, options:[...], danger?}
import type { Spec } from "@json-render/core";
import type { UxMode } from "./api";

type El = NonNullable<Spec["elements"]>[string];

export interface SimpleField {
  name: string;
  type?: string;
  label?: string;
  options?: string[];
  placeholder?: string;
}

// Per-field metadata captured during lowering so the submit handler can shape
// raw json-render state back into clean values (arrays for multiselect,
// numbers for number inputs). Kept module-level: the registry's ux_submit
// handler is generic and reads this after lowering runs.
export interface FormMeta {
  fields: SimpleField[];
}
let formMeta: FormMeta = { fields: [] };
export const getFormMeta = (): FormMeta => formMeta;

const MS_ROOT = "__ms"; // scratch state namespace for multiselect checkboxes

function isJsonRenderSpec(spec: unknown): spec is Spec {
  return (
    !!spec &&
    typeof spec === "object" &&
    "root" in (spec as object) &&
    "elements" in (spec as object)
  );
}

export function toJsonRenderSpec(mode: UxMode, raw: unknown): Spec {
  // Full json-render Spec → pass through untouched (catalog still guards it).
  if (isJsonRenderSpec(raw)) {
    formMeta = { fields: [] };
    return raw;
  }
  const simple = (raw ?? {}) as Record<string, unknown>;
  if (mode === "form") return lowerForm(simple);
  if (mode === "confirm") return lowerConfirm(simple);
  return lowerRender(simple);
}

// ---------- render ----------
function lowerRender(s: Record<string, unknown>): Spec {
  formMeta = { fields: [] };
  const elements: Record<string, El> = {};
  const items = Array.isArray(s.items) ? (s.items as Record<string, unknown>[]) : [];
  const crypto = items.filter((it) => String(it.title ?? "").includes("[币价]"));
  const weather = items.find((it) => String(it.title ?? "").includes("[天气]"));
  const feed = items.filter((it) => it.url || /^\[(arXiv|36氪|B站)/.test(String(it.title ?? "")));
  const misc = items.filter((it) => !crypto.includes(it) && it !== weather && !feed.includes(it));
  const shellChildren: string[] = [];

  if (crypto.length) {
    elements.crypto = {
      type: "MetricGrid",
      props: {
        title: "币价 Top",
        eyebrow: "coingecko top",
        columns: Math.min(4, crypto.length),
        items: crypto.map((it) => {
          const rawTitle = String(it.title ?? "").replace(/^\[币价\]\s*/, "");
          const [symbol, name] = rawTitle.split(" · ");
          const fields = (it.fields ?? {}) as Record<string, unknown>;
          const delta = String(fields["24h涨跌"] ?? fields.change24hPct ?? "");
          return {
            label: symbol || rawTitle,
            value: String(it.subtitle ?? "—"),
            delta: delta || undefined,
            sub: name || undefined,
            tone: "amber",
          };
        }),
      },
    };
    shellChildren.push("crypto");
  }

  if (weather) {
    const title = String(weather.title ?? "").replace(/^\[天气\]\s*/, "") || "天气";
    elements.weather = {
      type: "WeatherPanel",
      props: {
        title: `天气 · ${title}`,
        location: String(weather.subtitle ?? title),
        data: [weather.fields ?? {}],
        status: "ready",
      },
    };
    shellChildren.push("weather");
  }

  if (feed.length) {
    elements.feed = {
      type: "FeedList",
      props: {
        title: "热点",
        source: "arxiv recent · 36kr news",
        accent: "blue",
        status: "ready",
        items: feed.map((it, i) => ({
          rank: i + 1,
          title: String(it.title ?? "").replace(/^\[[^\]]+\]\s*/, ""),
          url: it.url ? String(it.url) : undefined,
          source: String(it.title ?? "").match(/^\[([^\]]+)\]/)?.[1] ?? undefined,
          meta: it.subtitle ? String(it.subtitle) : undefined,
        })),
      },
    };
    shellChildren.push("feed");
  }

  if (misc.length) {
    elements.misc = {
      type: "FeedList",
      props: {
        title: "更多",
        source: "opencli render",
        accent: "slate",
        status: "ready",
        items: misc.map((it, i) => ({
          rank: i + 1,
          title: String(it.title ?? "Untitled"),
          url: it.url ? String(it.url) : undefined,
          meta: it.subtitle ? String(it.subtitle) : undefined,
          snippet: Object.entries((it.fields ?? {}) as Record<string, unknown>)
            .map(([k, v]) => `${k}: ${v}`)
            .join(" · "),
        })),
      },
    };
    shellChildren.push("misc");
  }

  elements.root = {
    type: "PortalShell",
    props: {
      title: String(s.title ?? "Render"),
      accentText: "",
      subtitle: "opencli 内核驱动 · json-render 模板渲染 · 本地隔离 origin",
      tags: ["B站排行", "36氪", "arXiv", "币价", "天气", "聚合搜索"],
      footer: "opencli ux · catalog-whitelisted json-render",
    },
    children: shellChildren,
  };
  return { root: "root", state: {}, elements };
}

// ---------- form ----------
function lowerForm(s: Record<string, unknown>): Spec {
  const rawFields = Array.isArray(s.fields) ? (s.fields as SimpleField[]) : [];
  formMeta = { fields: rawFields };

  const elements: Record<string, El> = {};
  const state: Record<string, unknown> = {};
  const formChildren: string[] = [];

  if (s.title) {
    elements.title = {
      type: "Heading",
      props: { text: String(s.title), level: "h3" },
    };
    formChildren.push("title");
  }

  rawFields.forEach((f, fi) => {
    const id = `field${fi}`;
    const type = f.type ?? "text";
    const label = f.label ?? f.name;

    if (type === "multiselect") {
      // Render one Checkbox per option, bound into a scratch namespace, then
      // wrap with a label. normalizeFormValues collapses to an array.
      const groupChildren: string[] = [];
      const labelId = `${id}_label`;
      elements[labelId] = { type: "Text", props: { text: label, variant: "caption" } };
      groupChildren.push(labelId);

      (f.options ?? []).forEach((opt, oi) => {
        const cbId = `${id}_opt${oi}`;
        const path = `/${MS_ROOT}/${fi}/${oi}`;
        elements[cbId] = {
          type: "Checkbox",
          props: { label: opt, name: `${f.name}__${oi}`, checked: { $bindState: path } as never },
        };
        groupChildren.push(cbId);
      });
      const msState = (state[MS_ROOT] ??= {}) as Record<string, unknown>;
      msState[String(fi)] = {};

      elements[id] = {
        type: "Stack",
        props: { direction: "vertical", gap: "sm" },
        children: groupChildren,
      };
      formChildren.push(id);
      return;
    }

    if (type === "select") {
      state[f.name] = "";
      elements[id] = {
        type: "Select",
        props: {
          label,
          name: f.name,
          options: f.options ?? [],
          placeholder: f.placeholder ?? "请选择",
          value: { $bindState: `/${f.name}` } as never,
          checks: null,
        },
      };
      formChildren.push(id);
      return;
    }

    if (type === "checkbox" || type === "switch" || type === "boolean") {
      state[f.name] = false;
      elements[id] = {
        type: type === "checkbox" ? "Checkbox" : "Switch",
        props: { label, name: f.name, checked: { $bindState: `/${f.name}` } as never },
      };
      formChildren.push(id);
      return;
    }

    if (type === "textarea") {
      state[f.name] = "";
      elements[id] = {
        type: "Textarea",
        props: {
          label,
          name: f.name,
          placeholder: f.placeholder ?? null,
          rows: 4,
          value: { $bindState: `/${f.name}` } as never,
          checks: null,
        },
      };
      formChildren.push(id);
      return;
    }

    // text | email | password | number → Input
    state[f.name] = "";
    const inputType = ["email", "password", "number"].includes(type) ? type : "text";
    elements[id] = {
      type: "Input",
      props: {
        label,
        name: f.name,
        type: inputType,
        placeholder: f.placeholder ?? null,
        value: { $bindState: `/${f.name}` } as never,
        checks: null,
      },
    };
    formChildren.push(id);
  });

  // submit / cancel buttons
  elements.submitBtn = {
    type: "Button",
    props: { label: String(s.submitLabel ?? "提交"), variant: "primary" },
    on: { press: { action: "ux_submit" } },
  };
  elements.cancelBtn = {
    type: "Button",
    props: { label: "取消", variant: "secondary" },
    on: { press: { action: "ux_cancel" } },
  };
  elements.actions = {
    type: "Stack",
    props: { direction: "horizontal", gap: "sm", justify: "end" },
    children: ["cancelBtn", "submitBtn"],
  };
  formChildren.push("actions");

  elements.form = {
    type: "Stack",
    props: { direction: "vertical", gap: "md" },
    children: formChildren,
  };
  elements.root = {
    type: "Card",
    props: { title: s.title ? null : "表单", description: null, maxWidth: "md" },
    children: ["form"],
  };
  return { root: "root", state, elements };
}

// ---------- confirm ----------
function lowerConfirm(s: Record<string, unknown>): Spec {
  formMeta = { fields: [] };
  const elements: Record<string, El> = {};
  const options = Array.isArray(s.options) && s.options.length ? (s.options as string[]) : ["允许", "拒绝"];

  elements.msg = {
    type: "Text",
    props: { text: String(s.message ?? "确认?"), variant: "lead" },
  };
  const bodyChildren = ["msg"];

  if (s.danger) {
    elements.danger = {
      type: "Alert",
      props: { title: "敏感操作", message: "请确认你了解此操作的影响。", type: "warning" },
    };
    bodyChildren.push("danger");
  }

  const btnIds: string[] = [];
  options.forEach((opt, i) => {
    const id = `opt${i}`;
    elements[id] = {
      type: "Button",
      props: { label: opt, variant: i === 0 ? "primary" : "secondary" },
      on: { press: { action: "ux_confirm", params: { choice: opt } } },
    };
    btnIds.push(id);
  });
  elements.actions = {
    type: "Stack",
    props: { direction: "horizontal", gap: "sm", justify: "end" },
    children: btnIds,
  };
  bodyChildren.push("actions");

  elements.body = {
    type: "Stack",
    props: { direction: "vertical", gap: "md" },
    children: bodyChildren,
  };
  elements.root = {
    type: "Card",
    props: { title: "确认", description: null, maxWidth: "md" },
    children: ["body"],
  };
  return { root: "root", state: {}, elements };
}

// ---------- value normalization ----------
// json-render state for a lowered form is flat by field name, except
// multiselect lives under __ms/<fieldIndex>/<optIndex> as booleans. Shape it
// back into the clean {name: value} the CLI expects.
export function normalizeFormValues(state: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const ms = (state[MS_ROOT] ?? {}) as Record<string, Record<string, unknown>>;

  formMeta.fields.forEach((f, fi) => {
    const type = f.type ?? "text";
    if (type === "multiselect") {
      const picks = ms[String(fi)] ?? {};
      out[f.name] = (f.options ?? []).filter((_, oi) => !!picks[String(oi)]);
      return;
    }
    const v = state[f.name];
    if (type === "number") {
      out[f.name] = v === "" || v == null ? null : Number(v);
      return;
    }
    out[f.name] = v ?? (type === "checkbox" || type === "switch" || type === "boolean" ? false : "");
  });
  return out;
}
