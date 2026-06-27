# opencli ux — opencli ↔ 用户 的交互层

按 `opencli-ux-jsonrender-v2.html` 实现的"双向 UX 通道":opencli 把 UI **渲染给用户**(render)、**接住用户输入**(form / confirm)、再经 opencli **回写真实应用**。补上这一层,系统坍缩成 **opencli + chromium + 薄 LLM**。

## 现状
- ✅ **命令可用(已测)**:`ux.mjs` —— CLI + 本地隔离-origin 服务 + 一次性 token callback + 阻塞式捕获。
- ✅ **内置极简渲染器**(零依赖 fallback),命令现在就能跑。
- ⏳ **json-render 渲染引擎**(`ux-app/dist`)为可插拔升级:构建后自动取代 fallback(见下)。

## 用法
```bash
# 渲染结果给用户(不阻塞)
node ux.mjs render  --spec examples/render.json

# 渲染表单,阻塞到用户提交,返回捕获的 values
node ux.mjs form    --spec examples/form.json --timeout 300

# 渲染 block/审批确认,返回用户选择
node ux.mjs confirm --spec examples/confirm.json

# spec 也可从 stdin:  echo '<spec>' | node ux.mjs form --spec -
# 无头/调试:--no-open(不开浏览器),stderr 打印 listening URL
```

输出(stdout,JSON):
- `form` → `{"submitted":true,"action":"ux_submit","values":{...}}`
- `confirm` → `{"action":"ux_confirm","choice":"允许"}`
- `render` → `{"rendered":true,"url":"...","session":"..."}`

## 安全(v2)
- UX 页是**独立 origin**(`http://127.0.0.1:<port>`),**绝不**注入到已登录站点 tab。
- callback 需 **一次性 token + Origin 校验**(实测:错 token → 403)。
- 登录类动作永远走 opencli 原生 `opencli <site> login`(在真实域名下),**不在 UX 页里做**。

## spec 契约(fallback 渲染器)
```jsonc
// render: {title, items:[{title,subtitle,image,url,fields:{k:v}}]}
// form:   {title, fields:[{name,type,label,options?}], submitLabel}
//         type ∈ text|textarea|number|select|multiselect
// confirm:{message, options:[...], danger?}
```

## json-render 升级(可插拔,构建即生效)
`ux.mjs` 优先服务 `ux-app/dist/`(若存在),否则用内置 fallback。把 v2 的 json-render 引擎接上 = 在 `ux-app/` 构建一个 react + json-render 应用:

```ts
// catalog（白名单守护 = 安全边界）
import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { shadcnComponentDefinitions } from "@json-render/shadcn/catalog";
export const uxCatalog = defineCatalog(schema, {
  components: { ...shadcnComponentDefinitions },          // 36 个 shadcn 组件
  actions: { ux_submit:{description:"提交"}, ux_confirm:{description:"确认"}, ux_cancel:{description:"取消"} },
});

// registry — action handler 签名是 (params, setState, state):state 里就是表单值
import { defineRegistry } from "@json-render/react";
import { shadcnComponents } from "@json-render/shadcn";
export const { registry } = defineRegistry(uxCatalog, {
  components: { ...shadcnComponents },
  actions: {
    ux_submit:  async (_p,_s,state) => postCallback({submitted:true,action:"ux_submit",values:state}),
    ux_confirm: async (params)      => postCallback({action:"ux_confirm",choice:params?.choice}),
    ux_cancel:  async ()            => postCallback({action:"ux_cancel"}),
  },
});

// main — fetch /ux/config → {session,token,spec,mode};  postCallback 带 x-ux-token
import { JSONUIProvider, Renderer } from "@json-render/react";
// <JSONUIProvider registry={registry} handlers={handlers} initialState={spec.state ?? {}}>
//   <Renderer spec={spec} registry={registry} />
// </JSONUIProvider>
```
LLM 产 json-render Spec(`{root, elements, state}`,只能用 catalog 组件,Zod 校验)→ `ux.mjs` 透传 → json-render 渲染。catalog 守护让"LLM-UI 注入"**结构上不可能**(见 v2 §2)。

**构建步骤(待跑)**:`cd ux-app && pnpm i && pnpm build` → 产出 `dist/`;`ux.mjs` 自动切换到 json-render。fallback 与 json-render 走**同一 callback 协议**,切换透明。

## 作为 opencli 插件
`opencli-plugin.json` 已就绪。把 `render/form/confirm` 包成 `cli({site:'ux', ...})`(strategy UI,browser:true,跑在客户端),内部调用本目录逻辑即可 —— 见 v2 §8。
