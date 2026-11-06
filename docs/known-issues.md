# Problemas conocidos — pendientes para la Etapa 1

Detectados en la auditoría técnica (2026-11-06). Los marcados con 🧪 están fijados por una
prueba `[CONOCIDO …]` en `test/`: al corregirlos, **actualiza la prueba a propósito** para que
afirme el comportamiento nuevo.

## 🔴 Crítico

### ✅ C1 — Sin verificación de Host/Origin (DNS rebinding / CSRF) — **corregido en Etapa 1.1**
`guard()` en `server.js`, antes de cualquier ruta (estáticos incluidos):
- `Host` exacto: `127.0.0.1|localhost|[::1]:<puerto real>` (sin puerto solo si es 80) → si no, 403.
- `Origin`, si viene, debe ser `http://` + uno de esos hosts (incluye rechazo de `null`) → si no, 403.
- En `/api/*`: `Sec-Fetch-Site` distinto de `same-origin`/`none` → 403 (bloquea otros puertos de localhost).
- En `/api/*`, `POST|PUT|PATCH|DELETE` exigen `Content-Type: application/json` → si no, 415.
- Sin cabeceras CORS; cabeceras `nosniff`, `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `no-referrer`.
- `HOST` distinto de `127.0.0.1|localhost|::1` ⇒ el servidor no arranca (exit 1).
Pruebas: `test/security.test.js`.

**Riesgo residual:** cualquier proceso local del mismo usuario (o de otro usuario de la máquina)
puede llamar a la API sin Origin; no hay autenticación. Exponer HuTraceX fuera de loopback requiere
autenticación real (no implementada a propósito).

## 🟠 Alto

### ✅ A1 — Aprobación obsoleta — **corregido en Etapa 1.2**
Al iniciar un análisis se invalida la aprobación (`approval_invalidated`, `reason: new_analysis`).
La aprobación queda ligada a `approvalHash` = SHA-256 de plan + campos de contenido: un plan o
contenido distinto nunca reutiliza una aprobación anterior. Pruebas: `test/workflow.test.js`.

### ✅ A2 — Edición de HU aprobada bloqueada — **corregido en Etapa 1.2**
Cambios de **contenido** (título, descripción, criterios, reglas, restricciones, observaciones)
invalidan la aprobación y llevan la HU a `awaiting_approval` (o `draft` si no hay plan): se puede
aprobar de nuevo o re-analizar. Cambios **administrativos** (agentes, prioridad) no invalidan.
Un PATCH sin cambios reales no registra eventos. Al arrancar, `repairWorkflow()` repara HU
guardadas en estados A1/A2.

**Pendiente relacionado:** la aprobación es por plan completo; no hay aprobación parcial ni
comparación (diff) entre el plan anterior y el nuevo.

### ✅ A3 — Ejecuciones "running" tras reiniciar — **corregido en Etapa 1.3**
- **Instancia única:** `data/hutracex.lock` (creado con `link`, atómico) con PID + hora de inicio
  (`/proc/<pid>/stat`) + `boot_id`. Una segunda instancia sobre el mismo `data/` no arranca; un
  bloqueo de un proceso muerto o con PID reutilizado se reemplaza.
- **Recuperación al arrancar:** toda ejecución `running` pasa a `interrupted`
  (`endReason: server_restart`, evento `run_interrupted` con `survivors`). No se asume que el proceso
  murió: se buscan procesos con su marca y se terminan (su salida ya no se puede capturar). La HU
  pasa a `blocked`: análisis siempre disponible; QA/implementación si la aprobación sigue vigente.
- **Cierre (SIGINT/SIGTERM):** no acepta nuevas ejecuciones, termina las activas, las registra
  `interrupted` (`server_shutdown`), espera como máximo `HUTRACEX_KILL_GRACE_MS` + 2 s y libera el bloqueo.

### ✅ A4 — Cancelación y timeout — **corregido en Etapa 1.3**
- Cada ejecución corre en su propio grupo (`detached`) con `HUTRACEX_RUN_ID` en el entorno. Las
  señales solo van a procesos con esa marca verificada en `/proc/<pid>/environ` (al grupo si un
  miembro marcado lo confirma; individualmente a los que escaparon con `setsid`).
- Cancelar/timeout/cierre: SIGTERM y SIGKILL tras `HUTRACEX_KILL_GRACE_MS` (5 s por defecto).
- Timeout propio: `HUTRACEX_RUN_TIMEOUT_MS` (360 s por defecto = 300 s de Headless + 60 s).
- Estados de ejecución: `completed`, `failed` (`exit_code`, `spawn_error`, `timeout`), `cancelled`,
  `interrupted` (`server_restart`, `server_shutdown`). La causa se fija al solicitarse: una salida
  posterior con código 0 no convierte una cancelación en éxito. Una sola finalización por ejecución.

**Riesgos residuales (A3/A4):**
- Un descendiente que borra su entorno **y** sobrevive al líder no es verificable: no recibe señales.
  La ejecución se finaliza igualmente (`forced: true`) a los `2 × HUTRACEX_KILL_GRACE_MS`.
- Procesos lanzados por versiones anteriores a la Etapa 1.3 no tienen marca: no se terminan.
- La toma de un bloqueo obsoleto tiene una ventana de carrera mínima si dos instancias arrancan a la vez.
- Fuera de Linux (sin `/proc`) solo se señaliza al grupo del líder mientras vive y el bloqueo usa `kill(pid, 0)`.
- `kill -9` al servidor deja los agentes vivos hasta el siguiente arranque, que los termina.

### ✅ A5 — Reescritura completa de la base por fragmento — **corregido en Etapa 1.4**
- La salida de cada ejecución va a `data/runs/<id>.log`, escrita en orden con `writeSync` sobre un fd
  `O_APPEND|O_EXCL|O_NOFOLLOW`, con `fsync` al terminar. `tracker.json` solo guarda `run.log`
  (`file`, `bytes`, `truncated`, `error`) y se reescribe solo ante cambios de estado o eventos.
- Límite por log: `HUTRACEX_MAX_LOG_BYTES` (10 MiB); al superarlo se trunca con aviso y evento `log_truncated`.
- Un fallo al crear el log impide iniciar la ejecución (HTTP 500); un fallo al escribirlo la termina
  como `failed` (`endReason: log_write_error`, evento `log_write_failed`).
- `/api/state` ya no incluye salidas; `GET /api/runs/:id/log?tail=<bytes>` devuelve el final del log.
- Medido con `npm run bench` (300 ejecuciones × 50 KB): `/api/state` 14,7 MB → 0,09 MB y
  159 → 6 ms; una ejecución de 500 KB, 1031 → 136 ms.

### ✅ A6 — Integridad de tracker.json — **corregido en Etapa 1.4**
- Escritura atómica: tmp + `fsync` + `rename` + `fsync` del directorio.
- Arranque: instalación nueva (sin `data/` previo) ⇒ base v2 vacía; `tracker.json` ausente con
  respaldos/logs previos, vacío, JSON inválido/truncado o esquema mínimo inválido ⇒ **no arranca**,
  no modifica el archivo e indica el respaldo verificado más reciente.
- Respaldos en `data/backups/` (copia exacta + `.sha256`, verificados al crearlos y al restaurar):
  uno por arranque (se conservan 10) y uno antes de cada migración (se conservan siempre).
- Restauración explícita: `HUTRACEX_RESTORE_BACKUP=latest|<archivo>`; solo actúa si la base actual
  falta o está dañada, y conserva la dañada como `tracker.json.damaged-*`.
- Migración v1 → v2 idempotente; `tracker.json` solo se reescribe al final (punto de confirmación).
- Un fallo al guardar responde HTTP 500 y queda visible en `/api/state` (`storage.ok = false`).

**Riesgos residuales (A5/A6):**
- Si un guardado falla y el proceso termina antes de un guardado exitoso, se pierden los cambios
  posteriores al último guardado confirmado (el cliente sí recibió HTTP 500).
- `tracker.json.tmp` de una escritura interrumpida se ignora (se avisa), no se recupera.
- No hay retención de logs ni de respaldos de migración: `data/runs/` crece con cada ejecución.
- `hu.plan` (hasta 100 000 caracteres por HU) sigue viajando en `/api/state`.
- La verificación por sha256 tras escribir cada log migrado no tiene prueba automatizada (requiere
  corromper el disco entre escritura y lectura).

### ✅ A7 — Prompt pasado como argumento del proceso — **corregido en Etapa 1.5**
- El prompt se escribe en `data/runs/<id>.prompt.md` (0600, `O_EXCL|O_NOFOLLOW`, fsync) y se pasa con
  `--prompt-file`. Headless 0.6.1 lo entrega por **stdin** a claude/codex (sin límite de argv, no visible en `ps`).
- **Residual:** para antigravity Headless lo pasa como argumento (`agy -p <prompt>`). Se rechaza
  explicitamente un prompt > 120 KiB para ese agente, pero los de menor tamaño siguen visibles en `ps`.

### A8 — Código minificado y sin pruebas
Resuelto en parte en la Etapa 0 (`npm test`). Reformatear en un commit solo de formato al inicio
de la Etapa 2 (ver `.prettierignore`).

## 🟡 Medio
- ✅ **M1** — Corregido en Etapa 1.4: `setEncoding('utf8')` en stdout/stderr (prueba `[utf8split]`).
- ✅ **M2** — Corregido en Etapa 1.5: `--sdk-format ndjson`; el plan es el `finalMessage` del sobre `result`, guardado en
  `runs/<id>.result.md` con sha256. stderr solo va al log. Sin resultado, vacío, malformado, con error o > 200 000
  caracteres ⇒ `failed` (`invalid_result`/`agent_error`). Aprobar exige plan = resultado válido (hash).
  Las HU con planes anteriores a 1.5 deben re-analizarse.
- ✅ **M3** — Corregido en Etapa 1.5: todos los campos y el contexto del proyecto van como JSON en un bloque
  `HU-DATA-<nonce>`, separado de las instrucciones. **Residual:** mitiga, pero no impide, la inyección de prompts.
- **M4** 🧪 — `validateRepo` acepta repos fuera de `browseRoots`, guarda la subcarpeta en vez del toplevel y permite duplicados.
- **M5** — Se ejecuta `git` sobre carpetas no confiables; añadir `-c core.fsmonitor=false` antes de sumar más comandos git.
- ✅ **M6** — Corregido en Etapa 1.5: no se re-renderiza si `/api/state` no cambió; al re-renderizar se conservan
  asignaciones sin guardar, `<details>`, scroll y foco (`view` en `public/app.js`); aviso al abandonar con
  asignaciones pendientes. El formulario de HU ya no se refrescaba (sin cambios). Prueba en Chrome headless.
- ✅ **Detectado y corregido en 1.5:** el detalle de la HU no se dibujaba desde la Etapa 1.2 (un comentario `//`
  dejó comentado el render en el código minificado). Cuerpos HTTP con caracteres multibyte cortados entre
  fragmentos se guardaban con `U+FFFD` (`req.setEncoding('utf8')`).
- **M7** — Sin límite global de ejecuciones concurrentes (costo de tokens).
- **M8** 🧪 — El explorador lista carpetas ocultas de `$HOME` (`.ssh`, `.gnupg`).

## 🟢 Bajo
- `api()` en `public/app.js` falla con error de JSON ante respuestas sin cuerpo.
- Timers del toast no se limpian.
- Nombre del paquete `hu-tracker` vs. HuTraceX.
- `~/CLAUDE.md` (fuera del repo) es una plantilla genérica con comandos inexistentes (`lint`, `typecheck`) y recomienda `enum` (incompatible con el type stripping de Node).
