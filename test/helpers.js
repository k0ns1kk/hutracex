// Utilidades de prueba: cada sandbox copia server.js y public/ a un directorio temporal,
// de modo que el servidor escribe en <sandbox>/app/data y nunca en data/ del repositorio.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fakeHeadless = path.join(repoRoot, 'test', 'fixtures', 'fake-headless.js');

export function makeSandbox() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hutracex-test-')));
  const app = path.join(dir, 'app');
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  for (const d of [path.join(app, 'public'), home, bin]) fs.mkdirSync(d, { recursive: true });
  for (const f of ['server.js', 'package.json']) fs.copyFileSync(path.join(repoRoot, f), path.join(app, f));
  for (const f of ['index.html', 'app.js', 'style.css']) {
    fs.copyFileSync(path.join(repoRoot, 'public', f), path.join(app, 'public', f));
  }
  const headless = path.join(bin, 'headless');
  fs.writeFileSync(headless, `#!/bin/sh\nexec "${process.execPath}" "${fakeHeadless}" "$@"\n`, { mode: 0o755 });
  const log = path.join(dir, 'headless-calls.jsonl');
  return {
    dir, app, home, bin, log,
    dbFile: path.join(app, 'data', 'tracker.json'),
    readDb() { return JSON.parse(fs.readFileSync(path.join(app, 'data', 'tracker.json'), 'utf8')); },
    writeDb(db) { fs.mkdirSync(path.join(app, 'data'), { recursive: true }); fs.writeFileSync(path.join(app, 'data', 'tracker.json'), JSON.stringify(db, null, 2)); },
    setSlow(on) { if (on) fs.writeFileSync(log + '.slow', ''); else fs.rmSync(log + '.slow', { force: true }); },
    setFail(on) { if (on) fs.writeFileSync(log + '.fail', ''); else fs.rmSync(log + '.fail', { force: true }); },
    // Entradas del registro del simulador: invocaciones (con argv) y descendientes que lanzó.
    entries: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []),
    calls() { return this.entries().filter(e => e.argv); },
    procs() { return this.entries(); },
    cleanup() {
      // Termina procesos simulados que hayan quedado huérfanos (p. ej. tras matar el servidor).
      for (const c of this.entries()) { try { process.kill(c.pid, 'SIGKILL'); } catch {} }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function makeRepo(sb, name, { git = true } = {}) {
  const p = path.join(sb.home, name);
  fs.mkdirSync(p, { recursive: true });
  if (git) execFileSync('git', ['init', '-q', p]);
  return fs.realpathSync(p);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

function serverEnv(sb, port, overrides) {
  // Seguridad: PATH = simulado + /usr/bin + /bin. El Headless real (instalado vía nvm) no es alcanzable
  // aunque faltara el simulado; el simulado se invoca con la ruta absoluta de node.
  fs.accessSync(path.join(sb.bin, 'headless'), fs.constants.X_OK);
  const env = { ...process.env, HOME: sb.home, PORT: String(port), HOST: '127.0.0.1', FAKE_HEADLESS_LOG: sb.log, PATH: [sb.bin, '/usr/bin', '/bin'].join(path.delimiter), HUTRACEX_KILL_GRACE_MS: '400' };
  delete env.HUTRACEX_RUN_ID;
  delete env.HUTRACEX_RUN_TIMEOUT_MS;
  delete env.REPO_BROWSE_ROOTS;
  return { ...env, ...overrides };
}

// Arranca el servidor esperando que termine (configuración rechazada). Devuelve {code, stdout, stderr}.
// fsize: límite RLIMIT_FSIZE en bloques de 512 B (ulimit -f). Node ignora SIGXFSZ, así que las escrituras
// que lo superan fallan con EFBIG: un fallo real de disco "lleno" sin ganchos en el código de producción.
function spawnServer(sb, env, { fsize } = {}) {
  const opts = { cwd: sb.app, env, stdio: ['ignore', 'pipe', 'pipe'] };
  return fsize
    ? spawn('/bin/sh', ['-c', `ulimit -f ${Number(fsize)} && exec "${process.execPath}" server.js`], opts)
    : spawn(process.execPath, ['server.js'], opts);
}

export async function runServerExpectExit(sb, overrides = {}, options = {}) {
  const proc = spawnServer(sb, serverEnv(sb, await freePort(), overrides), options);
  let stdout = '', stderr = '';
  proc.stdout.on('data', c => { stdout += c; });
  proc.stderr.on('data', c => { stderr += c; });
  const t = setTimeout(() => proc.kill('SIGKILL'), 10000);
  const code = await new Promise(r => proc.on('exit', r));
  clearTimeout(t);
  return { code, stdout, stderr };
}

export async function startServer(sb, overrides = {}, options = {}) {
  const port = await freePort();
  const env = serverEnv(sb, port, overrides);
  const proc = spawnServer(sb, env, options);
  let stderr = '', stdout = '';
  proc.stderr.on('data', c => { stderr += c; });
  proc.stdout.on('data', c => { stdout += c; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('El servidor no arrancó: ' + stderr)), 10000);
    proc.stdout.on('data', c => { if (String(c).includes('HU Tracker:')) { clearTimeout(t); resolve(); } });
    proc.on('exit', code => { clearTimeout(t); reject(new Error(`El servidor terminó (${code}): ${stderr}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  return {
    base, port, proc,
    output: () => ({ stdout, stderr }),
    async api(method, url, data, headers = {}) {
      const r = await fetch(base + url, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: data === undefined ? undefined : typeof data === 'string' ? data : JSON.stringify(data),
      });
      const text = await r.text();
      let body = null;
      try { body = JSON.parse(text); } catch {}
      return { status: r.status, headers: r.headers, body, text };
    },
    // Petición HTTP sin las restricciones de fetch (permite fijar Host, Origin, etc.).
    raw({ method = 'GET', path: p = '/', headers = {}, body, connectHost = '127.0.0.1' } = {}) {
      return new Promise((resolve, reject) => {
        const req = http.request({ host: connectHost, port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', c => { text += c; });
          res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, body: json, text }); });
        });
        req.on('error', reject);
        req.end(body);
      });
    },
    async stop(signal = 'SIGTERM') {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      const exited = new Promise(r => proc.once('exit', r));
      proc.kill(signal);
      await exited;
    },
  };
}

export async function waitFor(fn, { timeout = 10000, interval = 50 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error('waitFor: tiempo de espera agotado');
}

export async function getHu(srv, id) {
  const { body } = await srv.api('GET', '/api/state');
  return body.hus.find(h => h.id === id);
}

export async function waitHuStatus(srv, id, status) {
  return waitFor(async () => { const h = await getHu(srv, id); return h?.status === status && h; });
}

// Vivo = existe en /proc y no es zombie.
export function isAlive(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z';
  } catch { return false; }
}

// Salida de una ejecución vía GET /api/runs/:id/log (ya no viaja en /api/state).
export async function getLog(srv, runId, tail) {
  const r = await srv.api('GET', `/api/runs/${encodeURIComponent(runId)}/log${tail ? `?tail=${tail}` : ''}`);
  if (r.status !== 200) throw new Error(`log ${runId}: ${r.status} ${r.text}`);
  return { ...r.body, agent: agentOutput(r.body.text) };
}

// Reconstruye lo que escribió el agente a partir del log (sobres NDJSON de Headless + stderr tal cual):
// trazas → su texto; líneas que no son sobres (stderr) → tal cual; sobres result/error → se omiten.
export function agentOutput(text) {
  return text.split('\n').filter(Boolean).map(line => {
    try { const e = JSON.parse(line); if (e?.protocolVersion === 1) return e.type === 'trace' ? (e.data.raw ?? JSON.stringify(e.data.value)) + '\n' : ''; } catch {}
    return line + '\n';
  }).join('');
}
