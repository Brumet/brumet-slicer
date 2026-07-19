# CLAUDE.md

Este archivo guía a Claude Code (claude.ai/code) al trabajar con el código de este repositorio.

## Qué es esto

Brumet Slicer es una app de escritorio Windows (Electron) que permite a un negocio de
impresión 3D cotizar trabajos: el usuario arrastra un STL/OBJ/3MF, la app lo lamina
silenciosamente con un BambuStudio CLI incluido, y calcula un precio a partir de
filamento + energía + desgaste de máquina + operario, para luego exportar una
cotización en PDF/CSV con marca propia. Es un producto comercial para un solo cliente
(Brumet, Bogotá) — no una librería open-source — así que los cambios deben preservar
la lógica exacta de precios/negocio salvo que se pida modificarla explícitamente.

## Comandos

```bash
npm install         # instalar dependencias
npm start            # correr la app en dev (electron .)
npm run build         # electron-builder --win (build local sin firmar)
npm run publish       # electron-builder --win --publish always (build + sube a GitHub Releases)
npm run codigos       # node generar-codigos.js (generador de códigos de licencia — no está en este repo, ver abajo)
```

No hay suite de tests, linter ni CI configurados en este repo — verifica los cambios
corriendo `npm start` y probando el flujo manualmente (ver Arquitectura abajo para
saber qué probar).

**Requisito solo en dev:** debe existir una carpeta `BambuStudio/` con `bambu-studio.exe`
en la raíz del proyecto (ver la resolución de `BAMBU_EXE` en `slicer-bambu.js`). Está en
`.gitignore` por tamaño — sin ella, el laminado falla pero la UI carga igual.

## Arquitectura

Es una app Electron plana, **sin bundler ni build step para el código fuente** —
`main.js`, `index.html`, `viewer.html` y `slicer-bambu.js` se cargan tal cual
(`nodeIntegration: true`, `contextIsolation: false` en las ventanas principal y del
visor), y la lógica de negocio vive directamente en bloques `<script>` dentro de los
HTML en vez de en módulos separados. Para tocar lógica de UI, ve directo al bloque
`<script>` correspondiente en `index.html` o `viewer.html`.

### División de procesos

- **`main.js`** — proceso principal de Electron. Contiene todos los handlers IPC, las
  BrowserWindows (`mainWin` + una `viewerWin` separada), el logging de errores a disco +
  reporte por webhook de Discord, el auto-updater (`electron-updater`, revisa GitHub
  Releases), la persistencia de settings/historial (archivos JSON bajo
  `app.getPath('userData')`), y la exportación de PDF/CSV (el PDF se arma como un
  string HTML en `buildPDFHTML()` y se renderiza fuera de pantalla vía `printToPDF`).
- **`index.html`** — la ventana principal: zona de arrastre de archivos, selección de
  filamento/impresora, cálculo de precio y UI de resultados, modal de configuración
  (protegido por contraseña), pantalla de licencia/prueba, historial de cotizaciones,
  exportación a PDF/CSV/WhatsApp.
- **`viewer.html`** — una *segunda* BrowserWindow con un visor 3D en Three.js para
  previsualizar/transformar un modelo (mover/rotar/escalar) antes de cotizar. Se
  comunica con `main.js`/`index.html` únicamente por IPC (`slice-from-viewer`,
  `sync-file`, `load-stl`, `open-stl-dialog`) — no hay referencia directa entre los dos
  contextos de renderer.
- **`slicer-bambu.js`** — el motor de laminado. Envuelve el BambuStudio CLI incluido
  (`bambu-studio.exe --slice 1 --outputdir ...`) como proceso hijo y parsea su salida
  `result.json` para obtener tiempo/gramos de filamento por cama.

### Pipeline de laminado (el flujo central, no obvio)

Los archivos STL/OBJ **no** se laminan directamente — BambuStudio necesita un proyecto
`.3mf`. Por eso `slicer-bambu.js` toma una plantilla `.3mf` específica de la impresora
desde `perfiles/` (ej. `elevador_config.3mf` para la Bambu A1, referenciada vía
`PLANTILLAS_IMPRESORA`), la descomprime con `adm-zip`, reemplaza el XML de
`3D/Objects/object_1.model` por uno generado a partir de la geometría STL/OBJ parseada,
ajusta el transform del item y el bbox en `Metadata/plate_1.json` para posicionar el
modelo, y vuelve a comprimirlo como un `.3mf` temporal antes de invocar el CLI. Si el
archivo de entrada ya es `.3mf`, se pasa directo sin tocarlo (ya trae su propia
configuración).

Detalles clave a preservar si se toca este flujo:
- **Auto-detección de unidades** (`calcularEscala`): bbox máximo < 1 → asume metros
  (×1000); < 10 → asume centímetros (×10); si no, milímetros. Esta misma regla está
  duplicada en la lógica de escala del visor 3D — si las dos divergen, la app cotiza un
  tamaño distinto al que el usuario ve en pantalla (hay un comentario en el código que
  referencia un bug real ocurrido por esto).
- **Reparación de malla** (`repararMalla`): suelda vértices duplicados y rellena
  agujeros pequeños de bordes abiertos antes de pasarle la geometría a BambuStudio,
  imitando el botón "Reparación" del propio BambuStudio — necesario porque muchos STL
  de clientes son "triangle soup" no-manifold.
- **Protección de tamaño de cama**: rechaza (con un mensaje para el usuario) cualquier
  modelo cuyo bbox transformado exceda 256mm en algún eje, en vez de dejar que
  BambuStudio lo lamine mal silenciosamente.
- **3MF multi-cama**: un `.3mf` puede contener varias camas; los resultados se agregan
  por cama (`camasData`) y también se suman en los campos de nivel superior
  `tiempo`/`gramos`/`horas` por compatibilidad con código de UI de una sola cama.
- Cuando el visor aplicó una transformación, lo que se lamina es el STL transformado
  (generado con `exportSTLBinary` en `viewer.html` y escrito a un archivo temporal) —
  pasar el path del archivo original en su lugar cotizaría el tamaño incorrecto (sin
  transformar).

### Fórmula de precio

```
costo = filamento + energía + desgaste_máquina + operario + espacio + fijos
precio = costo × markup   (markup por defecto 2.0×, es decir 100% de margen)
```

Implementada en `calcularPrecio()` en `index.html`. Todos los parámetros de costo
(tarifa de energía, desgaste/vida útil de máquina, operario/hora, espacio/hora, costos
fijos, niveles de filamento, markup) viven en un objeto de settings persistido vía los
handlers IPC `load-settings`/`save-settings` de `main.js`, con `DEFAULT_CFG` en
`main.js` como schema/fallback. Existe un descuento por cantidad separado
(`descuentoPorCantidad`) que se aplica por encima, por línea, y deliberadamente se
mantiene fuera de la fórmula por unidad.

### Control de acceso a configuración

El modal de configuración está protegido por una verificación de contraseña hecha en el
cliente en `index.html` (`checkPassword()`, comparando hashes SHA-256) con dos niveles:
una contraseña de acceso completo (todos los parámetros de costo) y otra de privilegio
menor (solo marca: logo, nombre, contacto, color). No bajes esta barrera ni expongas
las comparaciones en texto plano — esto protege los datos de costos del dueño del
negocio de ser editados por quien esté frente a la máquina.

### Licencias

El estado de prueba/licencia vive en `index.html`, no en `main.js`: un archivo JSON
local bajo `AppData/Roaming/Brumet Slicer/license.json` registra un período de prueba
de 30 días o uno licenciado de 183 días. Los códigos de activación se validan contra
hashes SHA-256 en `licenses.json` (cargado vía el handler IPC `load-license-hashes`) —
el generador de esos hashes (`generar-codigos.js`) está deliberadamente excluido de git
(ver `.gitignore`) y requiere una clave maestra que no está en este repo.

### Reporte de errores

`main.js` registra errores en un archivo local rotativo (`logs/brumet.log` bajo
userData, con tope de 512KB y una copia de respaldo) y también los envía por POST a un
webhook de Discord para monitoreo en tiempo real, limitado a 1 mensaje por minuto. La
URL del webhook vive en `webhook.json`, que está en `.gitignore` (el repo es público; una
URL de webhook filtrada habría que invalidarla) pero *sí* se empaqueta en la app
construida vía la lista `files` de electron-builder. Cada cotización exitosa también se
reporta al mismo webhook (`log-cotizacion`) para detectar cotizaciones sospechosas, y
los pedidos aprobados (`aprobar-cotizacion`) se envían con el archivo del modelo
comprimido como adjunto (limitado a los 10MB de Discord).

### Empaquetado

La configuración `build` de `package.json` (electron-builder) empaqueta `perfiles/` y
`BambuStudio/` como `extraResources` (fuera del ASAR), con el paquete de BambuStudio
filtrado a solo lo necesario en tiempo de ejecución (descarta plugins, i18n de recursos,
fuentes, modelos, etc. para reducir el instalador). `slicer-bambu.js` y `main.js`
resuelven paths de forma distinta en dev (`__dirname/...`) vs. empaquetado
(`process.resourcesPath/...`) — mantén ambas ramas sincronizadas al agregar nuevos
recursos empaquetados.

## Convenciones

- El código, comentarios, strings de UI y mensajes de commit orientados al usuario
  están en **español** (el cliente y sus clientes son colombianos) — respeta esto al
  editar archivos existentes. El formato de moneda usa locale `es-CO` y pesos
  colombianos (COP).
- Sin bundler, sin TypeScript, sin framework — `<script>` planos y `require()` de
  CommonJS en el renderer (habilitado por `nodeIntegration: true`). No introduzcas un
  build step ni un sistema de módulos sin discutirlo antes.
- Solo `Bambu A1` tiene actualmente un perfil real en `perfiles/`; `PLANTILLAS_IMPRESORA`
  en `slicer-bambu.js` también lista plantillas para P1S/X1C que aún no existen y caen de
  forma segura al default de A1 (`getPlantilla`) — agregar soporte real para otra
  impresora significa agregar una nueva plantilla `..._config.3mf` en `perfiles/`.
