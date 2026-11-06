// Edición segura en el frontend (Etapa 1.5: M6), en un Chrome headless real vía DevTools Protocol.
// Sin dependencias (WebSocket integrado de Node ≥ 22). Se omite si no hay Chrome/Chromium o Node < 22.
// Perfil de Chrome y HOME aislados en el sandbox; los diálogos (confirm) se sustituyen para no bloquear.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeSandbox, makeRepo, startServer, waitFor, waitHuStatus } from './helpers.js';

const chrome = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => p && fs.existsSync(p));
const skip = !chrome ? 'Chrome/Chromium no disponible' : typeof WebSocket !== 'function' ? 'requiere WebSocket global (Node ≥ 22)' : false;

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

async function launch(sb, url) {
  const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${path.join(sb.dir, 'chrome')}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--window-size=1280,900', url], { env: { ...process.env, HOME: sb.home }, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  cleanups.push(() => { try { process.kill(-proc.pid, 'SIGKILL'); } catch {} });
  let err = '';
  const port = await new Promise((resolve, reject) => {
    proc.stderr.on('data', d => { err += d; const m = err.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//); if (m) resolve(m[1]); });
    proc.on('exit', c => reject(new Error(`Chrome terminó (${c}): ${err}`)));
  });
  const page = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page' && t.url.startsWith(url)));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = m => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); pending.delete(d.id); };
  const send = (method, params = {}) => new Promise(resolve => { pending.set(++id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  cleanups.push(() => ws.close());
  return async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.error || r.result.exceptionDetails) throw new Error(JSON.stringify(r.error || r.result.exceptionDetails));
    return r.result.result.value;
  };
}

test('M6: la consulta periódica conserva asignaciones sin guardar, paneles, scroll y formularios', { skip, timeout: 120000 }, async () => {
  const sb = makeSandbox();
  cleanups.push(() => sb.cleanup());
  const repo = makeRepo(sb, 'repo');
  const srv = await startServer(sb);
  cleanups.push(() => srv.stop());
  const projectId = (await srv.api('POST', '/api/projects', { path: repo })).body.id;
  const other = (await srv.api('POST', '/api/hus', { projectId, title: 'Otra HU' })).body;
  const hu = (await srv.api('POST', '/api/hus', { projectId, title: 'Edición [big:60000]' })).body;
  await srv.api('POST', `/api/hus/${hu.id}/run`, { phase: 'analysis' });
  await waitHuStatus(srv, hu.id, 'awaiting_approval');
  await srv.api('POST', `/api/hus/${hu.id}/run`, { phase: 'analysis' }); // segunda ejecución: dos paneles
  await waitHuStatus(srv, hu.id, 'awaiting_approval');

  const js = await launch(sb, `http://127.0.0.1:${srv.port}/`);
  const until = async (expr, timeout = 15000) => {
    try { return await waitFor(async () => (await js(expr)) || false, { timeout, interval: 100 }); } catch (e) {
      const page = await js(`JSON.stringify({ h1: document.querySelector('h1')?.textContent, details: document.querySelectorAll('details[data-run]').length, logs: [...document.querySelectorAll('pre.output')].map(p => p.textContent.length) })`);
      throw new Error(`${e.message}: ${expr}\npágina: ${page}`);
    }
  };
  // Seleccionar la HU y esperar a que el log esté cargado.
  await until(`document.querySelector('[data-hu="${hu.id}"]')`);
  await js(`document.querySelector('[data-hu="${hu.id}"]').click()`);
  await until(`document.querySelectorAll('details[data-run]').length === 2 && document.querySelector('pre.output').textContent.length > 20000`);
  assert.ok(!(await js(`document.querySelector('pre.output').textContent.includes('"protocolVersion"')`)), 'el log se muestra legible, sin sobres NDJSON');

  // Cambios locales sin guardar: agente de análisis, panel abierto/cerrado y scroll del log.
  await js(`(() => { const s = document.querySelector('[data-role="analysis"]'); s.value = 'codex'; s.dispatchEvent(new Event('change', { bubbles: true })); s.focus(); })()`);
  await js(`(() => { const d = document.querySelectorAll('details[data-run]'); d[0].open = false; d[1].open = true; })()`);
  await until(`!document.querySelectorAll('details[data-run]')[0].open`); // el evento toggle es asíncrono
  await js(`(() => { const p = document.querySelectorAll('pre.output')[1]; p.scrollTop = 777; p.dispatchEvent(new Event('scroll')); })()`);
  await js(`window.__marker = document.querySelector('[data-role="analysis"]')`); // para detectar el re-render

  // Cambio en el servidor ⇒ la consulta periódica re-renderiza el detalle.
  await srv.api('PATCH', `/api/hus/${hu.id}`, { priority: 'high' });
  await until(`document.querySelector('.priority-high') && document.querySelector('[data-role="analysis"]') !== window.__marker`, 10000);
  assert.equal(await js(`document.querySelector('[data-role="analysis"]').value`), 'codex', 'asignación sin guardar conservada');
  assert.equal(await js(`document.activeElement?.dataset?.role`), 'analysis', 'foco conservado');
  assert.deepEqual(await js(`[...document.querySelectorAll('details[data-run]')].map(d => d.open)`), [false, true], 'paneles conservados');
  assert.equal(await js(`document.querySelectorAll('pre.output')[1].scrollTop`), 777, 'scroll del log conservado');

  // Sin cambios en el servidor no se re-renderiza (no se reemplaza el DOM).
  await js(`window.__marker = document.querySelector('[data-role="analysis"]')`);
  await new Promise(r => setTimeout(r, 4200));
  assert.ok(await js(`document.querySelector('[data-role="analysis"]') === window.__marker`));

  // Abandonar con cambios pendientes: advertencia (confirm sustituido) y beforeunload.
  assert.equal(await js(`(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })()`), true);
  await js(`window.confirm = () => (window.__asked = (window.__asked || 0) + 1, false)`);
  await js(`document.querySelector('[data-hu="${other.id}"]').click()`);
  assert.equal(await js('window.__asked'), 1);
  assert.equal(await js(`document.querySelector('h1').textContent`), 'Edición [big:60000]', 'cancelar mantiene la HU');
  assert.equal(await js(`document.querySelector('[data-role="analysis"]').value`), 'codex');
  // Guardar las asignaciones limpia el estado pendiente.
  await js(`document.getElementById('saveRoles').click()`);
  await waitFor(async () => (await srv.api('GET', '/api/state')).body.hus.find(h => h.id === hu.id).roles.analysis === 'codex');
  await until(`(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return !e.defaultPrevented; })()`);
  await js(`document.querySelector('[data-hu="${other.id}"]').click()`);
  assert.equal(await js('window.__asked'), 1, 'sin cambios pendientes no se pregunta');
  assert.equal(await js(`document.querySelector('h1').textContent`), 'Otra HU');

  // Formulario de edición: los campos escritos sobreviven a cambios del servidor durante la edición.
  await js(`document.getElementById('editHu').click()`);
  await until(`document.querySelector('#huEditorForm textarea[name="description"]')`);
  await js(`(() => { const f = document.getElementById('huEditorForm'); f.description.value = 'Texto sin guardar ñ 😀'; f.priority.value = 'low'; f.description.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await srv.api('PATCH', `/api/hus/${other.id}`, { priority: 'high' });
  await srv.api('POST', '/api/hus', { projectId, title: 'Creada durante la edición' });
  await new Promise(r => setTimeout(r, 4500));
  assert.equal(await js(`document.getElementById('huEditorForm').description.value`), 'Texto sin guardar ñ 😀');
  assert.equal(await js(`document.getElementById('huEditorForm').priority.value`), 'low');
  assert.equal(await js(`(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })()`), true);
});
