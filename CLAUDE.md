# CLAUDE.md — HuTraceX

Este archivo tiene prioridad sobre `~/CLAUDE.md` (plantilla genérica: sus comandos `lint`,
`typecheck`, `build`, `storybook`, etc. **no existen** en este proyecto).

## Qué es
Aplicación **local** (un solo usuario, 127.0.0.1) para gestionar historias de usuario (HU),
asignar agentes de IA (Claude, Codex, Antigravity) por etapa y registrar la trazabilidad.
Los agentes se ejecutan mediante **Headless CLI** (`headless`, v0.6.1).

## Comandos
- `npm start` — servidor en http://127.0.0.1:3000 (`PORT`, `HOST`, `REPO_BROWSE_ROOTS`,
  `HUTRACEX_RUN_TIMEOUT_MS`, `HUTRACEX_KILL_GRACE_MS`). Una sola instancia por `data/` (`data/hutracex.lock`).
- `npm run dev` — igual, con `node --watch`.
- `npm test` — pruebas `node:test` (`test/*.test.js`). Sin dependencias.
- `npm run bench` — benchmark de persistencia con datos sintéticos (compara con `git HEAD:server.js`).
- No hay `npm install`: el proyecto usa solo módulos integrados de Node ≥ 20 (desarrollo en 22).

## Arquitectura actual (MVP)
| Archivo | Responsabilidad |
|---|---|
| `server.js` | Todo el backend: HTTP + rutas, validación, flujo de estados, persistencia JSON, explorador de carpetas, ejecución de agentes y prompts. |
| `public/app.js` | SPA sin framework: estado global, `fetch` a `/api`, consulta cada 3,5 s, render con `innerHTML` (todo texto pasa por `esc()`). |
| `public/index.html`, `public/style.css` | Esqueleto, diálogos y tema claro/oscuro. |
| `data/tracker.json` | Metadatos `{schemaVersion: 2, projects, hus, events, runs}`. **Ignorado por git.** |
| `data/runs/<id>.log` | Salida de cada ejecución (sobres NDJSON de Headless en stdout + stderr, en orden). Solo vía `GET /api/runs/:id/log`. |
| `data/runs/<id>.prompt.md` · `<id>.result.md` | Prompt enviado (0600, `run.prompt.sha256`) y resultado final validado (`run.result.sha256`). |
| `data/backups/` | Respaldos verificables (`.json` + `.sha256`): de arranque (10) y de migración. |
| `test/` | Pruebas de caracterización y `fixtures/fake-headless.js`. |
| `docs/known-issues.md` | Defectos conocidos priorizados. Léelo antes de cambiar el flujo. |

### API
Todas pasan por `guard()` (ver Reglas de seguridad). `GET /api/state` · `GET /api/directories?path=` · `POST /api/projects` · `POST /api/hus` ·
`PATCH /api/hus/:id` · `POST /api/hus/:id/{run|approve|manual|close|cancel}` ·
`GET /api/runs/:id/log?tail=<bytes>`. `/api/state` nunca incluye salidas de ejecuciones.

### Flujo de una HU
`draft|blocked` → `run analysis` → `analyzing` → `awaiting_approval` → `approve` → `approved`
→ `manual` → `implementation_done` → `run qa` → `qa` → `qa_done` → `close` → `done`.
Un fallo, cancelación, timeout o interrupción de la ejecución lleva a `blocked`.
Estados de ejecución: `running`, `completed`, `failed` (`endReason`: `exit_code`, `spawn_error`,
`timeout`, `log_write_error`, `agent_error`, `invalid_result`, `result_write_error`), `cancelled`,
`interrupted` (`server_restart`, `server_shutdown`).

### Prompts y resultados (Etapa 1.5)
- `buildPrompt()`: instrucciones del sistema + datos de la HU/proyecto en JSON entre marcas `HU-DATA-<nonce>`
  (nonce aleatorio por ejecución) + recordatorio final. **Nunca** interpolar texto del usuario fuera del bloque.
- Headless se invoca con `--prompt-file <data/runs/id.prompt.md> --sdk-format ndjson`. **Nunca** pasar el
  contenido del prompt en argv. claude/codex lo reciben por stdin; antigravity por argv (límite 120 KiB ⇒ error explícito).
- El plan es solo `data.finalMessage` del sobre `result` (`feedSdk()`/`resultProblem()`). stderr nunca se
  interpreta. Sin resultado, vacío, malformado, con sobre `error` o > 200 000 caracteres ⇒ `failed`, sin plan.

**Fuente única de reglas:** tabla `transitions` + `transitionError()` en `server.js`. Las rutas
llaman `assertTransition()`; el frontend solo lee `hu.allowedActions` (no dupliques reglas en
`public/app.js`). Para añadir o cambiar una transición, edita la tabla y su prueba en
`test/workflow.test.js`.

| Acción | Estados de origen | Aprobación vigente |
|---|---|---|
| `analysis` | cualquiera (reabre `done`); **invalida la aprobación** | no |
| `approve` | `awaiting_approval`, plan no vacío e igual (sha256) al `run.result` válido de `planRunId` | — |
| `manual`, `qa` | `approved`, `implementation_done`, `qa_done`, `blocked` | sí |
| `close` | `qa_done` | sí |

Aprobación vigente = `approved === true` y `approvalHash` = SHA-256(plan + campos de contenido).
Editar contenido invalida y vuelve a `awaiting_approval`; agentes y prioridad son administrativos.

## Reglas de seguridad (obligatorias)
- **Nunca** ejecutar agentes reales en pruebas. Las pruebas anteponen `test/fixtures` (vía
  `<sandbox>/bin/headless`) en `PATH`; no elimines esa guarda.
- Persistencia: escribir `tracker.json` solo con `save()` (atómico + fsync) y logs solo con `writeLog()`.
  Nunca volver a guardar salidas en `tracker.json` ni reemplazar una base dañada por una vacía; un
  cambio de esquema requiere `schemaVersion` nuevo, migración idempotente y respaldo previo.
- **Nunca** leer, escribir, borrar ni sobrescribir `data/` del repositorio. Las pruebas copian
  `server.js` y `public/` a un directorio temporal y usan su propio `data/` y `HOME`.
- **Nunca** habilitar `--allow yolo` ni `--dangerously-skip-permissions`. La implementación
  automática está deshabilitada a propósito hasta tener worktree aislado + permisos acotados.
- No ejecutar SQL, migraciones ni seeds sobre los repositorios gestionados.
- `spawn` siempre con argumentos en arreglo y `shell:false`.
- Ejecuciones: `detached:true` + `HUTRACEX_RUN_ID` en el entorno. **Solo** enviar señales vía
  `signalOwned()`/`terminateOwned()`, que verifican la marca en `/proc`. Nunca `process.kill` a un
  PID/pgid leído de `data/`. Toda finalización pasa por `finalizeRun()` (una sola vez por ejecución).
- Pruebas: `PATH` del servidor = simulado + `/usr/bin` + `/bin`; el Headless real (nvm) no es alcanzable.
- Todo HTML generado en el frontend debe pasar por `esc()`.
- El servidor solo escucha en loopback (`HOST` no loopback ⇒ no arranca). `guard()` en `server.js`
  valida Host, Origin, Sec-Fetch-Site y exige `application/json` en escrituras de `/api`. No añadir
  cabeceras CORS ni relajar `guard()`; cualquier cliente nuevo debe enviar `content-type: application/json`.

## Convenciones
- ES modules, Node integrado, **sin dependencias** salvo justificación explícita.
- Formato: `.prettierrc.json` / `.editorconfig` (2 espacios, comillas simples, coma final, 100 col).
  `server.js` y `public/` están excluidos en `.prettierignore` hasta el commit de formato de la Etapa 2;
  no los reformatees mezclado con cambios funcionales.
- Pruebas `[CONOCIDO …]` fijan defectos actuales: al corregir uno, actualiza su prueba a propósito.
- Futuro TypeScript con type stripping de Node: evitar `enum`, `namespace` y propiedades de parámetro.

## Antes de terminar un cambio
1. `npm test` en verde.
2. Si cambia el flujo o la API, actualizar este archivo, `README.md` y `docs/known-issues.md`.
