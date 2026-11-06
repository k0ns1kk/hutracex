// Integridad del workflow y de las aprobaciones (Etapa 1.2: A1, A2).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox, makeRepo, startServer, getHu, waitHuStatus } from './helpers.js';

let sb, srv, projectId;

before(async () => {
  sb = makeSandbox();
  srv = await startServer(sb);
  projectId = (await srv.api('POST', '/api/projects', { path: makeRepo(sb, 'repo') })).body.id;
});
after(async () => { await srv?.stop(); sb?.cleanup(); });

const newHu = async (fields = {}) => (await srv.api('POST', '/api/hus', { projectId, title: 'HU', description: 'D', criteria: 'C', ...fields })).body;
const post = (id, action, data) => srv.api('POST', `/api/hus/${id}/${action}`, data);
const run = (id, phase) => post(id, 'run', { phase });
const patch = (id, data) => srv.api('PATCH', `/api/hus/${id}`, data);
const types = h => h.events.map(e => e.type);
const lastEvent = (h, type) => h.events.filter(e => e.type === type).at(-1);
const ACTIONS = { analysis: ['run', { phase: 'analysis' }], qa: ['run', { phase: 'qa' }], approve: ['approve'], manual: ['manual', { message: 'evidencia' }], close: ['close'] };

async function analyzed(fields) {
  const hu = await newHu(fields);
  await run(hu.id, 'analysis');
  return waitHuStatus(srv, hu.id, 'awaiting_approval');
}
async function approved(fields) {
  const hu = await analyzed(fields);
  return (await post(hu.id, 'approve')).body;
}
async function toStatus(status) {
  const h = await approved();
  if (status === 'approved') return h;
  if (status === 'implementation_done') return (await post(h.id, 'manual', { message: 'impl' })).body;
  await run(h.id, 'qa');
  const q = await waitHuStatus(srv, h.id, 'qa_done');
  return status === 'done' ? (await post(h.id, 'close')).body : q;
}

// Toda acción que el backend declara no permitida debe ser rechazada por la API (sin efectos).
async function assertForbiddenActionsRejected(hu) {
  const before = await getHu(srv, hu.id);
  const callsBefore = sb.calls().length;
  for (const [action, [path, data]] of Object.entries(ACTIONS)) {
    if (before.allowedActions[action]) continue;
    const r = await post(hu.id, path, data);
    assert.equal(r.status, 400, `${before.status}: ${action} debería rechazarse`);
  }
  const after = await getHu(srv, hu.id);
  assert.equal(after.status, before.status);
  assert.equal(after.events.length, before.events.length);
  assert.equal(sb.calls().length, callsBefore, 'no debe lanzar Headless');
  return after;
}

// ---------- A1: nuevo análisis ----------

test('nuevo análisis sobre HU aprobada: invalida de inmediato, registra el evento y bloquea QA/implementación', async () => {
  const h0 = await approved({ title: 'Reanálisis inmediato' });
  const firstPlanRun = h0.planRunId;
  sb.setSlow(true);
  try {
    assert.equal((await run(h0.id, 'analysis')).status, 202);
    const h = await getHu(srv, h0.id);
    assert.equal(h.status, 'analyzing');
    assert.equal(h.approved, false);
    assert.equal(h.approvalHash, null);
    assert.deepEqual(types(h).slice(-2), ['approval_invalidated', 'run_started']);
    const inv = lastEvent(h, 'approval_invalidated');
    assert.equal(inv.details.reason, 'new_analysis');
    assert.equal(inv.details.previousStatus, 'approved');
    assert.equal(inv.details.runId, h.runs.at(-1).id);
    assert.deepEqual(
      Object.fromEntries(['analysis', 'approve', 'manual', 'qa', 'close'].map(a => [a, h.allowedActions[a]])),
      { analysis: false, approve: false, manual: false, qa: false, close: false },
    );
    await post(h0.id, 'cancel');
    await waitHuStatus(srv, h0.id, 'blocked');
  } finally { sb.setSlow(false); }

  // Tras cancelar: la aprobación anterior no revive.
  const blocked = await getHu(srv, h0.id);
  assert.equal(blocked.approved, false);
  assert.equal((await run(h0.id, 'qa')).body.error, 'Aprueba el plan antes de QA');
  assert.equal((await post(h0.id, 'manual', { message: 'x' })).body.error, 'Primero aprueba el plan');
  assert.equal((await post(h0.id, 'approve')).body.error, 'Primero completa el análisis');
  await assertForbiddenActionsRejected(blocked);

  // Recuperación: nuevo análisis → aprobar el plan nuevo (otra ejecución, nuevo evento).
  await run(h0.id, 'analysis');
  await waitHuStatus(srv, h0.id, 'awaiting_approval');
  const re = (await post(h0.id, 'approve')).body;
  assert.equal(re.approved, true);
  assert.notEqual(re.planRunId, firstPlanRun);
  assert.equal(lastEvent(re, 'approved').details.planRunId, re.planRunId);
  assert.equal(re.events.filter(e => e.type === 'approved').length, 2);
});

test('nuevo análisis sobre HU no aprobada no registra invalidación', async () => {
  const h = await analyzed({ title: 'Sin aprobación previa' });
  await run(h.id, 'analysis');
  const r = await waitHuStatus(srv, h.id, 'awaiting_approval');
  assert.ok(!types(r).includes('approval_invalidated'));
});

test('QA con aprobación obsoleta (tras nuevo análisis) es rechazado por la API', async () => {
  const h = await approved({ title: 'QA obsoleto' });
  await run(h.id, 'analysis');
  await waitHuStatus(srv, h.id, 'awaiting_approval');
  const callsBefore = sb.calls().length;
  const r = await run(h.id, 'qa');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Aprueba el plan antes de QA');
  assert.equal(sb.calls().length, callsBefore, 'no debe lanzar Headless');
});

// ---------- A2: edición ----------

for (const status of ['approved', 'implementation_done', 'qa_done', 'done']) {
  test(`editar contenido en "${status}": invalida aprobación, vuelve a awaiting_approval y registra trazabilidad`, async () => {
    const h0 = await toStatus(status);
    const h = (await patch(h0.id, { description: 'Descripción nueva', priority: 'high' })).body;
    assert.equal(h.status, 'awaiting_approval');
    assert.equal(h.approved, false);
    assert.deepEqual(types(h).slice(-2), ['updated', 'approval_invalidated']);
    const upd = lastEvent(h, 'updated');
    assert.deepEqual(upd.details.fields, ['description', 'priority']);
    assert.equal(upd.details.message, 'Cambios: descripción, prioridad');
    const inv = lastEvent(h, 'approval_invalidated');
    assert.equal(inv.details.reason, 'content_changed');
    assert.deepEqual(inv.details.fields, ['description']);
    assert.equal(inv.details.previousStatus, status);
    assert.equal(inv.details.status, 'awaiting_approval');
    // Ninguna acción queda bloqueada: se puede aprobar o re-analizar.
    assert.equal(h.allowedActions.approve, true);
    assert.equal(h.allowedActions.analysis, true);
    await assertForbiddenActionsRejected(h);
    // Recuperación completa del flujo.
    const a = (await post(h.id, 'approve')).body;
    assert.equal(a.status, 'approved');
    await run(h.id, 'qa');
    await waitHuStatus(srv, h.id, 'qa_done');
    assert.equal((await post(h.id, 'close')).body.status, 'done');
  });
}

test('cada campo de contenido invalida la aprobación', async () => {
  for (const field of ['title', 'description', 'criteria', 'businessRules', 'technicalConstraints', 'observations']) {
    const h0 = await approved({ title: `Campo ${field}` });
    const h = (await patch(h0.id, { [field]: `nuevo ${field}` })).body;
    assert.equal(h.approved, false, field);
    assert.equal(h.status, 'awaiting_approval', field);
  }
});

test('cambios administrativos (agentes, prioridad) no invalidan la aprobación y quedan registrados', async () => {
  const h0 = await approved({ title: 'Administrativo' });
  const h = (await patch(h0.id, { priority: 'low', roles: { qa: 'codex' } })).body;
  assert.equal(h.status, 'approved');
  assert.equal(h.approved, true);
  assert.equal(h.approvalHash, h0.approvalHash);
  assert.ok(!types(h).includes('approval_invalidated'));
  const upd = lastEvent(h, 'updated');
  assert.deepEqual(upd.details.fields, ['priority', 'roles']);
  assert.deepEqual(upd.details.changes.priority, { from: 'medium', to: 'low' });
  assert.equal(upd.details.changes.roles.from.qa, 'antigravity');
  assert.equal(upd.details.changes.roles.to.qa, 'codex');
  // El QA usa el agente reasignado sin volver a aprobar.
  assert.equal((await run(h.id, 'qa')).body.agent, 'codex');
  await waitHuStatus(srv, h.id, 'qa_done');
});

test('PATCH sin cambios reales (mismos valores) no registra eventos ni invalida', async () => {
  const h0 = await approved({ title: 'Sin cambios' });
  const h = (await patch(h0.id, { title: 'Sin cambios', description: 'D', criteria: 'C', priority: 'medium', roles: { ...h0.roles } })).body;
  assert.equal(h.events.length, h0.events.length);
  assert.equal(h.approved, true);
  assert.equal(h.updatedAt, h0.updatedAt);
});

test('editar contenido en awaiting_approval: se mantiene el estado y la aprobación posterior cubre el contenido nuevo', async () => {
  const h0 = await analyzed({ title: 'Pendiente' });
  const h = (await patch(h0.id, { criteria: 'C2' })).body;
  assert.equal(h.status, 'awaiting_approval');
  assert.ok(!types(h).includes('approval_invalidated'));
  const a = (await post(h.id, 'approve')).body;
  assert.equal(a.approved, true);
  assert.equal(a.criteria, 'C2');
});

test('editar contenido en draft/blocked sin aprobación no cambia el estado', async () => {
  const d = await newHu({ title: 'Borrador' });
  assert.equal((await patch(d.id, { description: 'x' })).body.status, 'draft');
  const b = await newHu({ title: 'Bloqueada', initialStatus: 'blocked' });
  assert.equal((await patch(b.id, { description: 'x' })).body.status, 'blocked');
});

test('PATCH rechaza título vacío', async () => {
  const h = await newHu({ title: 'Con título' });
  const r = await patch(h.id, { title: '   ' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Escribe un título');
  assert.equal((await getHu(srv, h.id)).title, 'Con título');
});

// ---------- Saltos de estado por API ----------

test('saltos de estado por API: toda acción no permitida es rechazada en cada etapa', async () => {
  const d = await newHu({ title: 'Saltos draft' });
  assert.deepEqual(
    Object.fromEntries(Object.keys(ACTIONS).map(a => [a, d.allowedActions[a]])),
    { analysis: true, qa: false, approve: false, manual: false, close: false },
  );
  await assertForbiddenActionsRejected(d);
  for (const status of ['approved', 'implementation_done', 'qa_done', 'done']) {
    await assertForbiddenActionsRejected(await toStatus(status));
  }
  await assertForbiddenActionsRejected(await analyzed({ title: 'Saltos pendiente' }));
});

test('saltos concretos: aprobar dos veces, cerrar sin QA, QA/implementación sobre HU cerrada', async () => {
  const a = await approved({ title: 'Saltos concretos' });
  assert.equal((await post(a.id, 'approve')).body.error, 'Primero completa el análisis');
  assert.equal((await post(a.id, 'close')).body.error, 'Completa QA antes de cerrar');
  const impl = (await post(a.id, 'manual', { message: 'x' })).body;
  assert.equal((await post(impl.id, 'close')).body.error, 'Completa QA antes de cerrar');
  const done = await toStatus('done');
  assert.equal((await run(done.id, 'qa')).body.error, 'Acción no disponible en el estado actual de la HU');
  assert.equal((await post(done.id, 'manual', { message: 'x' })).body.error, 'Acción no disponible en el estado actual de la HU');
  assert.equal((await post(done.id, 'close')).body.error, 'Completa QA antes de cerrar');
  assert.equal((await run(done.id, 'implementation')).body.error, 'Etapa no disponible para ejecución automática');
});

test('reabrir una HU cerrada solo es posible con un nuevo análisis, que invalida la aprobación', async () => {
  const done = await toStatus('done');
  await run(done.id, 'analysis');
  const h = await waitHuStatus(srv, done.id, 'awaiting_approval');
  assert.equal(h.approved, false);
  assert.equal(lastEvent(h, 'approval_invalidated').details.previousStatus, 'done');
});

test('QA fallido (blocked con aprobación vigente) permite reintentar QA o registrar implementación', async () => {
  const h0 = await approved({ title: 'QA falla' });
  sb.setFail(true);
  try {
    await run(h0.id, 'qa');
    await waitHuStatus(srv, h0.id, 'blocked');
  } finally { sb.setFail(false); }
  const b = await getHu(srv, h0.id);
  assert.equal(b.approved, true);
  assert.equal(b.allowedActions.qa, true);
  assert.equal(b.allowedActions.manual, true);
  assert.equal(b.allowedActions.approve, false);
  await assertForbiddenActionsRejected(b);
  await run(h0.id, 'qa');
  await waitHuStatus(srv, h0.id, 'qa_done');
  // Editar contenido estando bloqueada con aprobación también vuelve a pedir aprobación.
  const h1 = await approved({ title: 'QA falla y edición' });
  sb.setFail(true);
  try { await run(h1.id, 'qa'); await waitHuStatus(srv, h1.id, 'blocked'); } finally { sb.setFail(false); }
  const e = (await patch(h1.id, { criteria: 'otro' })).body;
  assert.equal(e.status, 'awaiting_approval');
  assert.equal(e.approved, false);
});

test('análisis sin salida: no se puede aprobar un plan vacío, pero se puede re-analizar', async () => {
  const hu = await newHu({ title: 'Vacío [empty]' });
  await run(hu.id, 'analysis');
  // M2: una respuesta vacía es un fallo explícito (Headless emite un sobre de error), no un plan vacío.
  const h = await waitHuStatus(srv, hu.id, 'blocked');
  assert.equal(h.plan, '');
  assert.equal(h.runs.at(-1).status, 'failed');
  assert.match(h.runs.at(-1).result.error, /agent exited with code 1/);
  assert.equal(h.allowedActions.approve, false);
  assert.equal(h.allowedActions.analysis, true);
  assert.equal((await post(hu.id, 'approve')).body.error, 'Primero completa el análisis');
});

// ---------- Persistencia ----------

test('persistencia: la aprobación se guarda ligada al plan y sobrevive al reinicio', async () => {
  const h = await approved({ title: 'Persistente' });
  const saved = sb.readDb().hus.find(x => x.id === h.id);
  assert.equal(saved.approved, true);
  assert.match(saved.approvalHash, /^[0-9a-f]{64}$/);
  assert.ok(saved.approvedAt);
  assert.ok(sb.readDb().runs.some(r => r.id === saved.planRunId && r.phase === 'analysis' && r.status === 'completed'));
  const approvedEvent = sb.readDb().events.filter(e => e.huId === h.id && e.type === 'approved').at(-1);
  assert.equal(approvedEvent.details.approvalHash, saved.approvalHash);

  await srv.stop();
  srv = await startServer(sb);
  const r = await getHu(srv, h.id);
  assert.equal(r.approved, true);
  assert.equal(r.allowedActions.qa, true);
});

test('persistencia: un plan alterado en disco invalida la aprobación al arrancar', async () => {
  const h = await approved({ title: 'Alterado' });
  await srv.stop();
  const db = sb.readDb();
  db.hus.find(x => x.id === h.id).plan = 'plan modificado fuera de HuTraceX';
  sb.writeDb(db);
  srv = await startServer(sb);
  const r = await getHu(srv, h.id);
  assert.equal(r.approved, false);
  assert.equal(r.status, 'awaiting_approval');
  assert.equal(lastEvent(r, 'approval_invalidated').details.reason, 'stale_approval');
  assert.equal((await run(h.id, 'qa')).body.error, 'Aprueba el plan antes de QA');
});

// ---------- Compatibilidad con datos existentes ----------

test('compatibilidad: HU guardadas antes de la Etapa 1.2 se reparan al arrancar', async () => {
  const legacy = makeSandbox();
  const repo = makeRepo(legacy, 'repo');
  const base = { projectId: 'p1', description: 'D', criteria: 'C', priority: 'medium', roles: { analysis: 'claude', implementation: 'codex', qa: 'antigravity' }, models: { codex: 'gpt-6-luna' }, plan: 'PLAN', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' };
  legacy.writeDb({
    projects: [{ id: 'p1', name: 'repo', path: repo, createdAt: '2026-11-01T00:00:00.000Z' }],
    hus: [
      { ...base, id: 'legacy-ok', title: 'Aprobada sin hash', status: 'approved', approved: true },
      { ...base, id: 'a1', title: 'A1 guardado', status: 'awaiting_approval', approved: true },
      { ...base, id: 'a2', title: 'A2 guardado', status: 'approved', approved: false },
      { ...base, id: 'a2-noplan', title: 'A2 sin plan', status: 'implementation_done', approved: false, plan: '' },
      { ...base, id: 'done', title: 'Cerrada', status: 'done', approved: false },
    ],
    events: [], runs: [],
  });
  const s = await startServer(legacy);
  try {
    const { hus } = (await s.api('GET', '/api/state')).body;
    const by = id => hus.find(h => h.id === id);
    assert.equal(by('legacy-ok').status, 'approved');
    assert.equal(by('legacy-ok').approved, true);
    assert.equal(by('legacy-ok').allowedActions.qa, true);
    assert.equal(by('legacy-ok').events.length, 0, 'aprobación legítima: sin eventos de reparación');

    assert.equal(by('a1').approved, false);
    assert.equal(by('a1').status, 'awaiting_approval');
    assert.equal(by('a1').events.at(-1).type, 'approval_invalidated');

    assert.equal(by('a2').status, 'awaiting_approval');
    assert.equal(by('a2').events.at(-1).type, 'state_repaired');
    // Etapa 1.5: un plan sin resultado estructurado verificable (anterior a 1.5) exige re-analizar.
    assert.equal(by('a2').allowedActions.approve, false);
    assert.match((await s.api('POST', '/api/hus/a2/approve')).body.error, /no proviene de un resultado válido/);
    assert.equal(by('a2-noplan').status, 'draft');
    assert.equal(by('a2-noplan').allowedActions.analysis, true);

    assert.equal(by('done').status, 'done');
    assert.equal(by('done').allowedActions.analysis, true);
    // Ninguna HU queda sin una acción posible.
    for (const h of hus) assert.ok(['analysis', 'approve', 'manual', 'qa', 'close'].some(a => h.allowedActions[a]), h.id);
    assert.ok(legacy.readDb().hus.find(h => h.id === 'legacy-ok').approvalHash);
  } finally { await s.stop(); legacy.cleanup(); }
});
