// Benchmark de persistencia (Etapa 1.4) con datos sintéticos y Headless simulado. No usa data/ real.
// Compara el server.js del commit inicial (git HEAD: salida embebida, guardado por fragmento) con el actual.
// Uso: npm run bench   (opcional: BENCH_RUNS=300 BENCH_RUN_KB=50 BENCH_OUTPUT_KB=500)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox, makeRepo, startServer, waitFor } from '../helpers.js';

const RUNS = Number(process.env.BENCH_RUNS || 300);
const RUN_KB = Number(process.env.BENCH_RUN_KB || 50);
const OUTPUT_KB = Number(process.env.BENCH_OUTPUT_KB || 500);
const t0 = '2026-11-01T00:00:00.000Z';

function syntheticDb(repo) {
  const out = 'x'.repeat(RUN_KB * 1024);
  const roles = { analysis: 'claude', implementation: 'codex', qa: 'antigravity' };
  return {
    projects: [{ id: 'p1', name: 'repo', path: repo, createdAt: t0 }],
    hus: [{ id: 'h1', projectId: 'p1', title: 'Histórica', description: '', criteria: '', roles, status: 'done', approved: false, plan: '', createdAt: t0, updatedAt: t0 }],
    events: [],
    runs: Array.from({ length: RUNS }, (_, i) => ({ id: `r${i}`, huId: 'h1', phase: 'analysis', agent: 'claude', status: 'completed', startedAt: t0, endedAt: t0, exitCode: 0, output: out })),
  };
}

async function measure(label, prepare) {
  const sb = makeSandbox();
  try {
    prepare(sb);
    const repo = makeRepo(sb, 'repo');
    sb.writeDb(syntheticDb(repo));
    const trackerBefore = fs.statSync(path.join(sb.app, 'data', 'tracker.json')).size;
    let t = performance.now();
    const srv = await startServer(sb);
    const startupMs = performance.now() - t;
    try {
      const lat = [];
      let stateBytes = 0;
      for (let i = 0; i < 10; i++) {
        t = performance.now();
        const r = await srv.api('GET', '/api/state');
        lat.push(performance.now() - t);
        stateBytes = r.text.length;
      }
      const projectId = (await srv.api('POST', '/api/projects', { path: repo })).body.id;
      const hu = (await srv.api('POST', '/api/hus', { projectId, title: `Bench [big:${OUTPUT_KB * 1024}]` })).body;
      // Latencia de /api/state mientras el agente produce salida (bloqueo del event loop por guardado).
      const busy = [];
      t = performance.now();
      await srv.api('POST', `/api/hus/${hu.id}/run`, { phase: 'analysis' });
      const runDone = waitFor(async () => {
        const s0 = performance.now();
        const st = (await srv.api('GET', '/api/state')).body;
        busy.push(performance.now() - s0);
        return st.hus.find(h => h.id === hu.id).status === 'awaiting_approval';
      }, { timeout: 600000, interval: 100 });
      await runDone;
      const runMs = performance.now() - t;
      const trackerAfter = fs.statSync(path.join(sb.app, 'data', 'tracker.json')).size;
      const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
      return { label, trackerBefore, trackerAfter, startupMs, stateBytes, stateMs: median(lat), runMs, chunks: Math.ceil((OUTPUT_KB * 1024) / 4096), busyMax: Math.max(...busy), busyMedian: median(busy) };
    } finally { await srv.stop(); }
  } finally { sb.cleanup(); }
}

const head = execFileSync('git', ['show', 'HEAD:server.js'], { encoding: 'utf8' });
const results = [
  await measure('antes (HEAD)', sb => fs.writeFileSync(path.join(sb.app, 'server.js'), head)),
  await measure('ahora (1.4)', () => {}),
];
const mb = b => `${(b / 1048576).toFixed(2)} MB`;
const ms = v => `${v.toFixed(1)} ms`;
console.log(`\nDatos: ${RUNS} ejecuciones históricas × ${RUN_KB} KB; nueva ejecución de ${OUTPUT_KB} KB en fragmentos de 4 KB\n`);
const rows = [
  ['tracker.json al iniciar', r => mb(r.trackerBefore)],
  ['tracker.json tras la ejecución', r => mb(r.trackerAfter)],
  ['arranque (incluye migración)', r => ms(r.startupMs)],
  ['/api/state: tamaño', r => mb(r.stateBytes)],
  ['/api/state: latencia mediana', r => ms(r.stateMs)],
  ['ejecución nueva: duración total', r => ms(r.runMs)],
  ['/api/state durante la ejecución: mediana', r => ms(r.busyMedian)],
  ['/api/state durante la ejecución: máximo', r => ms(r.busyMax)],
];
const w = Math.max(...rows.map(([n]) => n.length));
console.log(`${''.padEnd(w)}  ${results.map(r => r.label.padStart(14)).join('  ')}`);
for (const [name, f] of rows) console.log(`${name.padEnd(w)}  ${results.map(r => f(r).padStart(14)).join('  ')}`);
