// Shared helper: spawn ux.mjs (the interaction-layer server/renderer) and return its captured JSON.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const UX = join(dirname(fileURLToPath(import.meta.url)), 'ux.mjs');

export function runUx(mode, kwargs) {
  return new Promise((res) => {
    const spec = String(kwargs.spec ?? '').trim();
    const args = [UX, mode];
    let stdinData = null;
    if (spec && existsSync(spec)) args.push('--spec', resolve(spec));
    else { args.push('--spec', '-'); stdinData = spec || '{}'; }  // inline JSON via stdin
    if (kwargs.timeout) args.push('--timeout', String(kwargs.timeout));
    if (kwargs['no-open']) args.push('--no-open');

    const ch = spawn('node', args, { stdio: ['pipe', 'pipe', 'inherit'] });
    if (stdinData !== null) { ch.stdin.write(stdinData); }
    ch.stdin.end();
    let out = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.on('close', () => {
      const lines = out.trim().split('\n').filter(Boolean);
      let result = {};
      try { result = JSON.parse(lines[lines.length - 1]); } catch { result = { raw: out.trim() }; }
      res(result);
    });
    ch.on('error', (e) => res({ error: String(e.message) }));
  });
}
