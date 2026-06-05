const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const fs   = require('fs')

let mainWin  = null
let viewerWin = null

// ── Auto-updater ──────────────────────────────────────────────────────────────
let autoUpdater = null
try {
  const { autoUpdater: au } = require('electron-updater')
  autoUpdater = au
  autoUpdater.autoDownload    = false  // pregunta antes de descargar
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null
} catch(e) { /* dev mode sin electron-updater */ }

function setupUpdater(win) {
  if (!autoUpdater) return
  autoUpdater.on('checking-for-update',   () => win.webContents.send('update-status', {type:'checking'}))
  autoUpdater.on('update-available',      (i) => win.webContents.send('update-status', {type:'available', version: i.version}))
  autoUpdater.on('update-not-available',  ()  => win.webContents.send('update-status', {type:'up-to-date'}))
  autoUpdater.on('download-progress',     (p) => win.webContents.send('update-status', {type:'progress', percent: Math.round(p.percent)}))
  autoUpdater.on('update-downloaded',     ()  => win.webContents.send('update-status', {type:'ready'}))
  autoUpdater.on('error',                 (e) => win.webContents.send('update-status', {type:'error', msg: e.message}))
}

// ── Ventana principal ─────────────────────────────────────────────────────────
function createWindow() {
  mainWin = new BrowserWindow({
    width: 900, height: 800, minWidth: 700, minHeight: 600,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
    title: 'Brumet · Cotizador 3D',
    icon: path.join(__dirname, 'assets', 'icon.png'),
  })
  mainWin.loadFile('index.html')
  mainWin.setMenuBarVisibility(false)
  mainWin.on('closed', () => {
    if (viewerWin && !viewerWin.isDestroyed()) viewerWin.close()
    mainWin = null
  })
  mainWin.webContents.once('did-finish-load', () => {
    setupUpdater(mainWin)
    // Revisar actualizaciones al iniciar (con 5s de delay para que cargue la UI)
    if (autoUpdater) setTimeout(() => { try { autoUpdater.checkForUpdates() } catch(e){} }, 5000)
  })
}

// ── IPC: Updater ──────────────────────────────────────────────────────────────
ipcMain.handle('check-for-updates', async () => {
  if (!autoUpdater) return { error: 'Actualizador no disponible en modo dev' }
  try { await autoUpdater.checkForUpdates(); return { ok: true } }
  catch(e) { return { error: e.message } }
})
ipcMain.handle('download-update', async () => {
  if (!autoUpdater) return { error: 'No disponible' }
  try { await autoUpdater.downloadUpdate(); return { ok: true } }
  catch(e) { return { error: e.message } }
})
ipcMain.handle('install-update', () => {
  if (autoUpdater) autoUpdater.quitAndInstall()
})
ipcMain.handle('get-app-version', () => app.getVersion())

// ── IPC: Visor 3D ─────────────────────────────────────────────────────────────
ipcMain.on('open-viewer', (event, filePath) => {
  if (viewerWin && !viewerWin.isDestroyed()) {
    viewerWin.focus()
    viewerWin.webContents.send('load-stl', filePath)
    return
  }
  viewerWin = new BrowserWindow({
    width: 1200, height: 750, minWidth: 900, minHeight: 550,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
    title: 'Brumet · Visor 3D',
    icon: path.join(__dirname, 'assets', 'icon.png'),
  })
  viewerWin.setMenuBarVisibility(false)
  viewerWin.loadFile('viewer.html')
  viewerWin.webContents.once('did-finish-load', () => {
    if (filePath) viewerWin.webContents.send('load-stl', filePath)
  })
  viewerWin.on('closed', () => { viewerWin = null })
})

ipcMain.on('close-viewer', () => {
  if (viewerWin && !viewerWin.isDestroyed()) viewerWin.close()
})

ipcMain.on('open-stl-dialog', async (event) => {
  const parent = viewerWin || mainWin
  const { filePaths } = await dialog.showOpenDialog(parent, {
    title: 'Abrir modelo STL',
    filters: [{ name: 'Modelos 3D', extensions: ['stl', 'obj', '3mf'] }],
    properties: ['openFile']
  })
  if (filePaths.length) {
    event.sender.send('load-stl', filePaths[0])
    if (mainWin && !mainWin.isDestroyed())
      mainWin.webContents.send('sync-file', filePaths[0])
  }
})

ipcMain.on('slice-from-viewer', (event, dims) => {
  if (mainWin && !mainWin.isDestroyed()) {
    if (dims.stlBuffer) {
      const tempDir = path.join(app.getPath('userData'), 'temp')
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true })
      const tempSTL = path.join(tempDir, 'modelo_transformado.stl')
      fs.writeFileSync(tempSTL, Buffer.from(dims.stlBuffer))
      dims.tempSTLPath = tempSTL
    }
    mainWin.webContents.send('trigger-slice', dims)
    mainWin.focus()
  }
})

ipcMain.on('sync-file', (event, filePath) => {
  if (mainWin && !mainWin.isDestroyed())
    mainWin.webContents.send('sync-file', filePath)
})

// ── Motor de laminado ─────────────────────────────────────────────────────────
ipcMain.handle('slice-model', async (event, filePath, heightMM, extraData) => {
  delete require.cache[require.resolve('./slicer-bambu.js')]
  const { laminarConBambu } = require('./slicer-bambu.js')

  return new Promise((resolve, reject) => {
    const scalePct = extraData && extraData.scalePct ? parseFloat(extraData.scalePct) : null
    const originalPath = extraData && extraData.originalPath ? extraData.originalPath : filePath
    laminarConBambu(originalPath, scalePct, (err, resultado) => {
      if (err) { reject(err); return }
      resolve(resultado)
    })
  })
})

// ── Settings ──────────────────────────────────────────────────────────────────
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json')
const DEFAULT_CFG = {
  energiaW: 225, tarifaEnergia: 1000,
  desgasteTotal: 3000000, horasDesgaste: 74627,
  operarioPorHora: 600, espacioPorHora: 350,
  costoMontaje: 2500, costoMaquinado: 1000,
  margenPct: 0, markup: 2.0,
  filamentos: [
    { nombre: 'Básico',        desc: 'Blanco, negro, colores sólidos simples', precio: 70000  },
    { nombre: 'Premium',       desc: 'Galaxia, tornasol, escarchado, mármol',  precio: 85000  },
    { nombre: 'Ultra Premium', desc: 'TPU, PETG, ABS, fibra de carbono',       precio: 110000 }
  ]
}

ipcMain.handle('load-settings', () => {
  try {
    if (fs.existsSync(SETTINGS_FILE))
      return { ...DEFAULT_CFG, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }
  } catch(e) {}
  return DEFAULT_CFG
})

ipcMain.handle('save-settings', (event, s) => {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf8'); return true }
  catch(e) { return false }
})

// ── Licencias desde archivo ───────────────────────────────────────────────────
ipcMain.handle('load-license-hashes', () => {
  try {
    const f = path.join(__dirname, 'licenses.json')
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch(e) {}
  return []
})

// ── Export PDF ────────────────────────────────────────────────────────────────
ipcMain.handle('export-pdf', async (event, data) => {
  const pdfWin = new BrowserWindow({
    show: false, width: 800, height: 1100,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  })
  await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildPDFHTML(data)))
  await new Promise(r => setTimeout(r, 600))
  const buf = await pdfWin.webContents.printToPDF({ pageSize: 'A4', printBackground: true, marginsType: 0 })
  pdfWin.close()

  const { filePath } = await dialog.showSaveDialog(mainWin, {
    title: 'Guardar cotización PDF',
    defaultPath: `Cotizacion_Brumet_${new Date().toISOString().slice(0, 10)}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  if (!filePath) return { success: false }
  fs.writeFileSync(filePath, buf)
  return { success: true, path: filePath }
})

// ── Export CSV ────────────────────────────────────────────────────────────────
ipcMain.handle('export-csv', async (event, data) => {
  const { filePath } = await dialog.showSaveDialog(mainWin, {
    title: 'Guardar cotización Excel/CSV',
    defaultPath: `Cotizacion_Brumet_${new Date().toISOString().slice(0, 10)}.csv`,
    filters: [{ name: 'CSV / Excel', extensions: ['csv'] }]
  })
  if (!filePath) return { success: false }

  const rows = [
    ['Campo', 'Valor'],
    ['Archivo', data.archivo],
    ['Fecha', data.fecha],
    ['Material', data.material],
    ['Tiempo estimado', data.tiempo],
    ['Filamento usado', data.gramos + 'g'],
    ['Precio estimado (COP)', Math.round(data.precio)],
    ['', ''],
    ['AVISO', 'Precio sujeto a verificacion antes de confirmar la impresion.'],
  ]
  const csv = rows.map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n')
  fs.writeFileSync(filePath, '﻿' + csv, 'utf8')
  return { success: true }
})

// ── PDF HTML builder ──────────────────────────────────────────────────────────
function buildPDFHTML(data) {
  const fmt = n => '$' + Math.round(n).toLocaleString('es-CO')
  const brumetSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 340" style="height:36px;width:auto;fill:#E0313A"><path d="M158.11,218.39h-36.2v101.96h-30.53v-101.91h-36.13c0,2.77.02,5.22,0,7.67-.17,18.08.25,36.19-.68,54.23-1.23,23.81-16.22,38.89-39.87,41.54-4.72.53-9.46.89-14.65,1.38v-28.41c3.68-.61,7.42-1.04,11.08-1.86,7.9-1.77,12.94-6.64,13.12-14.67.43-19.78.14-39.57.14-60.09H0v-26.29h187.97v128.6h-29.87v-102.15Z"/><path d="M164.61,46.37c.42,19.53-4.07,37.09-15.49,53.74h15.5c.34,21.42-4.16,40.55-17.75,56.56-20.74,24.42-48.95,26.8-78.74,25.81v-27.19c9.72-.63,19.4-.8,28.96-1.98,19.15-2.36,33.02-17.53,33.37-35.79-7.31,2.58-14.44,6.37-21.95,7.47-12.93,1.89-26.1,2.39-39.19,2.86-4.2.15-5.97,1.48-7.35,5.26-5.64,15.46-13.45,29.56-26.63,39.98-10.23,8.09-22.01,11.54-35.34,11.74v-32.22c18.28-1.62,26.88-14.55,31.72-30.02,4.81-15.38,7.64-31.37,11.6-48.18H.1v-28.04h164.5ZM71.2,99.84c25.62,2.71,51.98-3.46,57.96-25.74-17.25,0-34.37-.08-51.48.16-1.27.02-3.4,2.11-3.63,3.49-1.2,7.16-1.91,14.4-2.85,22.09Z"/><path d="M178.85,185.52v-32.99c15.75-1.3,24.01-11.53,29.76-24.64,7.4-16.88,9.99-34.82,12.02-53.57h-41.61v-27.9h161.29c3.36,22.21-4.4,62.6-42.28,80,7.8,18.97,23.4,25,42.71,25.99v32.44c-20.02-.38-38.29-5.18-53.65-18.63-9.02-7.9-15.67-17.52-19.54-28.88-1.21-3.56-3.07-4.08-6.48-4.57-13.6-1.97-22.11,1.49-27.71,15.96-6.38,16.47-19.4,28.39-37.04,33.57-5.35,1.57-11.02,2.07-17.46,3.22ZM253.54,74.44c-1.54,10.38-2.98,20.11-4.41,29.83,29.79,4.7,57.4-9.65,57.94-29.83h-53.53Z"/><path d="M467.12,46.28h32.38v136.07h-32.14v-30.42c-2.81,2.44-4.58,3.97-6.33,5.51-18.79,16.41-40.97,24.1-65.53,25.06-13.1.51-26.24.09-39.84.09v-27.72h25.05c.13-2.33.33-4.25.33-6.18.02-16.87.04-33.74,0-50.61-.03-16.94-5.35-22.66-22.08-23.84-.99-.07-1.98-.18-3.37-.31v-29.14c24.14-6.7,53.47,12.57,56.5,38.22,1.68,14.25,1.2,28.76,1.53,43.16.19,8.11.03,16.23.03,24.99,1.92-.32,3.45-.37,4.85-.83,28.08-9.39,47.34-35.22,48.52-65.71.49-12.54.08-25.12.08-38.35Z"/><path d="M206.44,323.06v-28.29c2.88-.58,5.49-1.05,8.07-1.64,6.5-1.51,10.37-5.71,11.29-12.24.64-4.54.77-9.18.8-13.78.09-16.11.03-32.21.03-48.95h-20.16v-26.22h130.04v26h-79.01v20.95h65.26v26.27h-65.54c-.03,18.64-.8,36.68-17.16,48.77-9.83,7.27-21.36,8.66-33.63,9.13Z"/><path d="M500,322.72c-50.92.04-104.64-23.82-124.5-88.47h-23.8v-26.27h18.86c-.32-5.73-.59-10.64-.89-16.02h30.3c.5,4.87,1.02,9.95,1.6,15.62h84.73v26.29h-77.36c5.52,30.83,42.69,54.54,91.08,58.35v30.49Z"/><path d="M257.33,319.77v-25.5c10.6,0,20.88,0,31.15,0,2.87,0,5.74.05,8.61-.03,10.29-.3,13.88-3.47,15.65-13.7.16-.92.39-1.82.61-2.84h29.21c2.57,20.51-12.05,40.29-32.4,41.81-17.29,1.3-34.75.27-52.85.27Z"/></svg>`

  const thumbSection = data.thumbnail
    ? `<div style="text-align:center;margin:20px 0 24px"><img src="${data.thumbnail}" style="max-width:280px;max-height:190px;border-radius:10px;border:1px solid #eee;object-fit:contain;background:#f8f8f8" alt="Modelo 3D"></div>`
    : `<div style="text-align:center;margin:20px 0 24px;height:90px;background:#f8f8f8;border-radius:10px;border:1px solid #eee;display:flex;align-items:center;justify-content:center;color:#ccc;font-size:12px">Vista previa no disponible</div>`

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Helvetica Neue',Arial,sans-serif;background:#fff;color:#111;padding:40px 46px;font-size:13px}
.hdr{display:flex;justify-content:space-between;align-items:center;padding-bottom:18px;border-bottom:3px solid #E0313A;margin-bottom:24px}
.brand-sub{font-size:10px;color:#999;letter-spacing:.1em;text-transform:uppercase;margin-top:5px}
.doc-right{text-align:right}.doc-num{font-size:18px;font-weight:800;letter-spacing:.05em}
.doc-date{font-size:11px;color:#888;margin-top:3px}
h2{font-size:9px;font-weight:800;color:#E0313A;text-transform:uppercase;letter-spacing:.18em;margin:20px 0 9px;padding-bottom:5px;border-bottom:1px solid #eee}
.row{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #f5f5f5}
.lbl{color:#777}.val{font-weight:600}
.price-box{margin-top:24px;background:#E0313A;border-radius:12px;padding:24px;text-align:center;color:#fff}
.plbl{font-size:9px;opacity:.8;letter-spacing:.15em;text-transform:uppercase;margin-bottom:6px}
.pval{font-size:48px;font-weight:900;letter-spacing:-1px;font-family:Georgia,serif}
.psub{font-size:10px;opacity:.7;margin-top:4px}
.disclaimer{margin-top:16px;padding:10px 14px;background:#fff8f0;border:1px solid #ffe0b2;border-radius:8px;font-size:10px;color:#7a4f00;line-height:1.6}
.footer{margin-top:28px;text-align:center;font-size:9px;color:#ccc;border-top:1px solid #f0f0f0;padding-top:13px}
</style></head><body>
<div class="hdr">
  <div>${brumetSVG}<div class="brand-sub">Cotizador de Impresión 3D · Bogotá, Colombia</div></div>
  <div class="doc-right"><div class="doc-num">COTIZACIÓN</div><div class="doc-date">${data.fecha}</div></div>
</div>
${thumbSection}
<h2>Detalle del modelo</h2>
<div class="row"><span class="lbl">Archivo</span><span class="val">${data.archivo}</span></div>
<div class="row"><span class="lbl">Material seleccionado</span><span class="val">${data.material}</span></div>
<div class="row"><span class="lbl">Tiempo estimado de impresión</span><span class="val">${data.tiempo}</span></div>
<div class="row"><span class="lbl">Filamento requerido</span><span class="val">${data.gramos}g</span></div>
<div class="price-box">
  <div class="plbl">Precio estimado</div>
  <div class="pval">${fmt(data.precio)}</div>
  <div class="psub">Pesos colombianos · IVA no incluido</div>
</div>
<div class="disclaimer">
  ⚠ <strong>Precio sujeto a verificación.</strong> Este valor es una estimación. El precio final puede variar según la complejidad real y las condiciones definitivas del modelo.
</div>
<div class="footer">@brumet.co · Bogotá, Colombia · Brumet Slicer v${app.getVersion()}</div>
</body></html>`
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
