#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Run gl/wasm/test/index.html in headless Chromium against the wasm
// virglrenderer build and exit 0 when the module loaded, the renderer started
// on WebGL2, answered the capability queries, parked and answered a waiting
// busy wait, and served two clients of the inline dialect (index.html says
// what each stage does); 1 otherwise; 2 when it could not run (no build, no
// browser, timeout). Prints the page's JSON result.
//
//   node gl/wasm/test/check.mjs [--out DIR] [--browser BIN] [--timeout S] [--keep-log] [--glcheck]
//
//   --out DIR      the build to test (virgl.mjs, virgl.wasm); default
//                  $KW_BUILD/gl-wasm or vendor/build/gl-wasm
//   --browser BIN  default $CHROMIUM or chromium-headless on PATH
//   --glcheck      log every GL call that raises an error (index.html?glcheck=1)
//   --keep-log     print the browser's stderr when there is no result
//
// A small HTTP server on 127.0.0.1 serves the page (/test/) and the build
// (/out/): module scripts and wasm do not load from file:// URLs. The page
// POSTs its result to /result.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const outDir = resolve(opt('--out', join(process.env.KW_BUILD ? resolve(process.env.KW_BUILD) : join(root, 'vendor/build'), 'gl-wasm')));
const browser = opt('--browser', process.env.CHROMIUM || 'chromium-headless');
const timeout = Number(opt('--timeout', '120')) * 1000;

if (!existsSync(join(outDir, 'virgl.mjs'))) {
  console.error(`no build in ${outDir} (run gl/wasm/build.sh)`);
  process.exit(2);
}

const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm' };
let resolveResult, lastStage = '(none)';
const result = new Promise((r) => { resolveResult = r; });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/stage') {
    lastStage = '';
    for await (const chunk of req) lastStage += chunk;
    res.end('ok');
    return;
  }
  if (req.method === 'POST' && url.pathname === '/result') {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.end('ok');
    resolveResult(body);
    return;
  }
  const map = [['/test/', here], ['/out/', outDir]];
  for (const [prefix, dir] of map) {
    if (!url.pathname.startsWith(prefix)) continue;
    const rel = normalize(decodeURIComponent(url.pathname.slice(prefix.length)) || 'index.html');
    if (rel.startsWith('..')) break;
    try {
      const data = await readFile(join(dir, rel));
      const ext = rel.slice(rel.lastIndexOf('.'));
      res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    } catch {
      break;
    }
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/test/index.html?report=1${args.includes('--glcheck') ? '&glcheck=1' : ''}`;

// The flags of a WebGL2 that works headless here (ANGLE on SwiftShader).
const chrome = spawn(browser, [
  '--no-sandbox', '--headless', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-first-run', '--disable-gpu-sandbox', `--user-data-dir=${join(outDir, 'chromium-profile')}`,
  url,
], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d; });
const exited = new Promise((r) => chrome.on('exit', (code) => r(code)));
chrome.on('error', (e) => { console.error(`cannot run ${browser}: ${e.message}`); process.exit(2); });

const timer = new Promise((r) => setTimeout(() => r(null), timeout));
const body = await Promise.race([result, timer, exited.then(() => null)]);
chrome.kill('SIGKILL');
server.close();

if (body === null) {
  console.error(`no result from the page within ${timeout / 1000} s (or the browser exited); last stage: ${lastStage}`);
  if (args.includes('--keep-log')) console.error(chromeErr);
  process.exit(2);
}
const res = JSON.parse(body);
console.log(JSON.stringify(res, (k, v) => (k === 'extensions' ? v.join(' ') : v), 2));
console.log(res.ok ? `PASS: loaded, initialised on WebGL2, answered GET_CAPS2 and GET_CAPSET, parked and answered a busy wait, served two inline clients, drove virgl.Renderer${res.stages.transfer ? '' : ' (the plain TRANSFER_PUT/GET probe failed)'}`
  : `FAIL: ${res.error || 'see stages'}`);
process.exit(res.ok ? 0 : 1);
