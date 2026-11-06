// Simulador de Headless CLI 0.6.1 para pruebas. Nunca invoca agentes reales.
// Lee el prompt de --prompt-file (o --prompt) y, con --sdk-format ndjson, emula el protocolo de Headless:
// cada línea de stdout del agente → {"type":"trace"}; al salir, {"type":"result","data":{finalMessage}} si hubo
// texto, o {"type":"error"} si no. stderr se escribe tal cual (Headless no lo envuelve).
// El comportamiento se elige con marcas en el prompt (el título de la HU viaja en él):
//   [slow]          -> no termina hasta 20 s (ejecución activa, cancelación, reinicio)
//   [fail]          -> escribe en stderr y sale con código 3
//   [empty]         -> no imprime nada y sale con 0
//   [stubborn]      -> ignora SIGTERM (solo muere con SIGKILL)
//   [tree]          -> lanza un hijo en su grupo (retiene stdout) y otro que escapa con setsid
//   [tree-stubborn] -> como [tree], pero ambos descendientes ignoran SIGTERM
//   [orphan]        -> deja un descendiente fuera del grupo y termina con éxito
//   [linger]        -> deja un hijo que retiene stdout y termina con éxito
//   [tree-noenv]    -> hijo en el grupo que BORRA su entorno (sin marca) y retiene stdout
//   [linger-noenv]  -> como [linger], pero el hijo no tiene marca (no verificable)
//   [term-exit0]    -> ante SIGTERM imprime un plan y sale con 0 (carrera cancelación/salida)
//   [chunks]        -> 10 pares stdout/stderr intercalados (o0, e0, o1, e1…) en fragmentos separados
//   [drip]          -> 20 líneas "pid:<pid> línea i" cada 50 ms (escritura incremental, concurrencia)
//   [big:N]         -> N bytes en fragmentos de 4 KB
//   [utf8split]     -> texto multibyte cortado a mitad de carácter entre dos escrituras
//   [stderr-noise]  -> escribe ruido en stderr además del plan (no debe llegar al plan)
//   [malformed]     -> escribe una línea que no es JSON en stdout y sale con 0
//   [no-result]     -> solo trazas, sin sobre de resultado (flujo truncado), sale con 0
//   [cut-line]      -> el sobre de resultado queda cortado a la mitad (sin salto de línea), sale con 0
//   [blank-result]  -> resultado con finalMessage vacío
//   [agent-error]   -> sobre de error de Headless, sale con 0
//   [huge-result]   -> resultado de 250 000 caracteres
//   (sin marca)     -> imprime una respuesta simulada y sale con 0
// Interruptores por archivo (sb.setSlow()/sb.setFail()): "<FAKE_HEADLESS_LOG>.slow" y ".fail".
// Todo proceso de larga duración se autodestruye a los 60 s como red de seguridad.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

import { StringDecoder } from 'node:string_decoder';

const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const prompt = opt('--prompt-file') !== undefined ? fs.readFileSync(opt('--prompt-file'), 'utf8') : opt('--prompt') ?? '';
const logFile = process.env.FAKE_HEADLESS_LOG;
const log = entry => { if (logFile) fs.appendFileSync(logFile, JSON.stringify(entry) + '\n'); };
const flag = name => Boolean(logFile) && fs.existsSync(`${logFile}.${name}`);
const has = mark => prompt.includes(`[${mark}]`);
const stayAlive = (ms = 60000) => setTimeout(() => process.exit(0), ms);

log({ argv, prompt, cwd: process.cwd(), pid: process.pid });

const raw = process.stdout.write.bind(process.stdout);
const envelope = e => raw(JSON.stringify({ protocolVersion: 1, ...e }) + '\n');
if (opt('--sdk-format') === 'ndjson') {
  const agent = argv[0];
  const decoder = new StringDecoder('utf8');
  let text = '', pending = '';
  process.stdout.write = (chunk, encoding, cb) => {
    if (typeof encoding === 'function') cb = encoding;
    const s = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    text += s; pending += s;
    const lines = pending.split('\n'); pending = lines.pop();
    for (const line of lines) if (line.trim()) envelope({ type: 'trace', command: 'invoke', data: { agent, raw: line } });
    if (cb) setImmediate(cb);
    return true;
  };
  let done = false;
  const finish = code => {
    if (done) return; done = true;
    if (pending.trim()) envelope({ type: 'trace', command: 'invoke', data: { agent, raw: pending } });
    const finalMessage = text.trim();
    if (finalMessage) return envelope({ type: 'result', command: 'invoke', exitCode: code, data: { agent, finalMessage } });
    process.exitCode = code || 1;
    return envelope({ type: 'error', command: 'invoke', exitCode: code || 1, error: { message: `agent exited with code ${code || 1}` } });
  };
  // Salida natural: se espera a que el pipe drene (como Headless). process.exit(): mejor esfuerzo síncrono.
  process.on('beforeExit', finish);
  process.on('exit', finish);
}

function descendant(role, { escape = false, stubborn = false, noenv = false } = {}) {
  const code = `${stubborn ? "process.on('SIGTERM',()=>{});" : ''}setTimeout(()=>{},60000)`;
  const opts = escape ? { detached: true, stdio: 'ignore' } : { stdio: 'inherit' };
  if (noenv) opts.env = {};
  const c = spawn(process.execPath, ['-e', code], opts);
  if (escape) c.unref();
  log({ pid: c.pid, role, parent: process.pid });
}

if (has('stubborn')) {
  process.on('SIGTERM', () => {});
  stayAlive();
} else if (has('tree') || has('tree-stubborn')) {
  const stubborn = has('tree-stubborn');
  descendant('child', { stubborn });
  descendant('escaped', { escape: true, stubborn });
  stayAlive(20000);
} else if (has('tree-noenv')) {
  descendant('child-noenv', { noenv: true });
  stayAlive(20000);
} else if (has('linger-noenv')) {
  descendant('child-noenv', { noenv: true });
  process.stdout.write('PLAN simulado OK\n');
  process.exit(0);
} else if (has('orphan')) {
  descendant('escaped', { escape: true });
  process.stdout.write('PLAN simulado OK\n');
} else if (has('linger')) {
  descendant('child');
  process.stdout.write('PLAN simulado OK\n');
  process.exit(0);
} else if (has('term-exit0')) {
  process.on('SIGTERM', () => { process.stdout.write('PLAN tardío\n'); process.exit(0); });
  stayAlive(20000);
} else if (has('chunks')) {
  let n = 0;
  const step = () => { if (n === 10) return; process.stdout.write(`o${n}\n`); setTimeout(() => { process.stderr.write(`e${n}\n`); n++; setTimeout(step, 15); }, 15); };
  step();
} else if (has('drip')) {
  let n = 0;
  const t = setInterval(() => { process.stdout.write(`pid:${process.pid} línea ${n}\n`); if (++n === 20) { clearInterval(t); } }, 50);
} else if (/\[big:\d+\]/.test(prompt)) {
  let left = Number(prompt.match(/\[big:(\d+)\]/)[1]);
  const step = () => { if (left <= 0) return; const n = Math.min(4096, left); left -= n; process.stdout.write('x'.repeat(n - 1) + '\n', step); };
  step();
} else if (has('utf8split')) {
  const b = Buffer.from('Información: ñandú, café, €, 😀 fin\n', 'utf8');
  const cut = b.indexOf(Buffer.from('😀')) + 2; // a mitad del emoji (4 bytes)
  process.stdout.write(b.subarray(0, cut), () => setTimeout(() => process.stdout.write(b.subarray(cut)), 60));
} else if (has('stderr-noise')) {
  process.stderr.write('STDERR-NOISE: advertencia\n');
  process.stdout.write('PLAN simulado OK\n');
} else if (has('malformed')) {
  raw('esto no es JSON\n');
  process.stdout.write('PLAN simulado OK\n');
} else if (has('no-result')) {
  envelope({ type: 'trace', command: 'invoke', data: { agent: argv[0], raw: 'PLAN parcial' } });
  process.reallyExit(0); // sin pasar por el manejador 'exit': no hay resultado
} else if (has('cut-line')) {
  raw(JSON.stringify({ protocolVersion: 1, type: 'result', command: 'invoke', exitCode: 0, data: { finalMessage: 'PLAN incompleto' } }).slice(0, 40));
  process.reallyExit(0);
} else if (has('blank-result')) {
  envelope({ type: 'result', command: 'invoke', exitCode: 0, data: { finalMessage: '  \n ' } });
  process.reallyExit(0);
} else if (has('agent-error')) {
  envelope({ type: 'error', command: 'invoke', exitCode: 0, error: { message: 'cuota agotada' } });
  process.reallyExit(0);
} else if (has('huge-result')) {
  process.stdout.write('y'.repeat(250000) + '\n');
} else if (has('slow') || flag('slow')) {
  stayAlive(20000);
} else if (has('fail') || flag('fail')) {
  process.stderr.write('fake failure\n');
  process.exit(3);
} else if (has('empty')) {
  process.exit(0);
} else {
  process.stdout.write(prompt.includes('Fase: qa') ? 'QA simulado OK\n' : 'PLAN simulado OK\n');
}
