#!/usr/bin/env node
/**
 * opencli ux — the interaction layer between opencli and the user.
 *
 * Renders a UI spec in an isolated-origin browser tab and captures the user's
 * input (form submit / confirm choice) back through a one-time-token callback.
 * Follows opencli-ux-jsonrender-v2: the rendering engine is json-render
 * (served from ./ux-app/dist when built); a built-in minimal renderer is used
 * as a zero-dependency fallback so the command is runnable before that build.
 *
 * Usage:
 *   ux.mjs render  --spec <file|->  [--no-open] [--keep]
 *   ux.mjs form    --spec <file|->  [--timeout 300] [--no-open]
 *   ux.mjs confirm --spec <file|->  [--timeout 300] [--no-open]
 *
 * Output (-> stdout, JSON):
 *   render  : {"rendered":true,"url":"...","session":"..."}
 *   form    : {"submitted":true,"action":"ux_submit","values":{...}}
 *   confirm : {"action":"ux_confirm","choice":"allow"}
 *
 * Security (v2): UX page is its own origin (127.0.0.1:<port>), never injected
 * into a logged-in site tab; callback requires a one-time token + Origin check.
 */
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dir, 'ux-app', 'dist'); // built json-render app (optional)
const OPENCLI_APP_NODE = '/Applications/OpenCLIApp.app/Contents/Resources/node_modules/node/bin/node';
const OPENCLI_APP_MAIN = '/Applications/OpenCLIApp.app/Contents/Resources/node_modules/@jackwener/opencli/dist/src/main.js';

// ---------- args ----------
const argv = process.argv.slice(2);
const mode = argv[0];
if (!['render', 'form', 'confirm', 'serve'].includes(mode)) {
  console.error('usage: ux.mjs <render|form|confirm|serve> --spec <file|-> [--timeout 300] [--no-open] [--keep]');
  console.error('       ux.mjs serve --html <file|-> [--allow "site cmd,site cmd"] [--allow-write] [--profile render] [--no-open]');
  process.exit(2);
}
const flags = {};
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { const k = a.slice(2); const n = argv[i + 1]; if (n && !n.startsWith('--')) { flags[k] = n; i++; } else flags[k] = true; }
}
const timeoutMs = Number(flags.timeout || 300) * 1000;
const OPENCLI_DATA_TIMEOUT_MS = Number(process.env.OPENCLI_UX_DATA_TIMEOUT_MS || 20_000);

function readFileOrStdin(srcLabel, src) {
  try {
    return src === '-' ? readFileSync(0, 'utf8') : readFileSync(src, 'utf8');
  } catch (e) {
    console.error(`[ux] failed to read ${srcLabel} (${src}): ${e.message}`);
    process.exit(1);
  }
}

// render/form/confirm read a JSON spec; serve reads an HTML app instead.
const specSrc = mode === 'serve' ? (flags.spec || null) : (flags.spec || '-');
const spec = specSrc
  ? (() => { try { return JSON.parse(readFileOrStdin('spec', specSrc)); } catch (e) { console.error(`[ux] bad spec JSON: ${e.message}`); process.exit(1); } })()
  : null;

// serve mode: the interactive app HTML served at GET / (the agent authors it).
const appHtml = mode === 'serve' ? readFileOrStdin('html', flags.html || '-') : null;

// ---------- /ux/data capability: server-owned allowlist + read-only default ----------
// Allowlist of "<site> <command>" the served page may run. NEVER client-sent.
const ALLOW = new Set(
  String(flags.allow || (spec && spec.allow ? [].concat(spec.allow).join(',') : ''))
    .split(',').map((s) => s.trim()).filter(Boolean),
);
const ALLOW_WRITE = flags['allow-write'] === true || flags['allow-write'] === 'true';
const PROFILE = (typeof flags.profile === 'string' && flags.profile) || process.env.OPENCLI_PROFILE || 'render';
// Mutating verbs are rejected by default (read-only). Opt in with --allow-write.
const WRITE_VERBS = new Set([
  'login', 'add-cart', 'buy', 'book', 'order', 'pay', 'checkout', 'post', 'send',
  'cancel', 'delete', 'publish', 'follow', 'unfollow', 'like', 'comment', 'greet',
  'exchange', 'invite', 'mark', 'react', 'rename', 'revert', 'update', 'draft',
  'create', 'remove', 'archive', 'reply',
]);

// FIFO serializer: browser-backed opencli calls share ONE Chromium and wedge
// under concurrency, so /ux/data runs them one at a time (concurrency = 1).
let dataChain = Promise.resolve();
function runSerialized(fn) {
  const next = dataChain.then(fn, fn);
  dataChain = next.then(() => {}, () => {});
  return next;
}

// ---------- session + one-time token ----------
const session = randomUUID();
const token = randomBytes(24).toString('base64url');

// ---------- server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.map': 'application/json' };
let resolveCallback;
const captured = new Promise((res) => { resolveCallback = res; });

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

// CSP for served pages: same-origin only for scripts/data (the page can ONLY
// reach this server's /ux/data — no exfiltration), images allowed over https.
const PAGE_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https:; connect-src 'self'; base-uri 'none'; form-action 'none'";
function sendHtml(res, code, html) {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': PAGE_CSP });
  res.end(html);
}

// Exact Origin match (no wildcard port) — only this server's own origin.
function okOrigin(origin, port) {
  return origin === '' || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

// Build argv exactly as the artifact contract: positional first, then --flags,
// then -f json. Booleans: true → bare flag, false → omitted.
function buildArgv(site, command, positional, args) {
  const out = [site, command];
  for (const v of Array.isArray(positional) ? positional : []) out.push(String(v));
  for (const [k, v] of Object.entries(args && typeof args === 'object' ? args : {})) {
    if (v === true) out.push(`--${k}`);
    else if (v === false || v == null) continue;
    else out.push(`--${k}`, String(v));
  }
  out.push('-f', 'json');
  return out;
}

// Pull the first JSON value out of opencli stdout (it may print a banner first).
function extractJson(stdout) {
  const t = String(stdout).trim();
  if (!t) return undefined;
  try { return JSON.parse(t); } catch { /* fall through */ }
  const i = t.search(/[[{]/);
  if (i < 0) return undefined;
  for (let j = t.length; j > i; j--) { try { return JSON.parse(t.slice(i, j)); } catch { /* shrink */ } }
  return undefined;
}

function runOpencli(site, command, positional, args) {
  return new Promise((resolve) => {
    const env = { ...process.env, OPENCLI_PROFILE: PROFILE };
    const cmd = resolveOpencliCommand();
    const opencliArgv = [...cmd.prefixArgs, ...buildArgv(site, command, positional, args)];
    let timedOut = false;
    let settled = false;
    let timer;
    const child = execFile(cmd.bin, opencliArgv, {
      env,
      maxBuffer: 16 * 1024 * 1024,
      // Isolate each opencli shim in its own process group so a timed-out call
      // cannot leave descendants around and block the /ux/data FIFO forever.
      detached: process.platform !== 'win32',
      killSignal: 'SIGKILL',
    }, (err, stdout, stderr) => {
      settled = true;
      clearTimeout(timer);
      const parsed = extractJson(String(stdout));
      if (err) {
        // opencli often prints a structured error to stdout/stderr and exits non-zero.
        const envelope = parsed && typeof parsed === 'object' && parsed.ok === false ? parsed : null;
        if (envelope) { resolve({ ok: false, error: String(envelope.error?.message || envelope.error || 'opencli error'), code: envelope.error?.code || 'opencli_error' }); return; }
        timedOut = timedOut || err.killed || err.signal === 'SIGTERM' || err.signal === 'SIGKILL';
        resolve({
          ok: false,
          error: (timedOut ? `opencli timed out after ${OPENCLI_DATA_TIMEOUT_MS / 1000}s` : (String(stderr).trim() || String(stdout).trim() || err.message)).slice(0, 600),
          code: timedOut ? 'timeout' : 'exec_failed',
        });
        return;
      }
      if (parsed === undefined) { resolve({ ok: false, error: 'opencli returned no parseable JSON', code: 'empty' }); return; }
      resolve({ ok: true, data: parsed });
    });
    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }, OPENCLI_DATA_TIMEOUT_MS);
  });
}

function resolveOpencliCommand() {
  const envBin = process.env.OPENCLI_BIN && String(process.env.OPENCLI_BIN).trim();
  if (envBin) return { bin: envBin, prefixArgs: [] };
  if (existsSync(OPENCLI_APP_NODE) && existsSync(OPENCLI_APP_MAIN)) {
    return { bin: OPENCLI_APP_NODE, prefixArgs: [OPENCLI_APP_MAIN] };
  }
  return { bin: 'opencli', prefixArgs: [] };
}

function serveDist(res, urlPath) {
  // only when ./ux-app/dist exists (json-render build)
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = normalize(join(DIST, rel));
  if (!file.startsWith(DIST) || !existsSync(file)) return false;
  const ext = file.slice(file.lastIndexOf('.'));
  const headers = { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-store' };
  if (ext === '.html') headers['content-security-policy'] = PAGE_CSP;
  res.writeHead(200, headers);
  res.end(readFileSync(file));
  return true;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  const port = server.address().port;
  const origin = req.headers['origin'] || '';

  // config the page fetches on load (gives it the one-time token)
  if (p === '/ux/config') return send(res, 200, { session, token, mode, spec, allow: [...ALLOW] });

  // capture callback — token + EXACT origin checked
  if (p === `/ux/callback/${session}` && req.method === 'POST') {
    if (req.headers['x-ux-token'] !== token || !okOrigin(origin, port)) return send(res, 403, { error: 'bad token/origin' });
    let buf = '';
    req.on('data', (d) => { buf += d; if (buf.length > 1_000_000) req.destroy(); });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(buf || '{}'); } catch { /* ignore */ }
      send(res, 204, '');
      resolveCallback(payload);
    });
    return;
  }

  // DATA route — the served page calls this to fetch from opencli. Fenced by:
  // one-time token, exact Origin, server-owned allowlist, read-only default,
  // and a FIFO serializer (concurrency 1) so browser-backed calls don't wedge.
  if (p === '/ux/data' && req.method === 'POST') {
    if (req.headers['x-ux-token'] !== token || !okOrigin(origin, port)) return send(res, 403, { ok: false, error: 'bad token/origin', code: 'forbidden' });
    let buf = '';
    req.on('data', (d) => { buf += d; if (buf.length > 1_000_000) req.destroy(); });
    req.on('end', async () => {
      let r;
      try { r = JSON.parse(buf || '{}'); } catch { return send(res, 400, { ok: false, error: 'bad json', code: 'bad_request' }); }
      const site = String(r.site || ''), command = String(r.command || '');
      if (!site || !command) return send(res, 400, { ok: false, error: 'site and command required', code: 'bad_request' });
      if (!ALLOW.has(`${site} ${command}`)) return send(res, 403, { ok: false, error: `"${site} ${command}" not in allowlist`, code: 'not_allowlisted' });
      if (!ALLOW_WRITE && WRITE_VERBS.has(command)) return send(res, 403, { ok: false, error: `"${command}" is a write command (artifact is read-only)`, code: 'read_only' });
      const result = await runSerialized(() => runOpencli(site, command, r.positional, r.args));
      send(res, result.ok ? 200 : 502, result);
    });
    return;
  }

  // serve mode: the agent-authored interactive app at GET / (with CSP)
  if (mode === 'serve' && (p === '/' || p === '/index.html')) return sendHtml(res, 200, appHtml);

  // serve json-render dist if present
  if (existsSync(DIST) && serveDist(res, p)) return;

  // fallback: built-in minimal renderer (zero-dep) so the command runs today
  if (p === '/' || p === '/index.html') return sendHtml(res, 200, FALLBACK_HTML);

  send(res, 404, { error: 'not found' });
});

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const uxUrl = `http://127.0.0.1:${port}/?s=${session}`;
  process.stderr.write(`[ux] listening ${uxUrl}\n`);

  // serve: long-lived app server. Render opens the URL, so default to NOT
  // spawning the system browser (opt in with --open). Emit {served,url,...}
  // immediately and stay alive until killed.
  if (mode === 'serve') {
    if (flags.open === true) openBrowser(uxUrl);
    process.stdout.write(JSON.stringify({ served: true, url: uxUrl, session, token, allow: [...ALLOW] }) + '\n');
    return; // stay alive serving / + /ux/data
  }

  if (!flags['no-open']) openBrowser(uxUrl);

  if (mode === 'render' && !flags.keep) {
    // render: announce and keep serving briefly so the page can load
    process.stdout.write(JSON.stringify({ rendered: true, url: uxUrl, session }) + '\n');
    // keep alive until dismissed or a short grace period unless --keep
    const dismiss = await Promise.race([captured, new Promise((r) => setTimeout(() => r({ __grace: true }), 8000))]);
    if (!dismiss.__grace) process.stdout.write(JSON.stringify(dismiss) + '\n');
    server.close(); process.exit(0);
  }
  if (mode === 'render' && flags.keep) {
    process.stdout.write(JSON.stringify({ rendered: true, url: uxUrl, session, keep: true }) + '\n');
    return; // stay alive
  }

  // form / confirm: block until callback or timeout
  const timer = setTimeout(() => {
    process.stdout.write(JSON.stringify({ submitted: false, error: 'timeout' }) + '\n');
    server.close(); process.exit(0);
  }, timeoutMs);
  const result = await captured;
  clearTimeout(timer);
  process.stdout.write(JSON.stringify(result) + '\n');
  server.close(); process.exit(0);
});

function openBrowser(u) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try { spawn(cmd, [u], { stdio: 'ignore', detached: true }).unref(); } catch { /* --no-open or headless */ }
}

// ---------- built-in minimal renderer (fallback; json-render dist supersedes) ----------
const FALLBACK_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>opencli ux</title><style>
:root{color-scheme:light dark}body{font:15px/1.5 -apple-system,"PingFang SC",system-ui,sans-serif;max-width:680px;margin:24px auto;padding:0 16px;background:Canvas;color:CanvasText}
.tagrow{font:11px ui-monospace,monospace;color:#888;margin-bottom:12px}.tag{border:1px solid #8884;border-radius:6px;padding:1px 7px;margin-right:6px}
.card{border:1px solid #8883;border-radius:12px;padding:14px;margin:10px 0}h1{font-size:18px}h2{font-size:15px;margin:.4em 0}
label{display:block;font-size:13px;color:#888;margin:10px 0 4px}input,select,textarea{width:100%;padding:8px;border:1px solid #8886;border-radius:8px;background:Field;color:FieldText;font:inherit}
button{font:inherit;padding:9px 16px;border-radius:9px;border:1px solid #8886;background:#7c5cff;color:#fff;cursor:pointer;margin-top:14px;margin-right:8px}
button.secondary{background:transparent;color:CanvasText}img{max-width:80px;border-radius:8px;float:left;margin-right:10px}small{color:#888}
.note{font:11px ui-monospace,monospace;color:#b80;margin-top:18px}</style></head>
<body><div class="tagrow"><span class="tag">opencli ux</span><span class="tag" id="m"></span><span class="tag">isolated origin</span></div>
<div id="root">loading…</div>
<div class="note">fallback renderer (built-in). build ux-app/dist for the json-render UI.</div>
<script>
let CFG;
async function boot(){
  CFG = await (await fetch('/ux/config')).json();
  document.getElementById('m').textContent = CFG.mode;
  const s = CFG.spec || {}; const root = document.getElementById('root'); root.innerHTML='';
  if (CFG.mode==='confirm'){ renderConfirm(s,root); }
  else if (CFG.mode==='form'){ renderForm(s,root); }
  else { renderData(s,root); }
}
function esc(x){return String(x==null?'':x).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
function post(body){ return fetch('/ux/callback/'+CFG.session,{method:'POST',headers:{'content-type':'application/json','x-ux-token':CFG.token},body:JSON.stringify(body)}); }
function renderData(s,root){
  if(s.title){const h=document.createElement('h1');h.textContent=s.title;root.appendChild(h);}
  for(const it of (s.items||[])){const c=document.createElement('div');c.className='card';
    c.innerHTML=(it.image?'<img src="'+esc(it.image)+'">':'')+'<h2>'+esc(it.title)+'</h2>'+(it.subtitle?'<small>'+esc(it.subtitle)+'</small><br>':'')+
      Object.entries(it.fields||{}).map(([k,v])=>'<small>'+esc(k)+': '+esc(v)+'</small>').join(' · ')+
      (it.url?'<br><a href="'+esc(it.url)+'" target="_blank">打开</a>':'');
    root.appendChild(c);}
}
function renderForm(s,root){
  if(s.title){const h=document.createElement('h1');h.textContent=s.title;root.appendChild(h);}
  const wrap=document.createElement('div');root.appendChild(wrap);const vals={};
  for(const f of (s.fields||[])){const lab=document.createElement('label');lab.textContent=f.label||f.name;wrap.appendChild(lab);
    let el;
    if(f.type==='textarea'){el=document.createElement('textarea');}
    else if(f.type==='select'||f.type==='multiselect'){el=document.createElement('select');if(f.type==='multiselect')el.multiple=true;
      for(const o of (f.options||[])){const op=document.createElement('option');op.value=o;op.textContent=o;el.appendChild(op);}}
    else{el=document.createElement('input');el.type=f.type==='number'?'number':'text';}
    el.id='f_'+f.name;wrap.appendChild(el);}
  const btn=document.createElement('button');btn.textContent=s.submitLabel||'提交';
  btn.onclick=async()=>{const out={};for(const f of (s.fields||[])){const el=document.getElementById('f_'+f.name);
    out[f.name]= f.type==='multiselect'?[...el.selectedOptions].map(o=>o.value):(f.type==='number'?Number(el.value):el.value);}
    await post({submitted:true,action:'ux_submit',values:out});document.body.innerHTML='<div class="card">已提交 ✓ 可关闭本页。</div>';};
  root.appendChild(btn);
}
function renderConfirm(s,root){const c=document.createElement('div');c.className='card';c.innerHTML='<h2>'+esc(s.message||'确认?')+'</h2>'+(s.danger?'<small style="color:#d64545">敏感操作</small>':'');root.appendChild(c);
  for(const opt of (s.options||['允许','拒绝'])){const b=document.createElement('button');b.textContent=opt;if(opt!==((s.options||['允许'])[0]))b.className='secondary';
    b.onclick=async()=>{await post({action:'ux_confirm',choice:opt});document.body.innerHTML='<div class="card">已选择：'+esc(opt)+' ✓</div>';};root.appendChild(b);}
}
boot().catch(e=>{document.getElementById('root').textContent='error: '+e.message;});
</script></body></html>`;
