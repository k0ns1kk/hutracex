// Pruebas de caracterización: fijan el comportamiento ACTUAL de la API.
// Las marcadas [CONOCIDO …] documentan defectos (ver docs/known-issues.md);
// deben cambiar a propósito cuando se corrija el defecto, no por accidente.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox, makeRepo, startServer } from './helpers.js';

let sb, srv, repo, projectId;

before(async () => {
  sb = makeSandbox();
  repo = makeRepo(sb, 'repo-a');
  makeRepo(sb, 'plain-dir', { git: false });
  makeRepo(sb, '.hidden', { git: false });
  fs.symlinkSync(repo, path.join(sb.home, 'link-to-repo'));
  srv = await startServer(sb);
});
after(async () => { await srv?.stop(); sb?.cleanup(); });

// ---------- Archivos estáticos y enrutado ----------

test('sirve solo index.html, app.js y style.css', async () => {
  const index = await srv.api('GET', '/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.equal((await srv.api('GET', '/app.js')).status, 200);
  assert.equal((await srv.api('GET', '/style.css')).status, 200);
  for (const p of ['/server.js', '/package.json', '/data/tracker.json', '/public/app.js']) {
    assert.equal((await srv.api('GET', p)).status, 404, p);
  }
});

test('ruta de API desconocida responde 404 JSON', async () => {
  const r = await srv.api('GET', '/api/nope');
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, { error: 'Ruta no encontrada' });
});

test('JSON inválido responde 400', async () => {
  const r = await srv.api('POST', '/api/projects', 'no es json');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'JSON inválido');
});

// ---------- Proyectos ----------

test('proyecto: valida la ruta', async () => {
  const cases = [
    [{ path: '' }, 'Indica una ruta absoluta'],
    [{}, 'Indica una ruta absoluta'],
    [{ path: 'relativa/repo' }, 'La ruta debe ser absoluta'],
    [{ path: path.join(sb.home, 'no-existe') }, 'La carpeta no existe o no es un repositorio Git'],
    [{ path: path.join(sb.home, 'plain-dir') }, 'La carpeta no es un repositorio Git'],
  ];
  for (const [payload, error] of cases) {
    const r = await srv.api('POST', '/api/projects', payload);
    assert.equal(r.status, 400, JSON.stringify(payload));
    assert.equal(r.body.error, error);
  }
});

test('proyecto: registra un repo Git con nombre por defecto y lo persiste con permisos 0600', async () => {
  const r = await srv.api('POST', '/api/projects', { path: repo });
  assert.equal(r.status, 201);
  assert.equal(r.body.name, 'repo-a');
  assert.equal(r.body.path, repo);
  assert.match(r.body.id, /^[0-9a-f-]{36}$/);
  projectId = r.body.id;
  const saved = JSON.parse(fs.readFileSync(sb.dbFile, 'utf8'));
  assert.ok(saved.projects.some(p => p.id === projectId));
  assert.equal(fs.statSync(sb.dbFile).mode & 0o777, 0o600);
});

test('proyecto: expande ~/ y recorta el nombre a 100 caracteres', async () => {
  const r = await srv.api('POST', '/api/projects', { path: '~/repo-a', name: 'x'.repeat(150) });
  assert.equal(r.status, 201);
  assert.equal(r.body.path, repo);
  assert.equal(r.body.name.length, 100);
});

test('[CONOCIDO M4] proyecto: acepta duplicados y subcarpetas sin normalizar a la raíz del repo', async () => {
  const sub = path.join(repo, 'src');
  fs.mkdirSync(sub);
  const r = await srv.api('POST', '/api/projects', { path: sub });
  assert.equal(r.status, 201);
  assert.equal(r.body.path, sub); // no es el toplevel del repo
  const dup = await srv.api('POST', '/api/projects', { path: repo });
  assert.equal(dup.status, 201);
});

// ---------- Explorador de carpetas ----------

test('explorador: sin ruta lista HOME, ordenado, excluyendo symlinks', async () => {
  const r = await srv.api('GET', '/api/directories');
  assert.equal(r.status, 200);
  assert.equal(r.body.path, sb.home);
  assert.equal(r.body.parent, null);
  assert.equal(r.body.isGitRepository, false);
  const names = r.body.directories.map(d => d.name);
  assert.ok(names.includes('repo-a'));
  assert.ok(!names.includes('link-to-repo'));
  assert.ok(names.includes('.hidden'), '[CONOCIDO M8] lista carpetas ocultas');
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'es')));
});

test('explorador: detecta repositorio Git y expone la carpeta padre', async () => {
  const r = await srv.api('GET', '/api/directories?path=' + encodeURIComponent(repo));
  assert.equal(r.status, 200);
  assert.equal(r.body.isGitRepository, true);
  assert.equal(r.body.parent, sb.home);
});

test('explorador: rechaza rutas relativas, fuera de HOME, inexistentes y symlinks', async () => {
  const cases = [
    ['relativa', 'La ruta debe ser absoluta'],
    ['/', 'La ruta está fuera de los directorios permitidos'],
    [path.dirname(sb.home), 'La ruta está fuera de los directorios permitidos'],
    [path.join(sb.home, 'no-existe'), 'La carpeta ya no existe o no está disponible'],
    [path.join(sb.home, 'link-to-repo'), 'No se permite navegar mediante enlaces simbólicos'],
  ];
  for (const [p, error] of cases) {
    const r = await srv.api('GET', '/api/directories?path=' + encodeURIComponent(p));
    assert.equal(r.status, 400, p);
    assert.equal(r.body.error, error, p);
  }
});

// ---------- Historias de usuario ----------

test('HU: valida proyecto, título, prioridad, estado inicial y agentes', async () => {
  const cases = [
    [{ title: 'x' }, 'Selecciona un proyecto'],
    [{ projectId, title: '   ' }, 'Escribe un título'],
    [{ projectId, title: 'x', priority: 'urgent' }, 'Prioridad no válida'],
    [{ projectId, title: 'x', initialStatus: 'done' }, 'Estado inicial no válido'],
    [{ projectId, title: 'x', roles: { qa: 'gpt' } }, 'Asignación inválida'],
  ];
  for (const [payload, error] of cases) {
    const r = await srv.api('POST', '/api/hus', payload);
    assert.equal(r.status, 400, JSON.stringify(payload));
    assert.equal(r.body.error, error);
  }
});

test('HU: crea con valores por defecto y evento "created"', async () => {
  const r = await srv.api('POST', '/api/hus', { projectId, title: 't'.repeat(200), description: 'd', criteria: 'c' });
  assert.equal(r.status, 201);
  const hu = r.body;
  assert.equal(hu.title.length, 180);
  assert.deepEqual(hu.roles, { analysis: 'claude', implementation: 'codex', qa: 'antigravity' });
  assert.deepEqual(hu.models, { codex: 'gpt-6-luna' });
  assert.equal(hu.priority, 'medium');
  assert.equal(hu.status, 'draft');
  assert.equal(hu.approved, false);
  assert.equal(hu.plan, '');
  assert.deepEqual(hu.runs, []);
  assert.deepEqual(hu.events.map(e => e.type), ['created']);
});

test('HU: acepta campos extendidos, prioridad y estado inicial "blocked"', async () => {
  const r = await srv.api('POST', '/api/hus', {
    projectId, title: 'ext', priority: 'high', initialStatus: 'blocked',
    businessRules: 'BR', technicalConstraints: 'TC', observations: 'OB', roles: { analysis: 'codex' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'blocked');
  assert.equal(r.body.priority, 'high');
  assert.equal(r.body.roles.analysis, 'codex');
  assert.equal(r.body.roles.qa, 'antigravity');
  assert.deepEqual([r.body.businessRules, r.body.technicalConstraints, r.body.observations], ['BR', 'TC', 'OB']);
});

test('HU: PATCH actualiza campos, invalida aprobación y registra evento', async () => {
  const { body: hu } = await srv.api('POST', '/api/hus', { projectId, title: 'editar' });
  const r = await srv.api('PATCH', `/api/hus/${hu.id}`, { title: 'editada', priority: 'low', roles: { qa: 'claude' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.title, 'editada');
  assert.equal(r.body.priority, 'low');
  assert.equal(r.body.roles.qa, 'claude');
  assert.equal(r.body.roles.analysis, 'claude');
  assert.equal(r.body.approved, false);
  assert.deepEqual(r.body.events.map(e => e.type), ['created', 'updated']);
  assert.equal((await srv.api('PATCH', `/api/hus/${hu.id}`, { priority: 'x' })).body.error, 'Prioridad no válida');
  assert.equal((await srv.api('PATCH', `/api/hus/${hu.id}`, { roles: { qa: 'x' } })).body.error, 'Agente inválido');
});

test('HU inexistente responde 404', async () => {
  const r = await srv.api('PATCH', '/api/hus/no-existe', { title: 'x' });
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'HU no encontrada');
});

// ---------- Guardas del flujo (sin ejecutar agentes) ----------

test('flujo: rechaza transiciones fuera de orden', async () => {
  const { body: hu } = await srv.api('POST', '/api/hus', { projectId, title: 'guardas' });
  const cases = [
    ['approve', undefined, 'Primero completa el análisis'],
    ['manual', { message: 'x' }, 'Primero aprueba el plan'],
    ['close', undefined, 'Completa QA antes de cerrar'],
    ['cancel', undefined, 'No hay ejecución activa'],
    ['run', { phase: 'implementation' }, 'Etapa no disponible para ejecución automática'],
    ['run', { phase: 'deploy' }, 'Etapa no disponible para ejecución automática'],
    ['run', { phase: 'qa' }, 'Aprueba el plan antes de QA'],
  ];
  for (const [action, payload, error] of cases) {
    const r = await srv.api('POST', `/api/hus/${hu.id}/${action}`, payload);
    assert.equal(r.status, 400, action);
    assert.equal(r.body.error, error, action);
  }
  assert.equal(sb.calls().length, 0, 'ninguna guarda debe lanzar Headless');
});

test('estado: /api/state expone proyectos, HU con eventos/ejecuciones, agentes y fases', async () => {
  const r = await srv.api('GET', '/api/state');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(r.body.agents, ['claude', 'codex', 'antigravity']);
  assert.deepEqual(r.body.phases, ['analysis', 'implementation', 'qa']);
  assert.ok(r.body.hus.every(h => Array.isArray(h.events) && Array.isArray(h.runs)));
});

// Seguridad HTTP (C1): ver test/security.test.js
