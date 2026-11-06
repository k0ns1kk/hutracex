// Persistencia segura y eficiente (Etapa 1.4: A5/A6): logs por ejecución, migración v1 → v2,
// integridad de tracker.json, respaldos verificables y fallos de escritura. Solo datos sintéticos.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { makeSandbox, makeRepo, startServer, runServerExpectExit, getHu, getLog, waitFor, waitHuStatus } from './helpers.js';

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const dataPath = (sb, ...p) => path.join(sb.app, 'data', ...p);

function sandbox() {
  const sb = makeSandbox();
  sb.repo = makeRepo(sb, 'repo');
  cleanups.push(() => sb.cleanup());
  return sb;
}
async function boot(sb, overrides, options) {
  const srv = await startServer(sb, overrides, options);
  cleanups.push(() => srv.stop());
  return srv;
}
async function env(overrides, options) {
  const sb = sandbox();
  const srv = await boot(sb, overrides, options);
  const projectId = (await srv.api('POST', '/api/projects', { path: sb.repo })).body.id;
  const c = { sb, srv, projectId };
  c.newHu = async (title, extra = {}) => (await srv.api('POST', '/api/hus', { projectId, title, ...extra })).body;
  c.run = (id, phase = 'analysis') => srv.api('POST', `/api/hus/${id}/run`, { phase });
  c.runEnd = id => waitFor(async () => { const r = (await getHu(c.srv, id)).runs.at(-1); return r && r.status !== 'running' && r; });
  return c;
}

// Base v1 (anterior a la Etapa 1.4) con salida embebida en tracker.json.
const t0 = '2026-11-01T00:00:00.000Z';
function legacyDb(repo, runs) {
  const roles = { analysis: 'claude', implementation: 'codex', qa: 'antigravity' };
  return {
    projects: [{ id: 'p1', name: 'repo', path: repo, createdAt: t0 }],
    hus: [{ id: 'h1', projectId: 'p1', title: 'Histórica', description: 'D', criteria: 'C', priority: 'medium', roles, plan: 'PLAN', planRunId: 'r1', status: 'approved', approved: true, createdAt: t0, updatedAt: t0 }],
    events: [
      { id: 'e1', huId: 'h1', type: 'created', message: 'HU registrada', details: {}, at: t0 },
      { id: 'e2', huId: 'h1', type: 'approved', message: 'Plan aprobado por el usuario', details: { planRunId: 'r1' }, at: t0 },
    ],
    runs: runs.map(([id, output, extra = {}]) => ({ id, huId: 'h1', phase: 'analysis', agent: 'claude', status: 'completed', startedAt: t0, endedAt: t0, exitCode: 0, output, ...extra })),
  };
}

// ---------- Logs por ejecución ----------

test('escritura incremental: el log crece durante la ejecución sin reescribir tracker.json por fragmento', async () => {
  const c = await env();
  const hu = await c.newHu('Goteo [drip]');
  const started = (await c.run(hu.id)).body;
  assert.deepEqual(started.log, { file: `runs/${started.id}.log`, bytes: 0, truncated: false });
  const mtimes = new Set();
  const sizes = [];
  const poll = setInterval(() => {
    mtimes.add(fs.statSync(dataPath(c.sb, 'tracker.json')).mtimeMs);
    try { sizes.push(fs.statSync(dataPath(c.sb, 'runs', `${started.id}.log`)).size); } catch {}
  }, 20);
  const mid = await waitFor(async () => { const l = await getLog(c.srv, started.id); return l.bytes > 0 && l.status === 'running' && l; });
  assert.match(mid.agent, /línea 0\n/);
  const r = await c.runEnd(hu.id);
  clearInterval(poll);
  assert.equal(r.status, 'completed');
  assert.ok(new Set(sizes).size >= 5, `el archivo de log creció de forma incremental (${new Set(sizes).size} tamaños)`);
  assert.ok(mtimes.size <= 3, `tracker.json no se reescribe por fragmento (${mtimes.size} versiones durante 20 fragmentos)`);
  const log = await getLog(c.srv, r.id);
  assert.equal(log.agent.split('\n').filter(Boolean).length, 20);
  assert.equal(log.bytes, r.log.bytes);
  assert.equal(log.complete, true);
  // tracker.json solo guarda metadatos de la ejecución (el plan de la HU es dato estructurado, no log).
  const saved = c.sb.readDb();
  assert.ok(saved.runs.every(x => !('output' in x)));
  const { plan, ...huMeta } = saved.hus[0];
  assert.ok(!JSON.stringify({ ...saved, hus: [huMeta] }).includes('línea 0'), 'la salida solo está en el log (y en el plan)');
});

test('múltiples fragmentos de stdout y stderr se conservan en orden de llegada', async () => {
  const c = await env();
  const hu = await c.newHu('Intercalado [chunks]');
  await c.run(hu.id);
  const r = await c.runEnd(hu.id);
  const expected = Array.from({ length: 10 }, (_, i) => `o${i}\ne${i}\n`).join('');
  assert.equal((await getLog(c.srv, r.id)).agent, expected, 'el log conserva stdout y stderr intercalados');
  assert.equal((await getHu(c.srv, hu.id)).plan, Array.from({ length: 10 }, (_, i) => `o${i}`).join('\n'), 'el plan es solo el resultado final (sin stderr)');
});

test('caracteres multibyte cortados entre fragmentos se registran íntegros', async () => {
  const c = await env();
  const hu = await c.newHu('UTF-8 [utf8split]');
  await c.run(hu.id);
  const r = await c.runEnd(hu.id);
  assert.equal((await getLog(c.srv, r.id)).agent, 'Información: ñandú, café, €, 😀 fin\n');
  assert.equal((await getHu(c.srv, hu.id)).plan, 'Información: ñandú, café, €, 😀 fin', 'el plan tampoco se corrompe (M1)');
});

test('ejecuciones concurrentes escriben cada una en su propio log, sin mezclarse', async () => {
  const c = await env();
  const hus = [];
  for (let i = 0; i < 5; i++) { const h = await c.newHu(`Concurrente ${i} [drip]`); hus.push(h); await c.run(h.id); }
  const runs = [];
  for (const h of hus) runs.push(await c.runEnd(h.id));
  const leaders = new Set();
  for (const r of runs) {
    const lines = (await getLog(c.srv, r.id)).agent.split('\n').filter(Boolean);
    assert.equal(lines.length, 20);
    const pids = new Set(lines.map(l => l.split(' ')[0]));
    assert.equal(pids.size, 1, 'un solo proceso por log');
    assert.deepEqual(lines.map(l => l.split(' ').at(-1)), Array.from({ length: 20 }, (_, i) => String(i)));
    leaders.add([...pids][0]);
  }
  assert.equal(leaders.size, 5);
});

test('límite de tamaño (tail por defecto ajustado al límite): el log se trunca con aviso, se registra una vez y la ejecución no falla', async () => {
  const c = await env({ HUTRACEX_MAX_LOG_BYTES: '10000' });
  const hu = await c.newHu('Grande [big:50000]');
  await c.run(hu.id);
  const r = await c.runEnd(hu.id);
  assert.equal(r.status, 'completed');
  assert.equal(r.log.bytes, 10000);
  assert.equal(r.log.truncated, true);
  const log = await getLog(c.srv, r.id);
  assert.equal(log.truncated, true);
  assert.match(log.text, /\[HuTraceX\] Log truncado: se alcanzó el límite de 10000 bytes\.\n$/);
  assert.ok(fs.statSync(dataPath(c.sb, 'runs', `${r.id}.log`)).size < 10200);
  const h = await getHu(c.srv, hu.id);
  assert.equal(h.events.filter(e => e.type === 'log_truncated').length, 1);
});

test('tail: devuelve los últimos bytes sin cortar caracteres UTF-8 y valida el parámetro', async () => {
  const c = await env();
  const hu = await c.newHu('Tail [utf8split]');
  await c.run(hu.id);
  const r = await c.runEnd(hu.id);
  const full = (await getLog(c.srv, r.id)).text;
  const buf = Buffer.from(full);
  const t = await getLog(c.srv, r.id, buf.length - buf.lastIndexOf(Buffer.from('😀')) - 2); // cae a mitad del emoji
  assert.equal(t.complete, false);
  assert.ok(full.endsWith(t.text));
  assert.ok(!t.text.includes('�'), 'sin caracteres de reemplazo');
  for (const bad of ['0', '-1', 'abc', '1.5', String(10 * 1024 * 1024 + 1024 + 1)]) {
    const res = await c.srv.api('GET', `/api/runs/${r.id}/log?tail=${bad}`);
    assert.equal(res.status, 400, bad);
  }
});

// ---------- Respuestas generales sin logs ----------

test('los logs no viajan en /api/state ni en las respuestas de la HU o de la ejecución', async () => {
  const c = await env();
  const hu = await c.newHu('Sin logs en estado [chunks]');
  const start = await c.run(hu.id);
  assert.ok(!('output' in start.body));
  const r = await c.runEnd(hu.id);
  const state = await c.srv.api('GET', '/api/state');
  assert.ok(state.body.hus.every(h => h.runs.every(x => !('output' in x))));
  const withoutPlan = { ...state.body, hus: state.body.hus.map(({ plan, ...h }) => h) };
  const marker = JSON.stringify('o0\no1').slice(1, -1);
  assert.ok(state.text.includes(marker), 'control: el plan sí la contiene');
  assert.ok(!JSON.stringify(withoutPlan).includes(marker), 'la salida solo aparece en el plan de la HU');
  assert.ok(!state.text.includes('\\ne9'), 'stderr no aparece en el estado');
  assert.deepEqual(state.body.storage, { ok: true });
  const patched = await c.srv.api('PATCH', `/api/hus/${hu.id}`, { priority: 'high' });
  assert.ok(patched.body.runs.every(x => !('output' in x)));
  assert.ok((await getLog(c.srv, r.id)).agent.startsWith('o0\ne0\no1'));
});

// ---------- Seguridad del endpoint de logs ----------

test('endpoint de logs: ids inválidos, path traversal, symlinks y restricciones HTTP', async () => {
  const c = await env();
  const hu = await c.newHu('Seguridad log');
  await c.run(hu.id);
  const r = await c.runEnd(hu.id);
  for (const p of ['/api/runs/..%2F..%2Ftracker/log', '/api/runs/%2e%2e/log', '/api/runs/x.log/log', '/api/runs/no-existe/log', `/api/runs/${r.id}%00/log`, `/api/runs/${'a'.repeat(65)}/log`]) {
    const res = await c.srv.api('GET', p);
    assert.equal(res.status, 404, p);
    assert.ok(!res.text.includes('"projects"'), p);
  }
  // URL normalizada (../): no llega a la ruta de logs.
  assert.equal((await c.srv.raw({ path: '/api/runs/../tracker.json' })).status, 404);
  // Un log reemplazado por un symlink no se sigue (O_NOFOLLOW).
  const logFile = dataPath(c.sb, 'runs', `${r.id}.log`);
  fs.rmSync(logFile);
  fs.symlinkSync('/etc/passwd', logFile);
  const res = await c.srv.api('GET', `/api/runs/${r.id}/log`);
  assert.equal(res.status, 500);
  assert.ok(!res.text.includes('root:'));
  // Las restricciones HTTP (Etapa 1.1) siguen aplicando.
  const host = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: c.srv.port, path: `/api/runs/${r.id}/log`, headers: { host: 'evil.example' } }, x => { x.resume(); resolve(x.statusCode); }).on('error', reject);
  });
  assert.equal(host, 403);
  assert.equal((await c.srv.raw({ path: `/api/runs/${r.id}/log`, headers: { origin: 'https://evil.example' } })).status, 403);
});

// ---------- Migración de datos históricos ----------

test('migración v1 → v2: logs a archivos, respaldo verificable y conservación de ids, estados, eventos y aprobaciones', async () => {
  const sb = sandbox();
  const big = 'línea larga ñ€😀\n'.repeat(20000);
  const legacy = legacyDb(sb.repo, [['r1', 'PLAN'], ['r2', 'salida con ñandú y 😀\n'], ['r3', ''], ['r4', big, { status: 'failed', exitCode: 3 }]]);
  sb.writeDb(legacy);
  const original = fs.readFileSync(dataPath(sb, 'tracker.json'));
  const srv = await boot(sb);
  assert.match(srv.output().stdout, /Migrando tracker.json a schemaVersion 2 \(4 log\(s\)/);

  const db = sb.readDb();
  assert.equal(db.schemaVersion, 2);
  assert.ok(db.runs.every(r => !('output' in r)));
  for (const [id, output] of [['r1', 'PLAN'], ['r2', 'salida con ñandú y 😀\n'], ['r3', ''], ['r4', big]]) {
    const run = db.runs.find(r => r.id === id);
    const file = fs.readFileSync(dataPath(sb, 'runs', `${id}.log`));
    assert.equal(file.toString('utf8'), output, id);
    assert.equal(run.log.sha256, sha(file));
    assert.equal(run.log.bytes, file.length);
    assert.equal((await getLog(srv, id, 10 * 1024 * 1024)).text, output, id);
  }
  // Ids, estados, eventos y aprobación intactos.
  const strip = r => { const { output, log, ...m } = r; return m; };
  assert.deepEqual(db.runs.map(strip), legacy.runs.map(strip));
  assert.deepEqual(db.projects, legacy.projects);
  for (const e of legacy.events) assert.deepEqual(db.events.find(x => x.id === e.id), e);
  const h = await getHu(srv, 'h1');
  assert.equal(h.status, 'approved');
  assert.equal(h.approved, true);
  assert.equal(h.allowedActions.qa, true, 'la aprobación sigue vigente tras migrar');
  // Respaldo previo: copia exacta del original con sha256 verificable.
  const pre = fs.readdirSync(dataPath(sb, 'backups')).find(f => f.endsWith('-pre-migration-v2.json'));
  const backup = fs.readFileSync(dataPath(sb, 'backups', pre));
  assert.ok(backup.equals(original));
  assert.equal(fs.readFileSync(dataPath(sb, 'backups', pre + '.sha256'), 'utf8').trim(), sha(backup));
  // /api/state ya no transporta los ~400 KB de salida histórica.
  const state = await srv.api('GET', '/api/state');
  assert.ok(state.text.length < 10000, `estado: ${state.text.length} bytes`);
});

test('migración interrumpida y reanudada: idempotente, sin duplicar logs y sin tocar tracker.json hasta confirmar', async () => {
  const sb = sandbox();
  sb.writeDb(legacyDb(sb.repo, [['r1', 'uno\n'], ['r2', 'dos\n'], ['r3', 'tres\n']]));
  const original = fs.readFileSync(dataPath(sb, 'tracker.json'));
  // Estado de un intento previo: r1 ya migrado, r2 con un log parcial; r3 no se puede escribir (EISDIR).
  fs.mkdirSync(dataPath(sb, 'runs', 'r3.log.tmp'), { recursive: true });
  fs.writeFileSync(dataPath(sb, 'runs', 'r1.log'), 'uno\n');
  fs.writeFileSync(dataPath(sb, 'runs', 'r2.log'), 'do');
  const r1mtime = fs.statSync(dataPath(sb, 'runs', 'r1.log')).mtimeMs;

  const failed = await runServerExpectExit(sb);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /No se pudo preparar data\/: .*tracker\.json no se modificó/);
  assert.ok(fs.readFileSync(dataPath(sb, 'tracker.json')).equals(original), 'tracker.json intacto (v1, con salidas)');

  fs.rmSync(dataPath(sb, 'runs', 'r3.log.tmp'), { recursive: true });
  const srv = await boot(sb);
  const db = sb.readDb();
  assert.equal(db.schemaVersion, 2);
  assert.equal(fs.readFileSync(dataPath(sb, 'runs', 'r1.log'), 'utf8'), 'uno\n', 'no duplicado');
  assert.equal(fs.statSync(dataPath(sb, 'runs', 'r1.log')).mtimeMs, r1mtime, 'log ya migrado: no se reescribe');
  assert.equal(fs.readFileSync(dataPath(sb, 'runs', 'r2.log'), 'utf8'), 'dos\n', 'log parcial reemplazado');
  assert.equal(fs.readFileSync(dataPath(sb, 'runs', 'r3.log'), 'utf8'), 'tres\n');
  assert.deepEqual(fs.readdirSync(dataPath(sb, 'runs')).filter(f => f.endsWith('.tmp')), []);
  // Un tercer arranque no vuelve a migrar ni a tocar los logs.
  await srv.stop();
  const before = fs.readdirSync(dataPath(sb, 'runs')).map(f => [f, fs.statSync(dataPath(sb, 'runs', f)).mtimeMs]);
  const again = await boot(sb);
  assert.doesNotMatch(again.output().stdout, /Migrando/);
  assert.deepEqual(fs.readdirSync(dataPath(sb, 'runs')).map(f => [f, fs.statSync(dataPath(sb, 'runs', f)).mtimeMs]), before);
});

// ---------- Integridad de tracker.json ----------

test('base inexistente: instalación nueva crea tracker.json v2 y un respaldo de arranque', async () => {
  const sb = sandbox();
  const srv = await boot(sb);
  assert.match(srv.output().stdout, /Instalación nueva/);
  assert.deepEqual(sb.readDb(), { schemaVersion: 2, projects: [], hus: [], events: [], runs: [] });
  assert.ok(fs.readdirSync(dataPath(sb, 'backups')).some(f => f.endsWith('-startup.json')));
});

test('base inexistente con datos previos: no se crea una base vacía', async () => {
  const sb = sandbox();
  const srv = await boot(sb);
  await srv.api('POST', '/api/projects', { path: sb.repo });
  await srv.stop();
  fs.rmSync(dataPath(sb, 'tracker.json'));
  const r = await runServerExpectExit(sb);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /tracker\.json no existe, pero data\/ contiene datos previos \(respaldos/);
  assert.match(r.stderr, /HUTRACEX_RESTORE_BACKUP=latest/);
  assert.ok(!fs.existsSync(dataPath(sb, 'tracker.json')));
});

test('JSON corrupto, truncado o vacío: el servidor no arranca y el archivo no se modifica', async () => {
  const sb = sandbox();
  const srv = await boot(sb);
  await srv.api('POST', '/api/projects', { path: sb.repo });
  await srv.stop();
  const good = fs.readFileSync(dataPath(sb, 'tracker.json'), 'utf8');
  for (const [content, msg] of [[good.slice(0, good.length / 2), /JSON inválido o truncado/], ['{"projects": [', /JSON inválido o truncado/], ['', /el archivo está vacío/], ['   \n', /el archivo está vacío/], ['\u0000\u0000\u0000', /JSON inválido/]]) {
    fs.writeFileSync(dataPath(sb, 'tracker.json'), content);
    const r = await runServerExpectExit(sb);
    assert.equal(r.code, 1, JSON.stringify(content.slice(0, 20)));
    assert.match(r.stderr, /data\/tracker\.json está dañado/);
    assert.match(r.stderr, msg);
    assert.match(r.stderr, /No se reemplazará por una base vacía/);
    assert.match(r.stderr, /Respaldo verificado más reciente: data\/backups\/tracker-.*\.json/);
    assert.equal(fs.readFileSync(dataPath(sb, 'tracker.json'), 'utf8'), content, 'sin modificar');
  }
});

test('esquema incompleto o inválido: rechazado con un motivo específico', async () => {
  const sb = sandbox();
  const base = { schemaVersion: 2, projects: [], hus: [], events: [], runs: [] };
  const cases = [
    [[], /la raíz no es un objeto/],
    [{ ...base, runs: undefined }, /falta la colección "runs"/],
    [{ ...base, hus: {} }, /falta la colección "hus"/],
    [{ ...base, hus: [{ id: 'h', projectId: 'p' }] }, /hus\[0\]\.status falta o no es texto/],
    [{ ...base, runs: [{ id: '../x', huId: 'h', status: 'completed' }] }, /runs contiene un id no válido/],
    [{ ...base, events: [null] }, /events\[0\] no es un objeto/],
    [{ ...base, schemaVersion: 99 }, /schemaVersion 99 es más nuevo que el soportado/],
    [{ ...base, schemaVersion: 'dos' }, /schemaVersion inválido/],
  ];
  for (const [d, msg] of cases) {
    sb.writeDb(d);
    const raw = fs.readFileSync(dataPath(sb, 'tracker.json'));
    const r = await runServerExpectExit(sb);
    assert.equal(r.code, 1, String(msg));
    assert.match(r.stderr, msg);
    assert.ok(fs.readFileSync(dataPath(sb, 'tracker.json')).equals(raw));
  }
});

test('recuperación desde respaldo válido: explícita, verifica sha256 y conserva el archivo dañado', async () => {
  const sb = sandbox();
  let srv = await boot(sb);
  const projectId = (await srv.api('POST', '/api/projects', { path: sb.repo })).body.id;
  await srv.api('POST', '/api/hus', { projectId, title: 'Antes de dañarse' });
  await srv.stop();
  for (let i = 0; i < 2; i++) { srv = await boot(sb); await srv.stop(); } // dos respaldos de arranque con la HU
  fs.writeFileSync(dataPath(sb, 'tracker.json'), '{"dañado":');
  // Se altera el respaldo más reciente: debe descartarse por sha256 y usarse el anterior válido.
  const backups = fs.readdirSync(dataPath(sb, 'backups')).filter(f => f.endsWith('.json')).sort();
  const latest = backups.at(-1);
  fs.appendFileSync(dataPath(sb, 'backups', latest), ' ');
  const rejected = await runServerExpectExit(sb, { HUTRACEX_RESTORE_BACKUP: latest });
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /está dañado o su sha256 no coincide/);
  assert.equal((await runServerExpectExit(sb, { HUTRACEX_RESTORE_BACKUP: '../../etc/passwd' })).code, 1);

  srv = await boot(sb, { HUTRACEX_RESTORE_BACKUP: 'latest' });
  assert.match(srv.output().stdout, /tracker\.json restaurado desde data\/backups\/tracker-/);
  const { hus } = (await srv.api('GET', '/api/state')).body;
  assert.deepEqual(hus.map(h => h.title), ['Antes de dañarse']);
  const damaged = fs.readdirSync(dataPath(sb)).find(f => f.startsWith('tracker.json.damaged-'));
  assert.equal(fs.readFileSync(dataPath(sb, damaged), 'utf8'), '{"dañado":');
  await srv.stop();
  // Con la variable aún definida y una base válida, no se restaura de nuevo.
  srv = await boot(sb, { HUTRACEX_RESTORE_BACKUP: 'latest' });
  assert.match(srv.output().stdout, /HUTRACEX_RESTORE_BACKUP ignorado: tracker\.json es válido/);
  assert.equal(fs.readdirSync(dataPath(sb)).filter(f => f.startsWith('tracker.json.damaged-')).length, 1);
});

test('respaldos de arranque: rotación de los 10 más recientes; los de migración se conservan', async () => {
  const sb = sandbox();
  sb.writeDb(legacyDb(sb.repo, [['r1', 'x']]));
  for (let i = 0; i < 12; i++) { const s = await startServer(sb); await s.stop(); }
  const files = fs.readdirSync(dataPath(sb, 'backups'));
  assert.equal(files.filter(f => f.endsWith('-startup.json')).length, 10);
  assert.equal(files.filter(f => f.endsWith('-startup.json.sha256')).length, 10);
  assert.equal(files.filter(f => f.endsWith('-pre-migration-v2.json')).length, 1);
});

// ---------- Fallos de escritura ----------

test('fallo al crear el log: la ejecución no se registra, la HU no cambia y no se lanza Headless', async () => {
  const c = await env();
  const hu = await c.newHu('Sin permiso para logs');
  fs.chmodSync(dataPath(c.sb, 'runs'), 0o500);
  try {
    const r = await c.run(hu.id);
    assert.equal(r.status, 500);
    assert.match(r.body.error, /No se pudo crear el (archivo de prompt|log de la ejecución)/);
  } finally { fs.chmodSync(dataPath(c.sb, 'runs'), 0o700); }
  const h = await getHu(c.srv, hu.id);
  assert.equal(h.status, 'draft');
  assert.equal(h.runs.length, 0);
  assert.equal(c.sb.calls().length, 0);
});

test('fallo al escribir el log (disco lleno simulado): la ejecución falla con causa registrada, no se marca exitosa', async () => {
  const c = await env({}, { fsize: 160 }); // 80 KB por archivo
  const hu = await c.newHu('Disco lleno [big:400000]');
  await c.run(hu.id);
  const r = await c.runEnd(hu.id);
  assert.equal(r.status, 'failed');
  assert.equal(r.endReason, 'log_write_error');
  assert.match(r.log.error, /EFBIG|file too large/i);
  const h = await getHu(c.srv, hu.id);
  assert.equal(h.status, 'blocked');
  assert.equal(h.plan, '');
  assert.equal(h.events.filter(e => e.type === 'log_write_failed').length, 1);
  assert.equal(h.events.at(-1).details.reason, 'log_write_error');
  assert.equal((await getLog(c.srv, r.id)).error, r.log.error);
});

test('fallo al guardar tracker.json: HTTP 500, estado de almacenamiento visible y el archivo previo intacto', async () => {
  const c = await env({}, { fsize: 160 });
  const desc = 'd'.repeat(20000);
  let failure;
  for (let i = 0; i < 10 && !failure; i++) {
    const r = await c.srv.api('POST', '/api/hus', { projectId: c.projectId, title: `HU ${i}`, description: desc });
    if (r.status !== 201) failure = r;
  }
  assert.ok(failure, 'alguna escritura supera el límite');
  assert.equal(failure.status, 500);
  assert.match(failure.body.error, /No se pudieron guardar los datos/);
  const state = (await c.srv.api('GET', '/api/state')).body;
  assert.equal(state.storage.ok, false);
  const onDisk = JSON.parse(fs.readFileSync(dataPath(c.sb, 'tracker.json'), 'utf8')); // sigue siendo JSON válido
  assert.ok(!fs.existsSync(dataPath(c.sb, 'tracker.json.tmp')), 'sin temporales huérfanos');
  await c.srv.stop();
  // Tras reiniciar sin límite, se carga la última versión confirmada.
  c.srv = await boot(c.sb);
  assert.equal((await c.srv.api('GET', '/api/state')).body.hus.length, onDisk.hus.length);
});

// ---------- Reinicio ----------

test('reinicio: los logs se conservan; una ejecución interrumpida registra el tamaño real de su log', async () => {
  const c = await env();
  const done = await c.newHu('Terminada [chunks]');
  await c.run(done.id);
  const r1 = await c.runEnd(done.id);
  const text1 = (await getLog(c.srv, r1.id)).text;
  const live = await c.newHu('Interrumpida [drip]');
  const started = (await c.run(live.id)).body;
  await waitFor(async () => (await getLog(c.srv, started.id)).bytes > 100);
  await c.srv.stop('SIGKILL');
  c.srv = await boot(c.sb);
  assert.equal((await getLog(c.srv, r1.id)).text, text1);
  const r2 = (await getHu(c.srv, live.id)).runs.at(-1);
  assert.equal(r2.status, 'interrupted');
  const size = fs.statSync(dataPath(c.sb, 'runs', `${r2.id}.log`)).size;
  assert.equal(r2.log.bytes, size);
  assert.equal((await getLog(c.srv, r2.id)).bytes, size);
  const h = await getHu(c.srv, done.id);
  assert.equal(h.status, 'awaiting_approval');
  assert.deepEqual(h.events.map(e => e.type), ['created', 'run_started', 'run_completed']);
});

// ---------- Rendimiento (datos sintéticos) ----------

test('rendimiento: con 300 ejecuciones históricas de 50 KB, /api/state y los fragmentos no escalan con el historial', async () => {
  const sb = sandbox();
  const chunk = 'x'.repeat(50 * 1024);
  const runs = Array.from({ length: 300 }, (_, i) => [`r${i}`, chunk]);
  const legacy = legacyDb(sb.repo, runs);
  sb.writeDb(legacy);
  const legacyBytes = fs.statSync(dataPath(sb, 'tracker.json')).size;
  const srv = await boot(sb);
  const trackerBytes = fs.statSync(dataPath(sb, 'tracker.json')).size;
  const state = await srv.api('GET', '/api/state');
  assert.ok(legacyBytes > 15e6);
  assert.ok(trackerBytes < legacyBytes / 50, `tracker.json: ${legacyBytes} → ${trackerBytes} bytes`);
  assert.ok(state.text.length < legacyBytes / 50, `/api/state: ${state.text.length} bytes`);
  // Una ejecución nueva con 20 fragmentos no reescribe el tracker histórico por cada uno.
  const projectId = (await srv.api('POST', '/api/projects', { path: sb.repo })).body.id;
  const hu = (await srv.api('POST', '/api/hus', { projectId, title: 'Nueva [drip]' })).body;
  const mtimes = new Set();
  const poll = setInterval(() => mtimes.add(fs.statSync(dataPath(sb, 'tracker.json')).mtimeMs), 20);
  await srv.api('POST', `/api/hus/${hu.id}/run`, { phase: 'analysis' });
  await waitHuStatus(srv, hu.id, 'awaiting_approval');
  clearInterval(poll);
  assert.ok(mtimes.size <= 3, `${mtimes.size} reescrituras de tracker.json`);
});
