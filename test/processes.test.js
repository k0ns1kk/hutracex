// Gestión segura de ejecuciones (Etapa 1.3: A3/A4): grupos de procesos, cancelación, timeout,
// recuperación al reiniciar, cierre ordenado e instancia única. Solo procesos simulados.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox, makeRepo, startServer, runServerExpectExit, getHu, waitFor, waitHuStatus, isAlive, getLog } from './helpers.js';

const GRACE = 400; // HUTRACEX_KILL_GRACE_MS que fija helpers.js
const TERMINAL = ['run_completed', 'run_failed', 'run_cancelled', 'run_interrupted'];
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

// Sandbox + servidor + proyecto propios; se limpian al final del archivo.
async function env(overrides = {}) {
  const sb = makeSandbox();
  const ctx = { sb };
  cleanups.push(async () => { await ctx.srv?.stop(); sb.cleanup(); }); // también si el arranque falla
  ctx.srv = await startServer(sb, overrides);
  ctx.projectId = (await ctx.srv.api('POST', '/api/projects', { path: makeRepo(sb, 'repo') })).body.id;
  ctx.newHu = async title => (await ctx.srv.api('POST', '/api/hus', { projectId: ctx.projectId, title })).body;
  ctx.post = (id, action, data) => ctx.srv.api('POST', `/api/hus/${id}/${action}`, data);
  ctx.run = (id, phase = 'analysis') => ctx.post(id, 'run', { phase });
  ctx.hu = id => getHu(ctx.srv, id);
  ctx.lastRun = async id => (await ctx.hu(id)).runs.at(-1);
  ctx.waitRunEnd = id => waitFor(async () => { const r = await ctx.lastRun(id); return r && r.status !== 'running' && r; });
  ctx.leader = async title => (await waitFor(() => sb.calls().find(c => c.prompt.includes(title)))).pid;
  ctx.descendants = parent => sb.procs().filter(p => p.parent === parent);
  ctx.restart = async (signal = 'SIGKILL', extra = overrides) => { await ctx.srv.stop(signal); ctx.srv = await startServer(sb, extra); return ctx.srv; };
  ctx.approved = async title => {
    const h = await ctx.newHu(title);
    await ctx.run(h.id);
    await waitHuStatus(ctx.srv, h.id, 'awaiting_approval');
    return (await ctx.post(h.id, 'approve')).body;
  };
  return ctx;
}
const terminalEvents = (h, runId) => h.events.filter(e => TERMINAL.includes(e.type) && e.details?.runId === runId);

// ---------- Finalización normal ----------

test('finalización normal: completed, grupo propio registrado y un único evento terminal', async () => {
  const c = await env();
  const h0 = await c.newHu('Normal');
  const started = (await c.run(h0.id)).body;
  assert.equal(started.pid, started.pgid, 'el líder encabeza su propio grupo');
  assert.equal(started.timeoutMs, 360000);
  const r = await c.waitRunEnd(h0.id);
  assert.equal(r.status, 'completed');
  assert.equal(r.endReason, 'completed');
  assert.equal(r.exitCode, 0);
  const h = await c.hu(h0.id);
  assert.equal(h.status, 'awaiting_approval');
  assert.equal(terminalEvents(h, r.id).length, 1);
  assert.equal(terminalEvents(h, r.id)[0].details.orphansTerminated, 0);
  assert.equal(h.allowedActions.cancel, false);
  assert.ok(!isAlive(r.pid));
});

// ---------- Cancelación ----------

test('cancelación voluntaria: SIGTERM al grupo, estado cancelled y HU recuperable', async () => {
  const c = await env();
  const h0 = await c.newHu('Cancelar [slow]');
  await c.run(h0.id);
  const leader = await c.leader('Cancelar [slow]');
  assert.equal((await c.hu(h0.id)).allowedActions.cancel, true);
  assert.deepEqual((await c.post(h0.id, 'cancel')).body, { ok: true });
  const r = await c.waitRunEnd(h0.id);
  assert.equal(r.status, 'cancelled');
  assert.equal(r.signal, 'SIGTERM');
  const h = await c.hu(h0.id);
  assert.equal(h.status, 'blocked');
  assert.deepEqual(h.events.map(e => e.type).slice(-2), ['cancel_requested', 'run_cancelled']);
  assert.equal(terminalEvents(h, r.id).length, 1);
  assert.ok(!isAlive(leader));
  assert.equal(h.allowedActions.analysis, true);
  assert.equal((await c.post(h0.id, 'cancel')).body.error, 'No hay ejecución activa');
});

test('proceso que ignora SIGTERM: SIGKILL tras el plazo; no se admite una segunda cancelación', async () => {
  const c = await env();
  const h0 = await c.newHu('Terco [stubborn]');
  await c.run(h0.id);
  const leader = await c.leader('Terco [stubborn]');
  const t0 = Date.now();
  await c.post(h0.id, 'cancel');
  const during = await c.hu(h0.id);
  assert.equal(during.allowedActions.cancel, false, 'ya está finalizando');
  assert.equal(during.allowedActions.edit, false);
  assert.equal((await c.post(h0.id, 'cancel')).body.error, 'La ejecución ya está finalizando');
  assert.ok(isAlive(leader), 'sigue vivo tras SIGTERM');
  const r = await c.waitRunEnd(h0.id);
  assert.ok(Date.now() - t0 >= GRACE - 50, 'esperó el plazo antes de SIGKILL');
  assert.equal(r.status, 'cancelled');
  assert.equal(r.signal, 'SIGKILL');
  assert.ok(!isAlive(leader));
  const h = await c.hu(h0.id);
  assert.equal(h.events.filter(e => e.type === 'cancel_requested').length, 1);
  assert.equal(terminalEvents(h, r.id).length, 1);
});

test('cancelación con descendientes: termina el grupo y también al que escapó con setsid', async () => {
  const c = await env();
  const h0 = await c.newHu('Árbol [tree]');
  await c.run(h0.id);
  const leader = await c.leader('Árbol [tree]');
  const kids = await waitFor(() => { const d = c.descendants(leader); return d.length === 2 && d; });
  assert.ok(kids.every(k => isAlive(k.pid)));
  await c.post(h0.id, 'cancel');
  const r = await c.waitRunEnd(h0.id);
  assert.equal(r.status, 'cancelled');
  await waitFor(() => [leader, ...kids.map(k => k.pid)].every(p => !isAlive(p)));
});

test('cancelación con descendientes que ignoran SIGTERM: SIGKILL a todos tras el plazo', async () => {
  const c = await env();
  const h0 = await c.newHu('Árbol terco [tree-stubborn]');
  await c.run(h0.id);
  const leader = await c.leader('Árbol terco [tree-stubborn]');
  const kids = await waitFor(() => { const d = c.descendants(leader); return d.length === 2 && d; });
  await c.post(h0.id, 'cancel');
  // El líder muere con SIGTERM, pero el hijo retiene stdout: la ejecución no termina hasta el SIGKILL.
  const r = await c.waitRunEnd(h0.id);
  assert.equal(r.status, 'cancelled');
  await waitFor(() => kids.every(k => !isAlive(k.pid)));
});

test('carrera: SIGTERM provoca salida con código 0 → sigue siendo cancelled y no actualiza el plan', async () => {
  const c = await env();
  const h0 = await c.newHu('Carrera [term-exit0]');
  await c.run(h0.id);
  await c.leader('Carrera [term-exit0]');
  await new Promise(r => setTimeout(r, 150)); // el simulador ya instaló su manejador de SIGTERM
  await c.post(h0.id, 'cancel');
  const r = await c.waitRunEnd(h0.id);
  assert.equal(r.exitCode, 0);
  assert.equal(r.status, 'cancelled');
  assert.match((await getLog(c.srv, r.id)).text, /PLAN tardío/);
  const h = await c.hu(h0.id);
  assert.equal(h.status, 'blocked');
  assert.equal(h.plan, '');
  assert.equal(h.allowedActions.approve, false);
  assert.equal(terminalEvents(h, r.id).length, 1);
  assert.ok(!h.events.some(e => e.type === 'run_completed'));
});

test('carrera: cancelar después de la salida natural no altera el resultado', async () => {
  const c = await env();
  const h0 = await c.newHu('Salida antes de cancelar');
  await c.run(h0.id);
  const r = await c.waitRunEnd(h0.id);
  assert.equal((await c.post(h0.id, 'cancel')).body.error, 'No hay ejecución activa');
  const h = await c.hu(h0.id);
  assert.equal(h.runs.at(-1).status, 'completed');
  assert.ok(!h.events.some(e => e.type === 'cancel_requested'));
  assert.equal(terminalEvents(h, r.id).length, 1);
});

test('cancelar QA conserva la aprobación vigente y permite reintentar QA', async () => {
  const c = await env();
  const h0 = await c.approved('QA cancelado');
  c.sb.setSlow(true);
  try {
    await c.run(h0.id, 'qa');
    await waitFor(async () => (await c.hu(h0.id)).status === 'qa' && c.sb.calls().length === 2);
    await c.post(h0.id, 'cancel');
    await waitHuStatus(c.srv, h0.id, 'blocked');
  } finally { c.sb.setSlow(false); }
  const h = await c.hu(h0.id);
  assert.equal(h.runs.at(-1).status, 'cancelled');
  assert.equal(h.approved, true);
  assert.equal(h.allowedActions.qa, true);
  await c.run(h0.id, 'qa');
  await waitHuStatus(c.srv, h0.id, 'qa_done');
});

test('cancelación con descendiente que borró su entorno: lo alcanza la señal al grupo verificado', async () => {
  const c = await env();
  const h0 = await c.newHu('Sin marca en grupo [tree-noenv]');
  await c.run(h0.id);
  const leader = await c.leader('Sin marca en grupo [tree-noenv]');
  const [kid] = await waitFor(() => { const d = c.descendants(leader); return d.length === 1 && d; });
  await c.post(h0.id, 'cancel');
  const r = await c.waitRunEnd(h0.id);
  assert.equal(r.status, 'cancelled');
  assert.equal(terminalEvents(await c.hu(h0.id), r.id)[0].details.forced, false);
  await waitFor(() => !isAlive(kid.pid));
});

test('error al iniciar (Headless no encontrado): failed/spawn_error con un único evento terminal', async () => {
  const c = await env({ PATH: '/usr/bin:/bin' }); // sin el simulado; el real no está en estas rutas
  const h0 = await c.newHu('Sin Headless');
  await c.run(h0.id);
  const r = await c.waitRunEnd(h0.id);
  assert.equal(r.status, 'failed');
  assert.equal(r.endReason, 'spawn_error');
  assert.match((await getLog(c.srv, r.id)).text, /ENOENT/);
  await new Promise(res => setTimeout(res, 200)); // margen por si llegara un 'close' tardío
  const h = await c.hu(h0.id);
  assert.equal(h.status, 'blocked');
  assert.equal(terminalEvents(h, r.id).length, 1);
  assert.equal(c.sb.calls().length, 0);
});

// ---------- Descendientes tras una salida natural ----------

test('salida natural con descendiente fuera del grupo: completed y el huérfano se termina', async () => {
  const c = await env();
  const h0 = await c.newHu('Huérfano [orphan]');
  await c.run(h0.id);
  const leader = await c.leader('Huérfano [orphan]');
  const [orphan] = await waitFor(() => { const d = c.descendants(leader); return d.length === 1 && d; });
  const r = await c.waitRunEnd(h0.id);
  assert.equal(r.status, 'completed');
  const h = await c.hu(h0.id);
  assert.equal(h.plan, 'PLAN simulado OK');
  assert.equal(terminalEvents(h, r.id)[0].details.orphansTerminated, 1);
  await waitFor(() => !isAlive(orphan.pid));
});

test('salida natural con hijo que retiene stdout: no queda colgada y el hijo se termina', async () => {
  const c = await env();
  const h0 = await c.newHu('Retiene [linger]');
  await c.run(h0.id);
  const leader = await c.leader('Retiene [linger]');
  const [kid] = await waitFor(() => { const d = c.descendants(leader); return d.length === 1 && d; });
  const r = await c.waitRunEnd(h0.id);
  assert.equal(r.status, 'completed');
  assert.equal(r.exitCode, 0);
  assert.equal(terminalEvents(await c.hu(h0.id), r.id)[0].details.orphansTerminated, 1);
  assert.ok(!isAlive(kid.pid));
});

test('hijo sin marca que retiene stdout: finalización acotada y sin señales a lo no verificable', async () => {
  const c = await env();
  const h0 = await c.newHu('Retiene sin marca [linger-noenv]');
  await c.run(h0.id);
  const leader = await c.leader('Retiene sin marca [linger-noenv]');
  const [kid] = await waitFor(() => { const d = c.descendants(leader); return d.length === 1 && d; });
  const t0 = Date.now();
  const r = await c.waitRunEnd(h0.id);
  assert.ok(Date.now() - t0 < GRACE * 2 + 1500, 'no queda colgada');
  assert.equal(r.status, 'completed');
  assert.equal(r.exitCode, 0);
  const ev = terminalEvents(await c.hu(h0.id), r.id);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].details.forced, true);
  assert.equal(ev[0].details.orphansTerminated, 0);
  assert.ok(isAlive(kid.pid), 'no se envían señales a un proceso no verificado (riesgo residual documentado)');
});

// ---------- Timeout ----------

test('timeout del servidor: termina el grupo y registra timeout como causa', async () => {
  const c = await env({ HUTRACEX_RUN_TIMEOUT_MS: '700' });
  const h0 = await c.newHu('Lento [slow]');
  assert.equal((await c.run(h0.id)).body.timeoutMs, 700);
  const leader = await c.leader('Lento [slow]');
  const r = await c.waitRunEnd(h0.id);
  assert.equal(r.status, 'failed');
  assert.equal(r.endReason, 'timeout');
  assert.equal(r.signal, 'SIGTERM');
  const h = await c.hu(h0.id);
  assert.equal(h.status, 'blocked');
  assert.deepEqual(h.events.map(e => e.type).slice(-2), ['timeout_reached', 'run_failed']);
  assert.equal(h.events.at(-1).details.reason, 'timeout');
  assert.equal(terminalEvents(h, r.id).length, 1);
  assert.ok(!isAlive(leader));
});

test('timeout con proceso que ignora SIGTERM: SIGKILL, y cancelar durante la finalización se rechaza', async () => {
  const c = await env({ HUTRACEX_RUN_TIMEOUT_MS: '500' });
  const h0 = await c.newHu('Lento y terco [stubborn]');
  await c.run(h0.id);
  await waitFor(async () => (await c.hu(h0.id)).events.some(e => e.type === 'timeout_reached'));
  assert.equal((await c.post(h0.id, 'cancel')).body.error, 'La ejecución ya está finalizando');
  const r = await c.waitRunEnd(h0.id);
  assert.equal(r.endReason, 'timeout');
  assert.equal(r.signal, 'SIGKILL');
  const h = await c.hu(h0.id);
  assert.equal(h.events.filter(e => e.type === 'timeout_reached').length, 1);
  assert.ok(!h.events.some(e => e.type === 'cancel_requested'));
  assert.equal(terminalEvents(h, r.id).length, 1);
});

test('timeout no se dispara tras una finalización normal ni tras una cancelación', async () => {
  const c = await env({ HUTRACEX_RUN_TIMEOUT_MS: '600' });
  const a = await c.newHu('Rápida');
  await c.run(a.id);
  await c.waitRunEnd(a.id);
  const b = await c.newHu('Cancelada antes del timeout [slow]');
  await c.run(b.id);
  await c.leader('Cancelada antes del timeout [slow]');
  await c.post(b.id, 'cancel');
  await c.waitRunEnd(b.id);
  await new Promise(r => setTimeout(r, 900));
  for (const id of [a.id, b.id]) assert.ok(!(await c.hu(id)).events.some(e => e.type === 'timeout_reached'));
  assert.equal((await c.lastRun(b.id)).status, 'cancelled');
});

// ---------- Reinicio ----------

test('reinicio durante análisis con descendientes: los procesos verificados se terminan', async () => {
  const c = await env();
  const h0 = await c.newHu('Reinicio árbol [tree]');
  await c.run(h0.id);
  const leader = await c.leader('Reinicio árbol [tree]');
  const kids = await waitFor(() => { const d = c.descendants(leader); return d.length === 2 && d; });
  await c.restart('SIGKILL');
  const h = await c.hu(h0.id);
  const r = h.runs.at(-1);
  assert.equal(r.status, 'interrupted');
  assert.equal(r.endReason, 'server_restart');
  assert.equal(h.status, 'blocked');
  const ev = h.events.at(-1);
  assert.equal(ev.type, 'run_interrupted');
  assert.equal(ev.details.survivors, 3);
  assert.equal(ev.details.previousStatus, 'analyzing');
  await waitFor(() => [leader, ...kids.map(k => k.pid)].every(p => !isAlive(p)));
  assert.equal(h.allowedActions.analysis, true);
  assert.equal(terminalEvents(h, r.id).length, 1);
});

test('reinicio durante QA: HU blocked con aprobación vigente; QA se puede reintentar', async () => {
  const c = await env();
  const h0 = await c.approved('Reinicio QA');
  c.sb.setSlow(true);
  await c.run(h0.id, 'qa');
  await waitFor(() => c.sb.calls().length === 2);
  await c.restart('SIGKILL');
  c.sb.setSlow(false);
  const h = await c.hu(h0.id);
  assert.equal(h.status, 'blocked');
  assert.equal(h.runs.at(-1).status, 'interrupted');
  assert.equal(h.runs.at(-1).phase, 'qa');
  assert.equal(h.approved, true, 'la aprobación del plan no se pierde');
  assert.equal(h.allowedActions.qa, true);
  assert.equal(h.allowedActions.manual, true);
  await c.run(h0.id, 'qa');
  await waitHuStatus(c.srv, h0.id, 'qa_done');
});

test('reinicio con ejecuciones históricas: se preservan y no se envían señales a procesos no verificados', async () => {
  const sb = makeSandbox();
  const repo = makeRepo(sb, 'repo');
  // Procesos ajenos: uno sin marca y otro con la marca de OTRA ejecución. Sus PID quedan en el registro.
  const opts = { detached: true, stdio: 'ignore' };
  const plain = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], opts);
  const foreign = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { ...opts, env: { ...process.env, HUTRACEX_RUN_ID: 'otra-ejecucion' } });
  cleanups.push(() => { for (const p of [plain, foreign]) try { p.kill('SIGKILL'); } catch {} sb.cleanup(); });
  const base = { projectId: 'p1', description: '', criteria: '', priority: 'medium', roles: { analysis: 'claude', implementation: 'codex', qa: 'antigravity' }, plan: '', approved: false, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' };
  const run = (id, huId, extra) => ({ id, huId, phase: 'analysis', agent: 'claude', startedAt: '2026-11-01T00:00:00.000Z', endedAt: null, output: 'x', exitCode: null, ...extra });
  const historical = [
    run('r-ok', 'h-hist', { status: 'completed', exitCode: 0, endedAt: '2026-11-01T00:01:00.000Z' }),
    run('r-fail', 'h-hist', { status: 'failed', exitCode: 3, endedAt: '2026-11-01T00:02:00.000Z' }),
    run('r-cancel', 'h-hist', { status: 'cancelled', endReason: 'cancelled', endedAt: '2026-11-01T00:03:00.000Z' }),
  ];
  const histEvent = { id: 'e1', huId: 'h-hist', type: 'created', message: 'HU registrada', details: {}, at: '2026-11-01T00:00:00.000Z' };
  sb.writeDb({
    projects: [{ id: 'p1', name: 'repo', path: repo, createdAt: '2026-11-01T00:00:00.000Z' }],
    hus: [
      { ...base, id: 'h-hist', title: 'Histórica', status: 'awaiting_approval', plan: 'PLAN' },
      { ...base, id: 'h-legacy', title: 'Legacy running', status: 'analyzing' },
      { ...base, id: 'h-plain', title: 'PID ajeno', status: 'analyzing' },
      { ...base, id: 'h-foreign', title: 'Marca ajena', status: 'qa' },
      { ...base, id: 'h-orphan-status', title: 'QA sin ejecución', status: 'qa' },
    ],
    events: [histEvent],
    runs: [
      ...historical,
      run('r-legacy', 'h-legacy', { status: 'running' }), // anterior a la Etapa 1.3: sin pid/pgid
      run('r-plain', 'h-plain', { status: 'running', pid: plain.pid, pgid: plain.pid }),
      run('r-foreign', 'h-foreign', { status: 'running', phase: 'qa', pid: foreign.pid, pgid: foreign.pid }),
    ],
  });
  const srv = await startServer(sb);
  cleanups.push(() => srv.stop());
  const db = sb.readDb();
  // Migración v1 → v2: misma ejecución, salida movida a data/runs/<id>.log.
  for (const r of historical) {
    const { output, ...meta } = r;
    const { log, ...migrated } = db.runs.find(x => x.id === r.id);
    assert.deepEqual(migrated, meta);
    assert.equal(log.migrated, true);
    assert.equal(fs.readFileSync(path.join(sb.app, 'data', log.file), 'utf8'), output);
  }
  assert.deepEqual(db.events.find(e => e.id === 'e1'), histEvent);
  for (const id of ['r-legacy', 'r-plain', 'r-foreign']) {
    const r = db.runs.find(x => x.id === id);
    assert.equal(r.status, 'interrupted', id);
    const ev = db.events.find(e => e.type === 'run_interrupted' && e.details.runId === id);
    assert.equal(ev.details.survivors, 0, `${id}: ningún proceso verificado como propio`);
  }
  await new Promise(r => setTimeout(r, GRACE + 200)); // por si se hubiera programado un SIGKILL
  assert.ok(isAlive(plain.pid), 'proceso sin marca: no recibe señales');
  assert.ok(isAlive(foreign.pid), 'proceso con marca de otra ejecución: no recibe señales');
  const { hus } = (await srv.api('GET', '/api/state')).body;
  for (const h of hus) assert.ok(!['analyzing', 'qa'].includes(h.status), h.id);
  assert.equal(hus.find(h => h.id === 'h-hist').status, 'awaiting_approval');
  assert.equal(hus.find(h => h.id === 'h-orphan-status').events.at(-1).type, 'state_repaired');
});

// ---------- Cierre del servidor ----------

test('cierre con SIGTERM: termina ejecuciones activas, las registra interrupted y libera el bloqueo', async () => {
  const c = await env();
  const h0 = await c.newHu('Cierre [tree]');
  await c.run(h0.id);
  const leader = await c.leader('Cierre [tree]');
  const kids = await waitFor(() => { const d = c.descendants(leader); return d.length === 2 && d; });
  const lock = path.join(c.sb.app, 'data', 'hutracex.lock');
  assert.ok(fs.existsSync(lock));
  const t0 = Date.now();
  await c.srv.stop('SIGTERM');
  assert.equal(c.srv.proc.exitCode, 0);
  assert.ok(Date.now() - t0 < GRACE + 2500, 'cierre acotado');
  assert.ok(!fs.existsSync(lock));
  const db = c.sb.readDb();
  const r = db.runs.find(x => x.huId === h0.id);
  assert.equal(r.status, 'interrupted');
  assert.equal(r.endReason, 'server_shutdown');
  assert.equal(db.hus.find(h => h.id === h0.id).status, 'blocked');
  assert.equal(db.events.filter(e => TERMINAL.includes(e.type) && e.details?.runId === r.id).length, 1);
  await waitFor(() => [leader, ...kids.map(k => k.pid)].every(p => !isAlive(p)));
  // Al volver a arrancar no hay nada que recuperar.
  c.srv = await startServer(c.sb);
  const h = await c.hu(h0.id);
  assert.ok(!h.events.some(e => e.details?.reason === 'server_restart'));
});

test('cierre con proceso que ignora SIGTERM: SIGKILL dentro del plazo y salida limpia', async () => {
  const c = await env();
  const h0 = await c.newHu('Cierre terco [stubborn]');
  await c.run(h0.id);
  const leader = await c.leader('Cierre terco [stubborn]');
  await c.srv.stop('SIGINT');
  assert.equal(c.srv.proc.exitCode, 0);
  const r = c.sb.readDb().runs.find(x => x.huId === h0.id);
  assert.equal(r.status, 'interrupted');
  assert.equal(r.signal, 'SIGKILL');
  assert.ok(!isAlive(leader));
  c.srv = await startServer(c.sb);
});

// ---------- Instancia única ----------

test('una segunda instancia sobre los mismos datos se rechaza; la primera sigue operando', async () => {
  const c = await env();
  const r = await runServerExpectExit(c.sb);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Otra instancia de HuTraceX \(PID \d+\)/);
  assert.equal((await c.srv.api('GET', '/api/state')).status, 200);
  assert.ok(fs.existsSync(path.join(c.sb.app, 'data', 'hutracex.lock')), 'el bloqueo de la primera sigue intacto');
});

test('bloqueo obsoleto (instancia caída o PID reutilizado) se reemplaza', async () => {
  const c = await env();
  await c.srv.stop('SIGKILL'); // deja el bloqueo de un proceso muerto
  const lock = path.join(c.sb.app, 'data', 'hutracex.lock');
  assert.ok(fs.existsSync(lock));
  c.srv = await startServer(c.sb);
  assert.equal((await c.srv.api('GET', '/api/state')).status, 200);
  await c.srv.stop('SIGKILL');
  // PID vivo (el de este proceso de pruebas) pero con otra hora de inicio: no es la instancia original.
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startTime: '1', bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() }));
  c.srv = await startServer(c.sb);
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, c.srv.proc.pid);
});

// ---------- Integridad ----------

test('integridad: cada ejecución finalizada tiene exactamente un evento terminal y ninguna HU queda en ejecución sin proceso', async () => {
  const c = await env({ HUTRACEX_RUN_TIMEOUT_MS: '800' });
  const scenarios = ['Int ok', 'Int fail [fail]', 'Int cancel [slow]', 'Int timeout [stubborn]', 'Int orphan [orphan]'];
  const ids = [];
  for (const t of scenarios) { const h = await c.newHu(t); ids.push(h.id); await c.run(h.id); }
  await c.leader('Int cancel [slow]');
  await c.post(ids[2], 'cancel');
  for (const id of ids) await c.waitRunEnd(id);
  const { hus } = (await c.srv.api('GET', '/api/state')).body;
  for (const h of hus) {
    assert.ok(!['analyzing', 'qa'].includes(h.status), h.title);
    assert.equal(h.allowedActions.cancel, false, h.title);
    assert.equal(h.allowedActions.edit, true, h.title);
    for (const r of h.runs) assert.equal(terminalEvents(h, r.id).length, 1, `${h.title} ${r.id}`);
  }
  const by = t => hus.find(h => h.title === t).runs.at(-1);
  assert.deepEqual(
    scenarios.map(t => [by(t).status, by(t).endReason]),
    [['completed', 'completed'], ['failed', 'exit_code'], ['cancelled', 'cancelled'], ['failed', 'timeout'], ['completed', 'completed']],
  );
  for (const h of hus) for (const r of h.runs) await waitFor(() => !isAlive(r.pid));
});
