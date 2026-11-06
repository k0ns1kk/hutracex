// Seguridad HTTP (C1): Host, Origin, Fetch Metadata, Content-Type, CORS y bind a loopback.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { makeSandbox, makeRepo, startServer, runServerExpectExit, waitHuStatus } from './helpers.js';

let sb, srv, repo, port, huId;
const json = { 'content-type': 'application/json' };

before(async () => {
  sb = makeSandbox();
  repo = makeRepo(sb, 'repo');
  srv = await startServer(sb);
  port = srv.port;
  const projectId = (await srv.api('POST', '/api/projects', { path: repo })).body.id;
  huId = (await srv.api('POST', '/api/hus', { projectId, title: 'Objetivo' })).body.id;
});
after(async () => { await srv?.stop(); sb?.cleanup(); });

const projectCount = async () => (await srv.api('GET', '/api/state')).body.projects.length;
const postProject = (headers, body = JSON.stringify({ path: repo })) =>
  srv.raw({ method: 'POST', path: '/api/projects', headers, body });
const noCorsHeaders = r => Object.keys(r.headers).filter(h => h.startsWith('access-control-'));

// ---------- Host ----------

test('Host válido: 127.0.0.1, localhost e [::1] con el puerto configurado (sin distinguir mayúsculas)', async () => {
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `LOCALHOST:${port}`]) {
    assert.equal((await srv.raw({ path: '/api/state', headers: { host } })).status, 200, host);
    assert.equal((await srv.raw({ path: '/', headers: { host } })).status, 200, host);
  }
});

test('Host inválido o manipulado: 403 en API y estáticos, sin datos en la respuesta', async () => {
  const hosts = [
    'evil.example', `evil.example:${port}`, `127.0.0.1:${port + 1}`, `localhost:${port + 1}`,
    '127.0.0.1', 'localhost', `127.0.0.1.nip.io:${port}`, `localhost.evil.example:${port}`,
    `127.0.0.2:${port}`, `0.0.0.0:${port}`, `[::ffff:127.0.0.1]:${port}`, `127.0.0.1:${port}@evil.example`,
  ];
  for (const host of hosts) {
    for (const p of ['/api/state', '/', '/app.js', '/api/directories']) {
      const r = await srv.raw({ path: p, headers: { host } });
      assert.equal(r.status, 403, `${host} ${p}`);
      assert.deepEqual(r.body, { error: 'Host no permitido' });
    }
  }
});

// El cliente http de Node rellena Host automáticamente; para Host vacío/ausente se usa un socket crudo.
function rawSocket(request) {
  return new Promise((resolve, reject) => {
    let data = '';
    const sock = net.connect(port, '127.0.0.1', () => sock.end(request));
    sock.setEncoding('utf8');
    sock.on('data', c => { data += c; });
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
  });
}

test('Host vacío o ausente: rechazado', async () => {
  // HTTP/1.1 sin Host: Node responde 400 antes de llegar al handler.
  assert.match(await rawSocket('GET /api/state HTTP/1.1\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 400/);
  // HTTP/1.0 permite omitir Host y Host vacío llega al handler: ambos los rechaza el guard.
  for (const req of ['GET /api/state HTTP/1.0\r\n\r\n', 'GET /api/state HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n']) {
    const res = await rawSocket(req);
    assert.match(res, /^HTTP\/1\.[01] 403/, JSON.stringify(req));
    assert.ok(res.includes('Host no permitido'));
    assert.ok(!res.includes('"projects"'));
  }
});

test('Host manipulado en POST: rechazado sin efectos', async () => {
  const before = await projectCount();
  const r = await postProject({ ...json, host: 'evil.example' });
  assert.equal(r.status, 403);
  assert.equal(await projectCount(), before);
});

// ---------- Origin ----------

test('GET: sin Origin se acepta; con Origin propio se acepta; con Origin externo se rechaza', async () => {
  assert.equal((await srv.raw({ path: '/api/state' })).status, 200);
  assert.equal((await srv.raw({ path: '/api/state', headers: { origin: `http://localhost:${port}` } })).status, 200);
  const r = await srv.raw({ path: '/api/state', headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, { error: 'Origen no permitido' });
});

test('POST con Origin propio (las tres variantes de loopback) se acepta', async () => {
  for (const origin of [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]) {
    assert.equal((await postProject({ ...json, origin })).status, 201, origin);
  }
});

test('POST con Origin externo, "null", otro puerto u otro esquema: 403 sin efectos', async () => {
  const origins = [
    'https://evil.example', 'null', `http://localhost:${port + 1}`, `https://localhost:${port}`,
    `http://127.0.0.1:${port}.evil.example`, 'http://localhost', `http://127.0.0.1:${port}/`,
  ];
  const before = await projectCount();
  for (const origin of origins) {
    const r = await postProject({ ...json, origin });
    assert.equal(r.status, 403, origin);
    assert.deepEqual(r.body, { error: 'Origen no permitido' });
  }
  assert.equal(await projectCount(), before);
});

test('POST sin Origin (clientes locales no-navegador, p. ej. curl) se acepta con JSON', async () => {
  assert.equal((await postProject(json)).status, 201);
});

test('Fetch Metadata: cross-site y same-site se rechazan en la API; same-origin y none se aceptan', async () => {
  for (const site of ['cross-site', 'same-site']) {
    assert.equal((await postProject({ ...json, 'sec-fetch-site': site })).status, 403, site);
    assert.equal((await srv.raw({ path: '/api/state', headers: { 'sec-fetch-site': site } })).status, 403, site);
  }
  assert.equal((await postProject({ ...json, 'sec-fetch-site': 'same-origin' })).status, 201);
  assert.equal((await srv.raw({ path: '/api/state', headers: { 'sec-fetch-site': 'none' } })).status, 200);
});

test('navegación a la interfaz desde otro sitio (enlace) sigue funcionando', async () => {
  const r = await srv.raw({ path: '/', headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
});

test('petición tal como la envía el frontend (POST same-origin) se acepta', async () => {
  const r = await postProject({ ...json, origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' });
  assert.equal(r.status, 201);
});

// ---------- Content-Type ----------

test('Content-Type: application/json (con parámetros o mayúsculas) se acepta', async () => {
  for (const type of ['application/json', 'application/json; charset=utf-8', 'APPLICATION/JSON', ' application/json ;charset=UTF-8']) {
    assert.equal((await postProject({ 'content-type': type })).status, 201, type);
  }
});

test('Content-Type ausente o distinto de JSON: 415 sin efectos (bloquea peticiones simples sin preflight)', async () => {
  const types = [undefined, 'text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonx', 'application/json-patch+json', 'text/json'];
  const before = await projectCount();
  for (const type of types) {
    const r = await postProject(type === undefined ? {} : { 'content-type': type });
    assert.equal(r.status, 415, String(type));
    assert.deepEqual(r.body, { error: 'Content-Type debe ser application/json' });
  }
  assert.equal(await projectCount(), before);
});

test('PATCH y acciones sin cuerpo (approve, cancel, close) también exigen JSON', async () => {
  assert.equal((await srv.raw({ method: 'PATCH', path: `/api/hus/${huId}`, headers: { 'content-type': 'text/plain' }, body: '{"title":"x"}' })).status, 415);
  for (const action of ['approve', 'cancel', 'close']) {
    assert.equal((await srv.raw({ method: 'POST', path: `/api/hus/${huId}/${action}` })).status, 415, action);
    // Con el encabezado correcto llega a la lógica de negocio de siempre.
    assert.equal((await srv.raw({ method: 'POST', path: `/api/hus/${huId}/${action}`, headers: json })).status, 400, action);
  }
});

test('GET no exige Content-Type', async () => {
  assert.equal((await srv.raw({ path: '/api/state', headers: { 'content-type': 'text/plain' } })).status, 200);
});

// ---------- Ejecución de agentes ----------

test('iniciar una ejecución desde un origen externo o como text/plain no lanza Headless', async () => {
  const body = JSON.stringify({ phase: 'analysis' });
  const attempts = [
    { headers: { ...json, origin: 'https://evil.example' }, status: 403 },
    { headers: { 'content-type': 'text/plain' }, status: 415 },
    { headers: { ...json, host: `evil.example:${port}` }, status: 403 },
    { headers: { ...json, 'sec-fetch-site': 'cross-site' }, status: 403 },
  ];
  for (const { headers, status } of attempts) {
    assert.equal((await srv.raw({ method: 'POST', path: `/api/hus/${huId}/run`, headers, body })).status, status);
  }
  assert.equal(sb.calls().length, 0);
  const ok = await srv.raw({ method: 'POST', path: `/api/hus/${huId}/run`, headers: { ...json, origin: `http://localhost:${port}` }, body });
  assert.equal(ok.status, 202);
  await waitHuStatus(srv, huId, 'awaiting_approval');
  assert.equal(sb.calls().length, 1);
});

// ---------- CORS ----------

test('sin CORS permisivo: preflight y respuestas no incluyen Access-Control-*', async () => {
  const preflight = { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' };
  const r1 = await srv.raw({ method: 'OPTIONS', path: '/api/projects', headers: preflight });
  assert.equal(r1.status, 403);
  assert.deepEqual(noCorsHeaders(r1), []);
  const r2 = await srv.raw({ method: 'OPTIONS', path: '/api/projects', headers: { ...preflight, origin: `http://localhost:${port}` } });
  assert.deepEqual(noCorsHeaders(r2), []);
  for (const p of ['/', '/api/state']) assert.deepEqual(noCorsHeaders(await srv.raw({ path: p })), [], p);
});

test('encabezados de seguridad en estáticos y API (nosniff, anti-clickjacking)', async () => {
  for (const p of ['/', '/app.js', '/api/state', '/no-existe']) {
    const r = await srv.raw({ path: p });
    assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
    assert.equal(r.headers['x-frame-options'], 'DENY', p);
    assert.equal(r.headers['content-security-policy'], "frame-ancestors 'none'", p);
  }
});

// ---------- Bind ----------

test('HOST no loopback se rechaza al arrancar (no hay autenticación)', async () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.com', '127.0.0.1 ']) {
    const r = await runServerExpectExit(sb, { HOST: host });
    assert.equal(r.code, 1, host);
    assert.match(r.stderr, /rechazado/, host);
    assert.doesNotMatch(r.stdout, /HU Tracker:/, host);
  }
});

test('HOST=localhost y HOST=::1 arrancan y aceptan su Host con el puerto configurado', async () => {
  // Sandboxes propios: un mismo data/ solo admite una instancia (Etapa 1.3).
  const sbLocal = makeSandbox(), sbV6 = makeSandbox();
  after(() => { sbLocal.cleanup(); sbV6.cleanup(); });
  const local = await startServer(sbLocal, { HOST: 'localhost' });
  try {
    assert.equal((await local.raw({ path: '/api/state', connectHost: 'localhost', headers: { host: `localhost:${local.port}` } })).status, 200);
    assert.equal((await local.raw({ path: '/api/state', connectHost: 'localhost', headers: { host: `localhost:${port}` } })).status, local.port === port ? 200 : 403);
  } finally { await local.stop(); }
  const v6 = await startServer(sbV6, { HOST: '::1' });
  try {
    assert.equal((await v6.raw({ path: '/api/state', connectHost: '::1', headers: { host: `[::1]:${v6.port}` } })).status, 200);
    assert.equal((await v6.raw({ path: '/api/state', connectHost: '::1', headers: { host: 'evil.example' } })).status, 403);
  } finally { await v6.stop(); }
});
