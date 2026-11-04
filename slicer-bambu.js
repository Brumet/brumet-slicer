const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const AdmZip = require('adm-zip')
const { geometriaDe3MF } = require('./leer-3mf.js')

const BAMBU_EXE = (() => {
  // Dev: el exe está junto al proyecto
  const devPath = path.join(__dirname, 'BambuStudio', 'bambu-studio.exe')
  if (fs.existsSync(devPath)) return devPath
  // Prod (instalado): en resources/../BambuStudio/
  if (process.resourcesPath) {
    const prodPath = path.join(process.resourcesPath, '..', 'BambuStudio', 'bambu-studio.exe')
    if (fs.existsSync(prodPath)) return prodPath
  }
  return 'C:\\Program Files\\Bambu Studio\\bambu-studio.exe'
})()
// En producción el ASAR empaqueta el código pero extraResources queda fuera
// perfiles/ → resources/perfiles/  |  dev: __dirname/perfiles/
function resolveProfile(filename) {
  const devPath  = path.join(__dirname, 'perfiles', filename)
  if (fs.existsSync(devPath)) return devPath
  return path.join(process.resourcesPath || '', 'perfiles', filename)
}

const PLANTILLA_DEFAULT = resolveProfile('elevador_config.3mf')

const PLANTILLAS_IMPRESORA = {
  'Bambu A1':  resolveProfile('elevador_config.3mf'),
  'Bambu P1S': resolveProfile('p1s_config.3mf'),
  'Bambu X1C': resolveProfile('x1c_config.3mf'),
}

function getPlantilla(printer) {
  const p = printer && PLANTILLAS_IMPRESORA[printer]
  if (p && fs.existsSync(p)) return p
  return PLANTILLA_DEFAULT  // fallback seguro a Bambu A1
}
const TEMP_DIR   = path.join(require('os').homedir(), 'AppData', 'Roaming', 'Brumet Slicer', 'temp')
const OUTPUT_DIR = TEMP_DIR
const SLICE_TIMEOUT_MS = 10 * 60 * 1000  // 10 minutos máximo

function esSTLAscii(buf) {
  const inicio = buf.slice(0, 256).toString('utf8')
  return inicio.trimStart().startsWith('solid') && inicio.includes('facet normal')
}

// MISMA regla de unidades que el visor 3D (viewer.html / index.html).
// Si difieren, la cotización lamina un tamaño distinto al que el usuario ve
// en pantalla (bug real: silla de 0.98m cotizaba como miniatura de 25mm).
function calcularEscala(bboxMax) {
  if (bboxMax < 1) {
    console.log('[Brumet] Metros detectados escalando x1000')
    return 1000
  }
  if (bboxMax < 10) {
    console.log('[Brumet] Centimetros detectados escalando x10')
    return 10
  }
  console.log('[Brumet] Milimetros correctos sin cambio')
  return 1
}

// ── Reparación de malla (soldar vértices duplicados + rellenar agujeros) ────
// Imita lo que hace BambuStudio/Windows con el botón "Reparación":
// 1) Suelda vértices que están en la misma posición (típico de mallas STL
//    "triangle soup" o de escaneos 3D, que generan miles de "open edges").
// 2) Detecta los bordes abiertos restantes (huecos reales en la superficie)
//    y los tapa triangulando en abanico desde el centroide del hueco.
function repararMalla(verts, tris) {
  const EPS = 1e-4
  const map = new Map()
  const newVerts = []
  const remap = new Array(verts.length)
  for (let i = 0; i < verts.length; i++) {
    const [x, y, z] = verts[i]
    const key = Math.round(x / EPS) + '_' + Math.round(y / EPS) + '_' + Math.round(z / EPS)
    let idx = map.get(key)
    if (idx === undefined) {
      idx = newVerts.length
      newVerts.push([x, y, z])
      map.set(key, idx)
    }
    remap[i] = idx
  }

  // Quitar triángulos degenerados (área 0) y duplicados
  const seen = new Set()
  let cleanTris = []
  for (const [a, b, c] of tris) {
    const A = remap[a], B = remap[b], C = remap[c]
    if (A === B || B === C || A === C) continue
    const key = [A, B, C].slice().sort((x, y) => x - y).join('_')
    if (seen.has(key)) continue
    seen.add(key)
    cleanTris.push([A, B, C])
  }

  const vertsAntes = verts.length, trisAntes = tris.length
  console.log(`[Brumet] Malla: ${vertsAntes} vertices / ${trisAntes} triangulos -> ${newVerts.length} vertices soldados / ${cleanTris.length} triangulos validos`)

  // Detectar bordes abiertos (aristas dirigidas sin pareja opuesta)
  const dirEdges = new Set()
  for (const [a, b, c] of cleanTris) {
    dirEdges.add(a + '_' + b)
    dirEdges.add(b + '_' + c)
    dirEdges.add(c + '_' + a)
  }
  const boundary = []
  for (const e of dirEdges) {
    const [a, b] = e.split('_').map(Number)
    if (!dirEdges.has(b + '_' + a)) boundary.push([a, b])
  }

  if (boundary.length > 0) {
    console.log(`[Brumet] ${boundary.length} bordes abiertos detectados, intentando rellenar huecos...`)
    const startMap = new Map()
    for (const [a, b] of boundary) {
      if (!startMap.has(a)) startMap.set(a, [])
      startMap.get(a).push(b)
    }
    const used = new Set()
    let huecosRellenados = 0, huecosOmitidos = 0
    for (const [a0, b0] of boundary) {
      if (used.has(a0 + '_' + b0)) continue
      const loop = [a0]
      let cur = a0, next = b0
      let safety = 0
      while (safety++ < boundary.length + 10) {
        used.add(cur + '_' + next)
        loop.push(next)
        if (next === a0) break
        const opts = (startMap.get(next) || []).filter(x => !used.has(next + '_' + x))
        if (opts.length === 0) break
        cur = next
        next = opts[0]
      }
      if (loop[loop.length - 1] !== a0) continue
      loop.pop()
      if (loop.length < 3 || loop.length > 500) { huecosOmitidos++; continue }

      let cx = 0, cy = 0, cz = 0
      for (const idx of loop) { cx += newVerts[idx][0]; cy += newVerts[idx][1]; cz += newVerts[idx][2] }
      cx /= loop.length; cy /= loop.length; cz /= loop.length
      const centroidIdx = newVerts.length
      newVerts.push([cx, cy, cz])
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length]
        cleanTris.push([b, a, centroidIdx])
      }
      huecosRellenados++
    }
    console.log(`[Brumet] ${huecosRellenados} hueco(s) rellenado(s), ${huecosOmitidos} omitido(s) (demasiado grandes/irregulares)`)
  }

  return { verts: newVerts, tris: cleanTris }
}

// Error con mensaje ya pensado para el usuario (se muestra tal cual)
function errorUsuario(msg) {
  const e = new Error(msg)
  e.usuario = true
  return e
}

// ── Lectura de mallas (coordenadas tal cual vienen en el archivo) ────────────
function leerSTL(buf) {
  const verts = [], tris = []
  if (esSTLAscii(buf)) {
    const texto = buf.toString('utf8')
    const re = /facet normal[\s\S]*?endloop/g
    let faceta
    while ((faceta = re.exec(texto)) !== null) {
      const vre = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g
      const base = verts.length
      let vm
      while ((vm = vre.exec(faceta[0])) !== null) {
        verts.push([parseFloat(vm[1]), parseFloat(vm[2]), parseFloat(vm[3])])
      }
      if (verts.length - base === 3) tris.push([base, base+1, base+2])
      else verts.length = base  // faceta mal formada: se descarta
    }
    return { verts, tris }
  }
  if (buf.length < 84) return { verts, tris }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  // Algunos exportadores escriben mal el número de caras: nunca leer más allá del archivo
  const faceCount = Math.min(dv.getUint32(80, true), Math.floor((buf.length - 84) / 50))
  let off = 84
  for (let i=0; i<faceCount; i++) {
    off += 12
    const base = verts.length
    for (let j=0; j<3; j++) {
      verts.push([dv.getFloat32(off,true), dv.getFloat32(off+4,true), dv.getFloat32(off+8,true)])
      off += 12
    }
    tris.push([base, base+1, base+2])
    off += 2
  }
  return { verts, tris }
}

function leerOBJ(texto) {
  const verts = [], tris = []
  texto.split('\n').forEach(line => {
    const t = line.trim()
    if (t.startsWith('v ')) {
      const p = t.split(/\s+/)
      verts.push([parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3])])
    } else if (t.startsWith('f ')) {
      // Índices 1-based; los negativos son relativos al último vértice leído
      const parts = t.split(/\s+/).slice(1).map(p => {
        const n = parseInt(p.split('/')[0])
        return n < 0 ? verts.length + n : n - 1
      })
      for (let i = 1; i < parts.length - 1; i++) tris.push([parts[0], parts[i], parts[i+1]])
    }
  })
  return { verts, tris }
}

// Bounding box solo de los vértices que forman triángulos
function bboxMalla(verts, tris) {
  let minX=Infinity,minY=Infinity,minZ=Infinity
  let maxX=-Infinity,maxY=-Infinity,maxZ=-Infinity
  for (const t of tris) for (const i of t) {
    const [x,y,z] = verts[i]
    if(x<minX)minX=x; if(x>maxX)maxX=x
    if(y<minY)minY=y; if(y>maxY)maxY=y
    if(z<minZ)minZ=z; if(z>maxZ)maxZ=z
  }
  return {minX,minY,minZ,maxX,maxY,maxZ}
}

// Volumen con signo (teorema de la divergencia); el signo depende de la orientación de las caras
function volumenMalla(verts, tris) {
  let v = 0
  for (const [a, b, c] of tris) {
    const [ax,ay,az] = verts[a], [bx,by,bz] = verts[b], [cx,cy,cz] = verts[c]
    v += ax*(by*cz - bz*cy) - ay*(bx*cz - bz*cx) + az*(bx*cy - by*cx)
  }
  return v / 6
}

// Deja solo los vértices usados por algún triángulo (BambuStudio calcula el
// tamaño del objeto con TODOS los vértices, así que uno suelto o con NaN
// puede sacar la pieza de la cama aunque no se vea).
function compactarMalla(verts, tris) {
  const nuevoIdx = new Map()
  const out = []
  const outTris = tris.map(t => t.map(i => {
    let n = nuevoIdx.get(i)
    if (n === undefined) { n = out.length; out.push(verts[i]); nuevoIdx.set(i, n) }
    return n
  }))
  return { verts: out, tris: outTris }
}

// STL / OBJ: lee, sanea, escala y repara.
// unidadesAuto = false cuando el archivo ya viene en mm (STL exportado por el
// visor 3D): re-detectar unidades multiplicaría x10 una pieza de menos de 10 mm.
function prepararMalla(filePath, ext, scalePct, unidadesAuto) {
  const crudo = ext === '.obj'
    ? leerOBJ(fs.readFileSync(filePath, 'utf8'))
    : leerSTL(fs.readFileSync(filePath))

  // Fuera triángulos con índices inválidos o coordenadas NaN/Infinito
  const validos = crudo.tris.filter(t => t.every(i =>
    i >= 0 && i < crudo.verts.length && crudo.verts[i].every(Number.isFinite)))
  if (validos.length < crudo.tris.length)
    console.log(`[Brumet] ${crudo.tris.length - validos.length} triangulo(s) invalido(s) descartado(s)`)
  if (validos.length === 0)
    throw errorUsuario('El archivo no contiene una malla 3D válida (no tiene triángulos legibles). Exporta el modelo de nuevo como STL desde el programa donde se diseñó.')

  // Misma regla de unidades que el visor: por el tamaño del modelo
  const b0 = bboxMalla(crudo.verts, validos)
  const escala = (unidadesAuto
    ? calcularEscala(Math.max(b0.maxX-b0.minX, b0.maxY-b0.minY, b0.maxZ-b0.minZ))
    : 1) * ((scalePct || 100) / 100)

  const escalados = crudo.verts.map(v => [v[0]*escala, v[1]*escala, v[2]*escala])
  const reparado = repararMalla(escalados, validos)
  const malla = compactarMalla(reparado.verts, reparado.tris)
  if (malla.tris.length === 0)
    throw errorUsuario('El modelo no tiene volumen imprimible (todas sus caras son planas o están repetidas). Revisa el archivo en el programa donde se diseñó.')

  // Una superficie sin grosor (logo o texto exportado en 2D) no tiene nada que
  // imprimir: BambuStudio la descarta y responde "plate is empty".
  if (Math.abs(volumenMalla(malla.verts, malla.tris)) < 0.001)
    throw errorUsuario('El modelo es una superficie sin grosor (0 mm³ de volumen), algo común en logos o textos exportados en 2D. Ábrelo en el programa de diseño, dale grosor (extruir / solidificar), expórtalo como STL y vuelve a cotizar.')
  return malla
}

// 3MF que el motor no pudo leer (versión más nueva de Bambu Studio): se toma su geometría
function tresMFAMalla(ruta, scalePct) {
  const { verts, tris, piezas, medidas, rangos } = geometriaDe3MF(ruta)
  const f = (scalePct || 100) / 100
  console.log(`[Brumet] 3MF leído a mano: ${piezas} pieza(s), ${tris.length} triángulos`)
  if (piezas > 1) acomodarPiezas(verts, medidas, rangos)
  return { verts: f === 1 ? verts : verts.map(([x,y,z]) => [x*f, y*f, z*f]), tris,
           medidas: medidas.map(m => m.map(v => v*f)) }
}

// Un proyecto con varias placas trae las piezas regadas lejos unas de otras. Se ponen juntas,
// en filas (de la más alta a la más baja), para que la cama virtual sea lo más chica posible:
// laminar una cama gigante casi vacía hace que el motor se demore muchísimo.
function acomodarPiezas(verts, medidas, rangos) {
  const SEP = 5
  const area = medidas.reduce((s, [x, y]) => s + (x + SEP) * (y + SEP), 0)
  const ancho = Math.max(CAMA_MM, Math.max(...medidas.map(m => m[0])), Math.sqrt(area) * 1.15)
  const orden = medidas.map((m, i) => i).sort((a, b) => medidas[b][1] - medidas[a][1])
  let x = 0, y = 0, fila = 0
  for (const i of orden) {
    const [dx, dy] = medidas[i]
    if (x > 0 && x + dx > ancho) { x = 0; y += fila + SEP; fila = 0 }
    const [desde, hasta, lo] = rangos[i]
    for (let v = desde; v < hasta; v++) {
      verts[v][0] += x - lo[0]
      verts[v][1] += y - lo[1]
      verts[v][2] -= lo[2]
    }
    x += dx + SEP
    fila = Math.max(fila, dy)
  }
}

function bboxDe(verts) {
  let minX=Infinity,minY=Infinity,minZ=Infinity,maxX=-Infinity,maxY=-Infinity,maxZ=-Infinity
  for (const [x,y,z] of verts) {
    if(x<minX)minX=x; if(x>maxX)maxX=x
    if(y<minY)minY=y; if(y>maxY)maxY=y
    if(z<minZ)minZ=z; if(z>maxZ)maxZ=z
  }
  return {minX,minY,minZ,maxX,maxY,maxZ}
}

function mallaAModelXML(verts, tris) {
  const partes = [`<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <resources>
  <object id="1" p:UUID="00010000-81cb-4c03-9d28-80fed5dfa1dc" type="model">
   <mesh>
    <vertices>`]
  for (const [x,y,z] of verts) partes.push(`     <vertex x="${x.toFixed(6)}" y="${y.toFixed(6)}" z="${z.toFixed(6)}"/>`)
  partes.push('    </vertices>\n    <triangles>')
  for (const [v1,v2,v3] of tris) partes.push(`     <triangle v1="${v1}" v2="${v2}" v3="${v3}"/>`)
  partes.push('    </triangles>\n   </mesh>\n  </object>\n </resources>\n</model>')
  return partes.join('\n')
}

// ── Cama: la A1 mide 256 mm. Un modelo más grande hay que cortarlo en partes ──
// Para COTIZARLO sin cortarlo se lamina en una "cama virtual" más grande: el
// filamento y el tiempo son prácticamente los mismos que sumando las partes.
const CAMA_MM = 256
const UTIL_MM = 240          // lo que de verdad se aprovecha por parte (márgenes, conectores)

function infoExcede(dimX, dimY, dimZ) {
  if (dimX <= CAMA_MM && dimY <= CAMA_MM && dimZ <= CAMA_MM) return null
  const partes = Math.ceil(dimX / UTIL_MM) * Math.ceil(dimY / UTIL_MM) * Math.ceil(dimZ / UTIL_MM)
  return { dimX: Math.round(dimX), dimY: Math.round(dimY), dimZ: Math.round(dimZ), cama: CAMA_MM, partes: Math.max(2, partes) }
}

// ── Preparar 3MF para laminar (STL, OBJ o 3MF directo) ───────────────────────
// callback(err, archivo, excede): excede = null si cabe, o {dimX, dimY, dimZ, cama, partes}
// opciones.leerGeometria: 3MF que el motor no pudo leer → se arma con su geometría
// opciones.unidadesAuto = false: el archivo ya viene en mm (STL exportado por el visor 3D)
function prepararArchivo(filePath, scalePct, callback, printer, opciones) {
  const ext = path.extname(filePath).toLowerCase()
  const { leerGeometria = false, unidadesAuto = true } = opciones || {}

  if (ext === '.3mf' && !leerGeometria) {
    // Primero tal cual: así se respetan sus colores, placas y ajustes
    callback(null, filePath, null)
    return
  }

  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true })
  const temp3MF = path.join(TEMP_DIR, 'modelo_cliente.3mf')

  try {
    const zip = new AdmZip(getPlantilla(printer))
    const malla = ext === '.3mf' ? tresMFAMalla(filePath, scalePct)
      : prepararMalla(filePath, ext, scalePct, unidadesAuto)
    const bbox = bboxDe(malla.verts)
    const dimX = bbox.maxX-bbox.minX, dimY = bbox.maxY-bbox.minY, dimZ = bbox.maxZ-bbox.minZ
    // Un 3MF puede traer varias piezas repartidas en varias placas: lo que debe caber en
    // la cama es cada pieza, no todo el proyecto junto.
    const piezas = malla.medidas || [[dimX, dimY, dimZ]]
    const excede = piezas.map(([x, y, z]) => infoExcede(x, y, z)).filter(Boolean)
      .reduce((peor, e) => (!peor || e.partes > peor.partes ? e : peor), null)
    const noCabeJunto = dimX > CAMA_MM || dimY > CAMA_MM || dimZ > CAMA_MM
    zip.updateFile('3D/Objects/object_1.model', Buffer.from(mallaAModelXML(malla.verts, malla.tris), 'utf8'))

    // Cama virtual si no cabe (solo para cotizar)
    let cama = CAMA_MM
    if (noCabeJunto) {
      cama = Math.ceil((Math.max(dimX, dimY) + 40) / 50) * 50
      const alto = Math.max(CAMA_MM, Math.ceil((dimZ + 20) / 50) * 50)
      const cfgEntry = zip.getEntry('Metadata/project_settings.config')
      const cfgProyecto = JSON.parse(cfgEntry.getData().toString('utf8'))
      cfgProyecto.printable_area = ['0x0', `${cama}x0`, `${cama}x${cama}`, `0x${cama}`]
      cfgProyecto.printable_height = String(alto)
      cfgProyecto.extruder_clearance_height_to_lid = String(alto)
      cfgProyecto.bed_exclude_area = []
      zip.updateFile('Metadata/project_settings.config', Buffer.from(JSON.stringify(cfgProyecto, null, 4), 'utf8'))
      console.log(`[Brumet] ${Math.round(dimX)}x${Math.round(dimY)}x${Math.round(dimZ)} mm en total: cotizado en cama virtual de ${cama} mm` +
        (excede ? ` (una pieza no cabe: ~${excede.partes} partes)` : ` (${piezas.length} piezas, cada una cabe)`))
    }

    const {minX,maxX,minY,maxY,minZ} = bbox
    const mitad = cama / 2
    const cx = mitad-(minX+maxX)/2, cy = mitad-(minY+maxY)/2, cz = -minZ
    const transform = `1 0 0 0 1 0 0 0 1 ${cx.toFixed(4)} ${cy.toFixed(4)} ${cz.toFixed(4)}`

    const mainEntry = zip.getEntry('3D/3dmodel.model')
    if (mainEntry) {
      let mainContent = mainEntry.getData().toString('utf8')
      mainContent = mainContent.replace(/(<component[^>]*)\s+transform="[^"]*"/, '$1 transform="1 0 0 0 1 0 0 0 1 0 0 0"')
      mainContent = mainContent.replace(/(<item[^>]*)\s+transform="[^"]*"/, `$1 transform="${transform}"`)
      zip.updateFile('3D/3dmodel.model', Buffer.from(mainContent, 'utf8'))
    }
    const plate1Entry = zip.getEntry('Metadata/plate_1.json')
    if (plate1Entry) {
      const plate1 = JSON.parse(plate1Entry.getData().toString('utf8'))
      const bboxX1=parseFloat((minX+cx).toFixed(5)), bboxY1=parseFloat((minY+cy).toFixed(5))
      const bboxX2=parseFloat((maxX+cx).toFixed(5)), bboxY2=parseFloat((maxY+cy).toFixed(5))
      plate1.bbox_all=[bboxX1,bboxY1,bboxX2,bboxY2]
      if (plate1.bbox_objects && plate1.bbox_objects[0]) {
        plate1.bbox_objects[0].bbox=[bboxX1,bboxY1,bboxX2,bboxY2]
        plate1.bbox_objects[0].name=path.basename(filePath)
      }
      zip.updateFile('Metadata/plate_1.json', Buffer.from(JSON.stringify(plate1), 'utf8'))
    }
    zip.writeZip(temp3MF)
    callback(null, temp3MF, excede)
  } catch(e) {
    callback(e.usuario ? e.message : 'Error preparando archivo: ' + e.message)
  }
}

// Traduce los errores del motor a mensajes claros. Se basa en el código
// numérico y en palabras clave (no en la frase exacta), para que una versión
// futura de BambuStudio que cambie la redacción no rompa la detección.
function explicarErrorBambu(result, filePath) {
  const msg  = String(result.error_string || '').trim()
  const code = result.return_code
  const es3MF = path.extname(filePath).toLowerCase() === '.3mf'
  const detalle = ` (Detalle técnico: ${msg || 'sin mensaje'} · código ${code})`

  if (code === -50 || /plate/i.test(msg) && /empty|inside|outside/i.test(msg)) {
    return es3MF
      ? 'Este proyecto 3MF tiene la cama vacía o una pieza que se sale de la cama. Ábrelo en Bambu Studio, deja la pieza completa dentro de la cama (o expórtala como STL) y vuelve a cotizar.' + detalle
      : 'El motor de laminado no encontró nada imprimible en la pieza. Suele pasar cuando el archivo es una superficie sin grosor (logos o textos exportados en 2D) o está dañado: ábrelo en el programa de diseño, dale grosor, expórtalo de nuevo como STL y vuelve a cotizar.' + detalle
  }

  if (/layer|nothing to print|no extrusion|empty/i.test(msg))
    return 'El motor no generó capas para imprimir: la pieza es demasiado pequeña o delgada. Agrándala con "Ver en 3D" → Escalar y vuelve a cotizar.' + detalle

  return 'El motor de laminado no pudo procesar este modelo.' + detalle
}

function formatTiempo(segundosTotales) {
  const h = Math.floor(segundosTotales / 3600)
  const m = Math.floor((segundosTotales % 3600) / 60)
  const s = Math.floor(segundosTotales % 60)
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`
}

// ── Cancelación ───────────────────────────────────────────────────────────────
let procActual = null
let cancelado  = false

function cancelarLaminado() {
  cancelado = true
  if (procActual) { try { procActual.kill() } catch(e) {} }
}

// Un 3MF se intenta primero tal cual (respeta colores y placas). Si el motor no lo
// entiende o se queda pegado, se cotiza con su geometría: así ninguna actualización
// de Bambu Studio vuelve a dejar a la app sin poder cotizar.
const TIMEOUT_3MF_DIRECTO_MS = 3 * 60 * 1000

function laminarConBambu(filePath, scalePct, callback, printer, opciones) {
  const es3MF = path.extname(filePath).toLowerCase() === '.3mf'
  const leerGeometria = !!(opciones && opciones.leerGeometria)
  prepararArchivo(filePath, scalePct, (err, archivoFinal, excede) => {
    if (err) return callback(err)

    const resultPath = path.join(OUTPUT_DIR, 'result.json')
    if (fs.existsSync(resultPath)) fs.unlinkSync(resultPath)
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })

    let terminado = false
    const terminar = (e, r) => { if (!terminado) { terminado = true; callback(e, r) } }
    const directo3MF = es3MF && !leerGeometria
    const plan_b = (motivo) => {
      console.log(`[Brumet] El motor no pudo con el 3MF (${motivo}); se cotiza con su geometría`)
      terminado = true
      laminarConBambu(filePath, scalePct, callback, printer, { ...opciones, leerGeometria: true })
    }

    cancelado = false
    const proc = spawn(BAMBU_EXE, ['--slice', '1', '--outputdir', OUTPUT_DIR, archivoFinal])
    procActual = proc
    let stderr = ''
    proc.stdout.on('data', () => {})           // drenar stdout para evitar bloqueo en Windows
    proc.stderr.on('data', d => stderr += d.toString())

    // Timeout de seguridad: si BambuStudio cuelga, matar el proceso
    const timer = setTimeout(() => {
      try { proc.kill() } catch(e) {}
      if (directo3MF) return plan_b('se demoró demasiado')
      terminar('BambuStudio tardó más de 10 minutos. Intenta con un modelo más simple.')
    }, directo3MF ? TIMEOUT_3MF_DIRECTO_MS : SLICE_TIMEOUT_MS)

    proc.on('close', (code) => {
      clearTimeout(timer)
      procActual = null
      if (terminado) return
      if (cancelado) return terminar('CANCELADO')
      if (!fs.existsSync(resultPath)) {
        if (directo3MF) return plan_b('no generó result.json')
        return terminar('BambuStudio no generó result.json. ' + stderr)
      }
      try {
        const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
        if (result.return_code !== 0) {
          // Pasa con los 3MF de versiones nuevas de Bambu Studio ("Unsupported 3MF version")
          if (directo3MF) return plan_b(result.error_string || `código ${result.return_code}`)
          return terminar(explicarErrorBambu(result, filePath))
        }

        const plates = result.sliced_plates || []
        if (plates.length === 0) return terminar('No se encontraron camas en el resultado')

        // Procesar todas las camas
        const camasData = plates.map((plate, idx) => {
          // Campos opcionales con valor por defecto: si una versión futura del
          // motor omite alguno, la cotización no revienta
          const gramos = (plate.filaments || []).reduce((s, f) => s + (Number(f.total_used_g) || 0), 0)
          const segs   = Number(plate.main_predication) || 0
          const horas  = segs / 3600
          return {
            cama:   idx + 1,
            tiempo: formatTiempo(segs),
            horas:  horas.toFixed(2),
            gramos: gramos.toFixed(2)
          }
        })

        const totalGramos = camasData.reduce((s, c) => s + parseFloat(c.gramos), 0)
        const totalHoras  = camasData.reduce((s, c) => s + parseFloat(c.horas), 0)

        terminar(null, {
          camas:      camasData,
          multiCama:  camasData.length > 1,
          // compatibilidad con código anterior (primera cama)
          tiempo:     camasData[0].tiempo,
          horas:      totalHoras.toFixed(2),
          gramos:     totalGramos.toFixed(2),
          excede,                                    // null o {dimX, dimY, dimZ, cama, partes}
          desdeGeometria: es3MF && !!leerGeometria   // 3MF cotizado con su geometría (perfil y color de la app)
        })
      } catch(e) {
        terminar('Error leyendo result.json: ' + e.message)
      }
    })
  }, printer, opciones)
}

// Modelo cortado en el visor: una pieza (o grupo de piezas) por cama. Se
// laminan una tras otra y se suman como un resultado de varias camas.
// Las partes salen del visor ya en mm: no se re-detectan unidades.
function laminarPartes(archivos, callback, printer) {
  const camas = []
  const siguiente = (k) => {
    if (k >= archivos.length) {
      const totalGramos = camas.reduce((s, c) => s + parseFloat(c.gramos), 0)
      const totalHoras  = camas.reduce((s, c) => s + parseFloat(c.horas), 0)
      return callback(null, {
        camas,
        multiCama: camas.length > 1,
        tiempo:    formatTiempo(totalHoras * 3600),
        horas:     totalHoras.toFixed(2),
        gramos:    totalGramos.toFixed(2),
        excede:    null
      })
    }
    laminarConBambu(archivos[k], 100, (err, r) => {
      if (err) return callback(err === 'CANCELADO' ? err : `Cama ${k + 1} de ${archivos.length}: ${err}`)
      for (const c of r.camas) camas.push({ ...c, cama: camas.length + 1 })
      siguiente(k + 1)
    }, printer, { unidadesAuto: false })
  }
  siguiente(0)
}

module.exports = { laminarConBambu, laminarPartes, cancelarLaminado }
