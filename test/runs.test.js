// Ejecución de agentes con el Headless simulado (test/fixtures/fake-headless.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox, makeRepo, startServer, getHu, waitFor, waitHuStatus, isAlive, getLog } from './helpers.js';

let sb, srv, repo, projectId;

before(async () => {
  sb = makeSandbox();
  repo = makeRepo(sb, 'repo');
  srv = await startServer(sb);
  projectId = (await srv.api('POST', '/api/projects', { path: repo })).body.id;
});
after(async () => { await srv?.stop(); sb?.cleanup(); });

const newHu = async (fields = {}) => (await srv.api('POST', '/api/hus', { projectId, title: 'HU', ...fields })).body;
const run = (id, phase) => srv.api('POST', `/api/hus/${id}/run`, { phase });
const callsFor = title => sb.calls().filter(c => c.prompt.includes(title));
const latestRun = hu => hu.runs[hu.runs.length - 1];

async function analyzedAndApproved(title) {
  const hu = await newHu({ title });
  await run(hu.id, 'analysis');
  await waitHuStatus(srv, hu.id, 'awaiting_approval');
  await srv.api('POST', `/api/hus/${hu.id}/approve`);
  return hu;
}

test('flujo completo: análisis → aprobación → implementación manual → QA → cierre', async () => {
  const hu = await newHu({ title: 'Flujo completo', description: 'DESC-1', criteria: 'CRIT-1', businessRules: 'BR-1' });

  const started = await run(hu.id, 'analysis');
  assert.equal(started.status, 202);
  assert.equal(started.body.status, 'running');
  assert.equal(started.body.agent, 'claude');
  assert.equal(started.body.phase, 'analysis');

  let h = await waitHuStatus(srv, hu.id, 'awaiting_approval');
  assert.equal(h.plan, 'PLAN simulado OK');
  assert.equal(latestRun(h).status, 'completed');
  assert.equal(latestRun(h).exitCode, 0);
  assert.ok(latestRun(h).endedAt);

  const [analysisCall] = callsFor('Flujo completo');
  assert.equal(analysisCall.cwd, repo);
  const a = analysisCall.argv;
  assert.deepEqual(a.slice(0, 4), ['claude', '--allow', 'read-only', '--work-dir']);
  assert.equal(a[4], repo);
  assert.deepEqual(a.slice(5), ['--prompt-file', a[6], '--sdk-format', 'ndjson', '--timeout', '300']);
  assert.match(a[6], /\/data\/runs\/[0-9a-f-]+\.prompt\.md$/);
  assert.ok(!a.includes('--prompt'), 'el prompt no viaja como argumento (A7)');
  const prompt = analysisCall.prompt;
  assert.match(prompt, /^\[INSTRUCCIONES DEL SISTEMA · hutracex-prompt\/1\]\nFase: analysis\nEres el analista técnico/);
  for (const s of ['Flujo completo', 'DESC-1', 'CRIT-1', 'BR-1', 'NO ejecutes migraciones, SQL']) assert.ok(prompt.includes(s), s);

  h = (await srv.api('POST', `/api/hus/${hu.id}/approve`)).body;
  assert.equal(h.status, 'approved');
  assert.equal(h.approved, true);

  assert.equal((await srv.api('POST', `/api/hus/${hu.id}/manual`, { message: '  ' })).body.error, 'Describe la evidencia o trabajo realizado');
  h = (await srv.api('POST', `/api/hus/${hu.id}/manual`, { message: 'rama feature/x, commit abc' })).body;
  assert.equal(h.status, 'implementation_done');
  assert.equal(h.events.at(-1).details.message, 'rama feature/x, commit abc');

  assert.equal((await run(hu.id, 'qa')).status, 202);
  h = await waitHuStatus(srv, hu.id, 'qa_done');
  assert.equal(latestRun(h).agent, 'antigravity');
  assert.equal((await getLog(srv, latestRun(h).id)).agent, 'QA simulado OK\n');
  const qaCall = callsFor('Flujo completo')[1];
  assert.equal(qaCall.argv[0], 'antigravity');
  assert.ok(qaCall.prompt.includes('"contenido": "PLAN simulado OK"'), 'el plan aprobado llega al QA como dato');

  h = (await srv.api('POST', `/api/hus/${hu.id}/close`)).body;
  assert.equal(h.status, 'done');
  assert.deepEqual(h.events.map(e => e.type), [
    'created', 'run_started', 'run_completed', 'approved',
    'manual_implementation', 'run_started', 'run_completed', 'closed',
  ]);
});

test('codex recibe --model con el modelo configurado', async () => {
  const hu = await newHu({ title: 'Con codex', roles: { analysis: 'codex' } });
  await run(hu.id, 'analysis');
  await waitHuStatus(srv, hu.id, 'awaiting_approval');
  assert.deepEqual(callsFor('Con codex')[0].argv.slice(0, 5), ['codex', '--model', 'gpt-6-luna', '--allow', 'read-only']);
});

test('fallo del agente: ejecución failed, HU blocked y salida stderr registrada', async () => {
  const hu = await newHu({ title: 'Falla [fail]' });
  await run(hu.id, 'analysis');
  const h = await waitHuStatus(srv, hu.id, 'blocked');
  const r = latestRun(h);
  assert.equal(r.status, 'failed');
  assert.equal(r.exitCode, 3);
  assert.equal((await getLog(srv, r.id)).agent, 'fake failure\n');
  assert.equal(h.plan, '');
  assert.equal(h.events.at(-1).type, 'run_failed');
});

test('ejecución activa: bloquea segunda ejecución y edición; cancelar marca cancelled/blocked', async () => {
  const hu = await newHu({ title: 'Lenta [slow]' });
  await run(hu.id, 'analysis');
  await waitFor(() => callsFor('Lenta [slow]').length === 1);
  assert.equal((await getHu(srv, hu.id)).status, 'analyzing');

  assert.equal((await run(hu.id, 'analysis')).body.error, 'Ya existe una ejecución activa para esta HU');
  assert.equal((await srv.api('PATCH', `/api/hus/${hu.id}`, { title: 'x' })).body.error, 'No puedes editar una HU durante una ejecución');

  const c = await srv.api('POST', `/api/hus/${hu.id}/cancel`);
  assert.deepEqual(c.body, { ok: true });
  const h = await waitHuStatus(srv, hu.id, 'blocked');
  assert.equal(latestRun(h).status, 'cancelled');
  assert.equal(latestRun(h).endReason, 'cancelled');
  assert.equal(latestRun(h).exitCode, null);
  assert.equal(latestRun(h).signal, 'SIGTERM');
  assert.deepEqual(h.events.map(e => e.type), ['created', 'run_started', 'cancel_requested', 'run_cancelled']);
});

test('A1 corregido: re-analizar una HU aprobada invalida la aprobación y exige aprobar el nuevo plan', async () => {
  const hu = await analyzedAndApproved('Reanálisis');
  await run(hu.id, 'analysis');
  const h = await waitHuStatus(srv, hu.id, 'awaiting_approval');
  assert.equal(h.approved, false);
  assert.equal((await run(hu.id, 'qa')).body.error, 'Aprueba el plan antes de QA');
  assert.equal((await srv.api('POST', `/api/hus/${hu.id}/approve`)).status, 200);
  assert.equal((await run(hu.id, 'qa')).status, 202);
  await waitHuStatus(srv, hu.id, 'qa_done');
});

test('A2 corregido: editar el contenido de una HU aprobada vuelve a "awaiting_approval" y el flujo continúa', async () => {
  const hu = await analyzedAndApproved('Edición tras aprobar');
  const h = (await srv.api('PATCH', `/api/hus/${hu.id}`, { criteria: 'nuevos criterios' })).body;
  assert.equal(h.status, 'awaiting_approval');
  assert.equal(h.approved, false);
  assert.equal((await run(hu.id, 'qa')).body.error, 'Aprueba el plan antes de QA');
  assert.equal((await srv.api('POST', `/api/hus/${hu.id}/approve`)).status, 200);
  assert.equal((await srv.api('POST', `/api/hus/${hu.id}/manual`, { message: 'x' })).body.status, 'implementation_done');
});

test('A3 corregido: tras reiniciar el servidor, la ejecución queda interrupted y la HU puede continuar', async () => {
  const hu = await newHu({ title: 'Reinicio [slow]' });
  await run(hu.id, 'analysis');
  await waitFor(() => callsFor('Reinicio [slow]').length === 1);
  const leader = callsFor('Reinicio [slow]')[0].pid;
  await srv.stop('SIGKILL');
  assert.ok(isAlive(leader), 'el agente sobrevive a la caída del servidor');
  srv = await startServer(sb);

  const h = await getHu(srv, hu.id);
  assert.equal(h.status, 'blocked');
  assert.equal(latestRun(h).status, 'interrupted');
  assert.equal(latestRun(h).endReason, 'server_restart');
  assert.equal(h.events.at(-1).type, 'run_interrupted');
  assert.equal(h.events.at(-1).details.survivors, 1);
  await waitFor(() => !isAlive(leader));
  assert.equal(h.allowedActions.analysis, true);
  assert.equal((await srv.api('POST', `/api/hus/${hu.id}/cancel`)).body.error, 'No hay ejecución activa');
  // Los datos previos sobreviven al reinicio.
  const state = (await srv.api('GET', '/api/state')).body;
  assert.ok(state.projects.some(p => p.id === projectId));
  assert.ok(state.hus.some(x => x.title === 'Flujo completo' && x.status === 'done'));
});
