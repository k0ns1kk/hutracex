# HuTraceX — MVP local

Panel web local para gestionar historias de usuario (HU), asignar Claude, Codex o Antigravity a
cada etapa y registrar la trazabilidad completa: ejecuciones, salidas, aprobaciones y evidencias.

## Requisitos
- Debian/Linux, Node.js 20+ (desarrollado con 22).
- Git instalado.
- Headless CLI en `PATH` (`headless --check`) y los agentes que uses autenticados.

## Iniciar
```bash
cd ~/Code/hutracex
npm start
```
Abrir **http://127.0.0.1:3000**. No requiere `npm install`: usa solo módulos integrados de Node.

| Variable | Uso | Por defecto |
|---|---|---|
| `PORT` | Puerto | `3000` |
| `HOST` | Interfaz de escucha: solo `127.0.0.1`, `localhost` o `::1` (otro valor impide arrancar) | `127.0.0.1` |
| `REPO_BROWSE_ROOTS` | Carpetas adicionales para el explorador, separadas por `:` | solo `$HOME` |
| `HUTRACEX_RUN_TIMEOUT_MS` | Tiempo máximo de una ejecución (independiente del de Headless) | `360000` |
| `HUTRACEX_KILL_GRACE_MS` | Espera entre SIGTERM y SIGKILL al cancelar, vencer o cerrar | `5000` |
| `HUTRACEX_MAX_LOG_BYTES` | Tamaño máximo del log de una ejecución | `10485760` |
| `HUTRACEX_RESTORE_BACKUP` | Restaurar un respaldo (`latest` o nombre de archivo) si `tracker.json` falta o está dañado | — |

## Pruebas
```bash
npm test
```
Pruebas de caracterización con `node:test`. Usan un Headless **simulado**
(`test/fixtures/fake-headless.js`), un `HOME` temporal y una copia del servidor en un directorio
temporal: no ejecutan agentes reales ni tocan `data/`.

## Qué hace
1. **Proyectos:** registra repositorios Git por ruta absoluta (admite `~/`) o con el
   **explorador de carpetas**, limitado a `$HOME` y `REPO_BROWSE_ROOTS`, sin seguir enlaces
   simbólicos, que indica si la carpeta es un repositorio Git.
2. **Historias de usuario:** título, descripción funcional, criterios de aceptación, reglas de
   negocio, restricciones técnicas, observaciones, prioridad (baja/media/alta) y estado inicial
   (borrador/bloqueada). Editor de página completa con aviso de cambios sin guardar.
3. **Agentes por etapa:** análisis, implementación y QA configurables por HU.
4. **Ejecución:** análisis y QA mediante `headless <agente> --allow read-only`. Cada ejecución
   corre en su propio grupo de procesos; cancelar o vencer el tiempo máximo termina también sus
   descendientes (SIGTERM y luego SIGKILL). Solo una ejecución activa por HU.
   - Detener el servidor con Ctrl+C termina las ejecuciones activas y las registra como interrumpidas.
   - Si el servidor se cae, al volver a arrancar marca esas ejecuciones como interrumpidas y deja la
     HU lista para reintentar.
   - Solo una instancia de HuTraceX puede usar el mismo `data/` a la vez.
5. **Flujo con aprobación humana:** análisis → aprobar plan → registrar implementación manual
   (rama, commits, pruebas) → QA → cerrar. El backend valida cada transición. Un nuevo análisis o
   un cambio en el contenido de la HU invalida la aprobación y exige aprobar otra vez; cambiar
   agentes o prioridad no la invalida.
6. **Trazabilidad:** línea de tiempo de eventos y salidas de cada ejecución.
7. **Tema** claro/oscuro persistente.
8. **Datos locales** en `data/` (ignorado por git, permisos 0600):
   - `tracker.json`: proyectos, HU, eventos y metadatos de ejecuciones (escritura atómica con fsync);
   - `runs/<id>.log`: salida de cada ejecución, escrita a medida que llega;
   - `runs/<id>.prompt.md` y `runs/<id>.result.md`: prompt enviado y resultado final validado;
   - `backups/`: respaldos verificados (sha256) en cada arranque y antes de cada migración.

   Si `tracker.json` está dañado, HuTraceX **no arranca** y muestra el respaldo válido más reciente;
   para restaurarlo: `HUTRACEX_RESTORE_BACKUP=latest npm start`. Los datos de versiones anteriores
   se migran automáticamente (y de forma reanudable) la primera vez.

## Limitaciones de seguridad y alcance
- **La implementación automática está deshabilitada intencionalmente.** Headless 0.6.1 ofrece
  `read-only` y `yolo`; no se activa `yolo` sobre repositorios reales.
- Los prompts de análisis/QA prohíben SQL, migraciones y escritura; `read-only` es una barrera
  adicional, no un aislamiento total. El contenido de la HU viaja como datos JSON delimitados, separado
  de las instrucciones; esto reduce, pero no elimina, el riesgo de inyección de prompts.
- Los prompts se entregan por archivo (`--prompt-file`). Headless 0.6.1 se los pasa por stdin a Claude y
  Codex, pero **a Antigravity como argumento** (visible en `ps`, máximo ~120 KiB: si se supera, la
  ejecución se rechaza con un mensaje claro).
- Solo se puede aprobar el resultado final estructurado del agente (`--sdk-format ndjson`). Una respuesta
  vacía, truncada o malformada marca la ejecución como fallida. Las HU con un plan generado antes de
  esta versión deben re-analizarse antes de aprobarse.
- Antigravity puede fallar por permisos de su herramienta `command`; el error queda registrado.
  No se habilita `--dangerously-skip-permissions`.
- **Solo local y sin autenticación.** El servidor rechaza `Host`/`Origin` ajenos, peticiones de
  otros sitios y escrituras que no sean `application/json` (protección contra DNS rebinding y CSRF),
  pero cualquier proceso local puede usar la API. Accede por `http://127.0.0.1:<puerto>`,
  `http://localhost:<puerto>` o `http://[::1]:<puerto>`; un proxy o un nombre de host distinto será
  rechazado. Defectos pendientes: [`docs/known-issues.md`](docs/known-issues.md).
- Las ejecuciones consumen tokens; el costo no se estima todavía.
- Sin adjuntos, sin integración automática con git diff/commits y sin dependencias entre HU.

## Próximas etapas
1. Corregir los problemas críticos y altos de [`docs/known-issues.md`](docs/known-issues.md).
2. Modularizar el backend (máquina de estados explícita, runner, persistencia).
3. Salidas de ejecución en archivos y actualizaciones en tiempo real (SSE).
4. Worktrees por HU y ejecución de implementación con permisos acotados.
5. Presupuestos por agente, límites y reintentos; exportación de trazabilidad.
