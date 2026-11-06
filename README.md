# HU Tracker — MVP local

Panel web para trazabilidad de historias de usuario, selección de repositorios Git y roles configurables para Claude, Codex y Antigravity.

## Requisitos
- Debian/Linux, Node.js 20+.
- Git instalado.
- Headless CLI instalado y disponible en PATH (`headless --check`).
- Autenticación de los agentes que vayas a usar.

## Iniciar
```bash
cd hu-tracker
npm start
```
Abrir **http://127.0.0.1:3000**. No requiere `npm install`: usa exclusivamente módulos integrados de Node.js.

Para otro puerto: `PORT=3100 npm start`.

## Qué hace
1. Registra proyectos mediante rutas absolutas de carpetas Git.
2. Crea historias de usuario con descripción y criterios de aceptación.
3. Permite elegir Claude, Codex o Antigravity para análisis, implementación y QA en cada HU.
4. Ejecuta **análisis y QA** mediante Headless con `--allow read-only`.
5. Registra salidas, errores, ejecuciones, estados, aprobación humana y evidencias manuales.
6. Guarda datos localmente en `data/tracker.json` (no en la BD del proyecto).

## Limitaciones de seguridad y alcance
- **La implementación automática está deshabilitada intencionalmente.** Headless 0.6.1 ofrece `read-only` y `yolo`; no se activa `yolo` sobre repositorios reales. Se añadirá ejecución en worktree aislado, con permisos acotados, en una etapa posterior.
- La lectura de Antigravity puede fallar por permisos de su herramienta `command`; se registra el error en la HU. No se habilita `--dangerously-skip-permissions`.
- La aplicación es **local**, escucha solo en `127.0.0.1` y no tiene autenticación multiusuario. No exponer a Internet.
- Las instrucciones prohíben SQL, migraciones y modificaciones de BD; `read-only` ofrece una barrera adicional, pero no constituye aislamiento de red ni una garantía absoluta sobre efectos externos.
- Las ejecuciones pueden consumir tokens según tu cuenta/proveedor. El costo exacto no se estima todavía.
- La selección de carpetas es mediante **ruta absoluta escrita**. El explorador visual de carpetas es una mejora pendiente.
- No hay importación de archivos adjuntos, ni integración Git diff/commits automática, ni planificación de dependencias todavía.

## Próximas etapas
- Worktrees por HU, aprobación de cambios y ejecución de implementación con permisos seguros.
- Captura de Git diff, pruebas, commits y evidencia automatizada.
- Explorador de carpetas con directorios autorizados.
- Presupuestos por agente, límites y reintentos.
- Exportación de trazabilidad en Markdown/PDF.
