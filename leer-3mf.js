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
    const malla = cuerpo.match(/<mesh>([\s\S]*?)<\/mesh>/)
    if (malla) {
      obj.verts = []
      obj.tris = []
      const reV = /<vertex\b[^>]*?\bx="([^"]+)"[^>]*?\by="([^"]+)"[^>]*?\bz="([^"]+)"/g
      let v
      while ((v = reV.exec(malla[1])) !== null) obj.verts.push([+v[1] * factor, +v[2] * factor, +v[3] * factor])
      const reT = /<triangle\b[^>]*?\bv1="(\d+)"[^>]*?\bv2="(\d+)"[^>]*?\bv3="(\d+)"/g
      let t
      while ((t = reT.exec(malla[1])) !== null) obj.tris.push([+t[1], +t[2], +t[3]])
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

// Devuelve { verts, tris, piezas, medidas } en milímetros, con las piezas donde las dejó el usuario.
function geometriaDe3MF(ruta) {
  const zip = new AdmZip(ruta)
  const archivos = new Map()
  for (const e of zip.getEntries()) {
    if (/\.model$/i.test(e.entryName)) archivos.set('/' + e.entryName.replace(/^\/+/, ''), e.getData().toString('utf8'))
  }
  const principalNombre = [...archivos.keys()].find(k => /^\/3D\/3dmodel\.model$/i.test(k)) || [...archivos.keys()][0]
  if (!principalNombre) throw new Error('el 3MF no trae ningún modelo')
  const cache = new Map()
  const objetosDe = nombre => {
    if (!cache.has(nombre)) cache.set(nombre, leerObjetos(archivos.get(nombre) || ''))
    return cache.get(nombre)
  }
  const principal = archivos.get(principalNombre)
  const verts = [], tris = []
  let piezas = 0
  const medidas = []   // [ancho, fondo, alto] de cada pieza: lo que debe caber en la cama es CADA pieza
  const rangos = []    // [primer vértice, último+1, esquina mínima] de cada pieza (para reacomodarlas)

  function agregar(archivo, id, m, profundidad) {
    if (profundidad > 8) return
    const obj = objetosDe(archivo).get(id)
    if (!obj || obj.tipo === 'support' || obj.tipo === 'other') return
    if (obj.verts) {
      const base = verts.length
      for (const p of obj.verts) verts.push(aplicar(m, p))
      for (const [a, b, c] of obj.tris) tris.push([a + base, b + base, c + base])
    }
    for (const comp of obj.componentes) {
      const otro = comp.ruta ? '/' + comp.ruta.replace(/^\/+/, '') : archivo
      agregar(otro, comp.id, componer(comp.transform, m), profundidad + 1)
    }
  }

  const build = principal.match(/<build\b[^>]*>([\s\S]*?)<\/build>/)
  const reItem = /<item\b([^>]*)\/?>/g
  let it
  while (build && (it = reItem.exec(build[1])) !== null) {
    const a = atributos(it[1])
    if (a.printable === '0') continue
    const desde = verts.length
    agregar(principalNombre, a.objectid, matriz(a.transform), 0)
    if (verts.length === desde) continue
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (let i = desde; i < verts.length; i++) for (let k = 0; k < 3; k++) {
      if (verts[i][k] < lo[k]) lo[k] = verts[i][k]
      if (verts[i][k] > hi[k]) hi[k] = verts[i][k]
    }
    medidas.push([hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]])
    rangos.push([desde, verts.length, lo])
    piezas++
  }
  if (tris.length === 0) throw new Error('el 3MF no trae piezas con malla')
  return { verts, tris, piezas, medidas, rangos }
}

module.exports = { geometriaDe3MF }
