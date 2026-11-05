// ── Sacar la geometría de un 3MF, de CUALQUIER versión de Bambu Studio ───────
// El motor que trae la app es una versión fija de Bambu Studio. Cada vez que Bambu
// actualiza su programa, los 3MF nuevos cambian de "versión" y el motor viejo los
// rechaza ("Unsupported 3MF version"). Pero la geometría (vértices y triángulos)
// sigue en el formato estándar 3MF de siempre. Aquí se lee esa geometría a mano,
// con sus posiciones, para cotizarla con la plantilla de la app: así una
// actualización de Bambu ya no deja a la app sin poder cotizar.
const AdmZip = require('adm-zip')

function atributos(tag) {
  const a = {}
  const re = /([\w:]+)="([^"]*)"/g
  let m
  while ((m = re.exec(tag)) !== null) a[m[1]] = m[2]
  return a
}

// Matriz 3MF "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32" (fila: x' = x*m00 + y*m10 + z*m20 + m30)
function matriz(texto) {
  if (!texto) return [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
  const v = texto.trim().split(/\s+/).map(Number)
  return v.length === 12 && v.every(n => isFinite(n)) ? v : [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
}

function componer(a, b) {
  // primero a, luego b
  const r = new Array(12)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]
  }
  for (let j = 0; j < 3; j++) r[9 + j] = a[9] * b[j] + a[10] * b[3 + j] + a[11] * b[6 + j] + b[9 + j]
  return r
}

function aplicar(m, [x, y, z]) {
  return [x * m[0] + y * m[3] + z * m[6] + m[9], x * m[1] + y * m[4] + z * m[7] + m[10], x * m[2] + y * m[5] + z * m[8] + m[11]]
}

// Unidades del 3MF → milímetros
const UNIDADES = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 }

// Cuenta cuántas veces aparece `aguja` (para reservar la memoria justa de una vez)
function contar(texto, aguja) {
  let n = 0, i = -1
  while ((i = texto.indexOf(aguja, i + 1)) !== -1) n++
  return n
}

// Las mallas se guardan en arreglos numéricos compactos: un proyecto de Bambu puede traer
// millones de triángulos y en arreglos normales se acaba la memoria (se colgaba la app).
function leerObjetos(xml) {
  const unidad = (xml.match(/<model[^>]*\bunit="([^"]+)"/) || [])[1] || 'millimeter'
  const factor = UNIDADES[unidad] || 1
  const objetos = new Map()
  const reObj = /<object\b([^>]*)>([\s\S]*?)<\/object>/g
  let m
  while ((m = reObj.exec(xml)) !== null) {
    const attr = atributos(m[1])
    const cuerpo = m[2]
    const obj = { verts: null, tris: null, componentes: [], tipo: attr.type || 'model' }
    const ini = cuerpo.indexOf('<mesh>'), fin = cuerpo.indexOf('</mesh>')
    if (ini !== -1 && fin > ini) {
      const malla = cuerpo.slice(ini, fin)
      const verts = new Float64Array(contar(malla, '<vertex') * 3)
      const tris = new Uint32Array(contar(malla, '<triangle') * 3)
      const reV = /<vertex\b[^>]*?\bx="([^"]+)"[^>]*?\by="([^"]+)"[^>]*?\bz="([^"]+)"/g
      let v, k = 0
      while ((v = reV.exec(malla)) !== null && k < verts.length) {
        verts[k++] = +v[1] * factor; verts[k++] = +v[2] * factor; verts[k++] = +v[3] * factor
      }
      const reT = /<triangle\b[^>]*?\bv1="(\d+)"[^>]*?\bv2="(\d+)"[^>]*?\bv3="(\d+)"/g
      let t, j = 0
      while ((t = reT.exec(malla)) !== null && j < tris.length) { tris[j++] = +t[1]; tris[j++] = +t[2]; tris[j++] = +t[3] }
      obj.verts = k === verts.length ? verts : verts.slice(0, k)
      obj.tris = j === tris.length ? tris : tris.slice(0, j)
    }
    const reC = /<component\b([^>]*)\/?>/g
    let c
    while ((c = reC.exec(cuerpo)) !== null) {
      const ca = atributos(c[1])
      obj.componentes.push({ id: ca.objectid, ruta: ca['p:path'] || null, transform: matriz(ca.transform) })
    }
    objetos.set(attr.id, obj)
  }
  return objetos
}

// Para cotizar no hace falta una malla de millones de triángulos (y el motor tardaría horas):
// por encima de este número se simplifica juntando los puntos que caen en la misma "celda"
// de unas décimas de milímetro. El volumen (gramos) y la altura (tiempo) casi no cambian.
const LIMITE_TRIANGULOS = 1500000

// Devuelve { verts, tris, piezas, medidas, rangos, simplificado } en milímetros, con las piezas donde las dejó el usuario.
function geometriaDe3MF(ruta) {
  const zip = new AdmZip(ruta)
  const entradas = new Map()
  for (const e of zip.getEntries()) {
    if (/\.model$/i.test(e.entryName)) entradas.set('/' + e.entryName.replace(/^\/+/, ''), e)
  }
  const principalNombre = [...entradas.keys()].find(k => /^\/3D\/3dmodel\.model$/i.test(k)) || [...entradas.keys()][0]
  if (!principalNombre) throw new Error('el 3MF no trae ningún modelo')
  const cache = new Map()
  let multicolor = false
  const objetosDe = nombre => {
    if (!cache.has(nombre)) {
      const e = entradas.get(nombre)
      const texto = e ? e.getData().toString('utf8') : ''
      // Pintado a colores (o segmentado por colores): sin el motor no se puede contar el purgado
      if (texto.indexOf('paint_color=') !== -1 || texto.indexOf('mmu_segmentation') !== -1) multicolor = true
      cache.set(nombre, leerObjetos(texto))   // el texto se suelta al terminar
    }
    return cache.get(nombre)
  }
  const principal = entradas.get(principalNombre).getData().toString('utf8')

  // 1) Qué mallas van y dónde (sin copiar nada todavía)
  const items = []   // por pieza: [{ obj, m }]
  function juntar(archivo, id, m, profundidad, lista) {
    if (profundidad > 8) return
    const obj = objetosDe(archivo).get(id)
    if (!obj || obj.tipo === 'support' || obj.tipo === 'other') return
    if (obj.verts && obj.tris.length) lista.push({ obj, m })
    for (const comp of obj.componentes) {
      const otro = comp.ruta ? '/' + comp.ruta.replace(/^\/+/, '') : archivo
      juntar(otro, comp.id, componer(comp.transform, m), profundidad + 1, lista)
    }
  }
  const build = principal.match(/<build\b[^>]*>([\s\S]*?)<\/build>/)
  const reItem = /<item\b([^>]*)\/?>/g
  let it
  while (build && (it = reItem.exec(build[1])) !== null) {
    const a = atributos(it[1])
    if (a.printable === '0') continue
    const lista = []
    juntar(principalNombre, a.objectid, matriz(a.transform), 0, lista)
    if (lista.length) items.push(lista)
  }
  const total = items.reduce((s, l) => s + l.reduce((t, x) => t + x.obj.tris.length / 3, 0), 0)
  if (total === 0) throw new Error('el 3MF no trae piezas con malla')

  // 2) Armar la malla final (simplificada si es gigante). El tamaño de celda sale del área de la
  //    superficie: con celdas de lado c quedan unos área/c² puntos (≈ la mitad de triángulos).
  let celda = 0
  if (total > LIMITE_TRIANGULOS) {
    let area = 0
    for (const lista of items) for (const { obj, m } of lista) {
      const escala = Math.cbrt(Math.abs(m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]))) || 1
      const v = obj.verts, t = obj.tris
      for (let j = 0; j < t.length; j += 3) {
        const a = t[j] * 3, b = t[j + 1] * 3, c = t[j + 2] * 3
        const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2]
        const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2]
        area += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2 * escala * escala
      }
    }
    celda = Math.max(0.05, Math.sqrt(area / (LIMITE_TRIANGULOS * 0.45)))
  }
  for (;;) {
    const r = armar(items, celda)
    if (r.tris.length <= LIMITE_TRIANGULOS * 1.2 || celda === 0 || celda > 3) {
      r.simplificado = celda > 0 ? { antes: total, despues: r.tris.length, celda } : null
      r.multicolor = multicolor || extrusoresUsados(zip) > 1
      return r
    }
    celda *= 1.5
  }
}

function armar(items, celda) {
  const verts = [], tris = [], medidas = [], rangos = []
  for (const lista of items) {
    const desde = verts.length
    const indice = celda ? new Map() : null
    const vistos = celda ? new Set() : null
    for (const { obj, m } of lista) {
      const n = obj.verts.length / 3
      const mapa = new Uint32Array(n)
      for (let i = 0; i < n; i++) {
        const p = aplicar(m, [obj.verts[i * 3], obj.verts[i * 3 + 1], obj.verts[i * 3 + 2]])
        if (!celda) { mapa[i] = verts.length; verts.push(p); continue }
        const clave = (Math.round(p[0] / celda) + 32768) * 4294967296 + (Math.round(p[1] / celda) + 32768) * 65536 + (Math.round(p[2] / celda) + 32768)
        let k = indice.get(clave)
        if (k === undefined) { k = verts.length; verts.push(p); indice.set(clave, k) }
        mapa[i] = k
      }
      const t = obj.tris
      for (let j = 0; j < t.length; j += 3) {
        const a = mapa[t[j]], b = mapa[t[j + 1]], c = mapa[t[j + 2]]
        if (celda) {
          if (a === b || b === c || a === c) continue
          const clave = a < b ? (b < c ? a + '_' + b + '_' + c : a < c ? a + '_' + c + '_' + b : c + '_' + a + '_' + b)
            : (a < c ? b + '_' + a + '_' + c : b < c ? b + '_' + c + '_' + a : c + '_' + b + '_' + a)
          if (vistos.has(clave)) continue
          vistos.add(clave)
        }
        tris.push([a, b, c])
      }
    }
    if (verts.length === desde) continue
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (let i = desde; i < verts.length; i++) for (let k = 0; k < 3; k++) {
      if (verts[i][k] < lo[k]) lo[k] = verts[i][k]
      if (verts[i][k] > hi[k]) hi[k] = verts[i][k]
    }
    medidas.push([hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]])
    rangos.push([desde, verts.length, lo])
  }
  return { verts, tris, piezas: medidas.length, medidas, rangos }
}

// Cuántos filamentos distintos usan las piezas del proyecto (model_settings.config)
function extrusoresUsados(zip) {
  try {
    const e = zip.getEntry('Metadata/model_settings.config')
    if (!e) return 1
    const usados = new Set()
    const re = /key="extruder"\s+value="(\d+)"/g
    let m
    const t = e.getData().toString('utf8')
    while ((m = re.exec(t)) !== null) usados.add(m[1])
    return Math.max(1, usados.size)
  } catch(e) { return 1 }
}

module.exports = { geometriaDe3MF }
