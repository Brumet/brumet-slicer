// ── Corte de modelos con un plano (como la herramienta "Cortar" de Bambu Studio) ──
// Recibe una malla (sopa de triángulos) y la parte en dos con un plano
// perpendicular a un eje. Cada parte sale cerrada: la cara cortada se tapa
// con una "tapa" triangulada, para que BambuStudio la lamine como sólido.
//
// Trabaja en coordenadas del visor (Y es la altura). No depende del DOM, así
// que se puede probar con node.

const EPS_KEY = 1e-4  // mm: puntos más cercanos que esto se consideran el mismo

function claveP(p) {
  return Math.round(p[0] / EPS_KEY) + '_' + Math.round(p[1] / EPS_KEY) + '_' + Math.round(p[2] / EPS_KEY)
}

// Punto donde la arista a-b cruza el plano. Se calcula siempre en el mismo
// orden de extremos para que los dos triángulos que comparten la arista den
// exactamente el mismo punto (si no, la tapa no cierra).
function interseccion(a, da, b, db) {
  if (claveP(a) > claveP(b)) { const t = a; a = b; b = t; const td = da; da = db; db = td }
  const t = da / (da - db)
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

// Recorta un triángulo y se queda con el lado indicado (signo +1 o -1).
// Devuelve el polígono resultante (0, 3 o 4 vértices) conservando el sentido.
function recortar(pts, ds, signo) {
  const out = []
  for (let i = 0; i < 3; i++) {
    const a = pts[i], b = pts[(i + 1) % 3]
    const da = ds[i] * signo, db = ds[(i + 1) % 3] * signo
    const aDentro = da >= 0, bDentro = db >= 0
    if (aDentro) out.push(a)
    if (aDentro !== bDentro) out.push(interseccion(a, ds[i], b, ds[(i + 1) % 3]))
  }
  return out
}

// Une segmentos sueltos del corte en contornos cerrados.
function armarContornos(segmentos) {
  const puntos = new Map()   // clave → punto
  const vecinos = new Map()  // clave → [claves]
  for (const [p, q] of segmentos) {
    const kp = claveP(p), kq = claveP(q)
    if (kp === kq) continue
    puntos.set(kp, p); puntos.set(kq, q)
    if (!vecinos.has(kp)) vecinos.set(kp, [])
    if (!vecinos.has(kq)) vecinos.set(kq, [])
    vecinos.get(kp).push(kq)
    vecinos.get(kq).push(kp)
  }
  const usadas = new Set()
  const arista = (a, b) => a < b ? a + '|' + b : b + '|' + a
  const contornos = []
  for (const inicio of vecinos.keys()) {
    for (const sig0 of vecinos.get(inicio)) {
      if (usadas.has(arista(inicio, sig0))) continue
      const loop = [inicio]
      let prev = inicio, cur = sig0
      usadas.add(arista(prev, cur))
      let guardia = 0
      while (cur !== inicio && guardia++ < 1e6) {
        loop.push(cur)
        const sig = vecinos.get(cur).find(n => !usadas.has(arista(cur, n)))
        if (sig === undefined) break
        usadas.add(arista(cur, sig))
        prev = cur; cur = sig
      }
      if (cur === inicio && loop.length >= 3) contornos.push(loop.map(k => puntos.get(k)))
    }
  }
  return contornos
}

function areaFirmada(c) {
  let a = 0
  for (let i = 0; i < c.length; i++) {
    const p = c[i], q = c[(i + 1) % c.length]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

function puntoDentro(pt, poly) {
  let dentro = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j]
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) dentro = !dentro
  }
  return dentro
}

// Triangula la tapa a partir de los contornos del corte (con huecos, p. ej. un
// tubo cortado da un anillo). Devuelve triángulos [p,q,r] en 3D.
function triangularTapa(THREE, contornos, eje, valor) {
  const [iu, iv] = [[1, 2], [0, 2], [0, 1]][eje]
  const polys = contornos.map(c => c.map(p => new THREE.Vector2(p[iu], p[iv])))
    .filter(p => Math.abs(areaFirmada(p)) > 1e-6)
  // Profundidad de anidamiento: par = contorno exterior, impar = hueco
  const prof = polys.map((p, i) => polys.reduce((n, q, j) => n + (j !== i && puntoDentro(p[0], q) ? 1 : 0), 0))
  const tris = []
  const a3 = v => { const p = [0, 0, 0]; p[eje] = valor; p[iu] = v.x; p[iv] = v.y; return p }
  polys.forEach((ext, i) => {
    if (prof[i] % 2 !== 0) return
    // Huecos directos de este contorno: dentro de él y un nivel más profundos
    const huecos = polys.filter((h, j) => prof[j] === prof[i] + 1 && puntoDentro(h[0], ext))
    const caras = THREE.ShapeUtils.triangulateShape(ext, huecos)
    const todos = ext.concat(...huecos)
    for (const [a, b, c] of caras) tris.push([a3(todos[a]), a3(todos[b]), a3(todos[c])])
  })
  return tris
}

function normal(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]
}

// Corta la geometría (THREE.BufferGeometry no indexada) con el plano
// coord[eje] = valor. Devuelve { positiva, negativa } como Float32Array de
// posiciones (null si una parte queda vacía) y cuántos contornos tuvo la tapa.
function cortarMalla(THREE, geo, eje, valor) {
  const pos = geo.attributes.position.array
  // Correr el plano una fracción de micra evita vértices justo sobre él
  // (típico en modelos con medidas redondas), que dejan la tapa abierta.
  valor += 1.3e-5
  const lados = { 1: [], '-1': [] }
  const segmentos = []
  for (let i = 0; i < pos.length; i += 9) {
    const pts = [[pos[i], pos[i + 1], pos[i + 2]], [pos[i + 3], pos[i + 4], pos[i + 5]], [pos[i + 6], pos[i + 7], pos[i + 8]]]
    const ds = pts.map(p => p[eje] - valor)
    const pos_ = ds.filter(d => d >= 0).length
    if (pos_ === 3) { lados[1].push(...pts.flat()); continue }
    if (pos_ === 0) { lados[-1].push(...pts.flat()); continue }
    for (const signo of [1, -1]) {
      const poly = recortar(pts, ds, signo)
      for (let k = 1; k < poly.length - 1; k++) lados[signo].push(...poly[0], ...poly[k], ...poly[k + 1])
    }
    // Segmento del corte: los dos puntos donde el triángulo cruza el plano
    const cruces = []
    for (let k = 0; k < 3; k++) {
      const a = (k + 1) % 3
      if ((ds[k] >= 0) !== (ds[a] >= 0)) cruces.push(interseccion(pts[k], ds[k], pts[a], ds[a]))
    }
    if (cruces.length === 2) segmentos.push(cruces)
  }

  const contornos = armarContornos(segmentos)
  const tapa = triangularTapa(THREE, contornos, eje, valor)
  // La tapa de la parte positiva mira hacia -eje y la de la negativa hacia +eje
  for (const [a, b, c] of tapa) {
    const n = normal(a, b, c)[eje]
    const haciaMenos = n < 0 ? [a, b, c] : [a, c, b]
    const haciaMas   = n < 0 ? [a, c, b] : [a, b, c]
    lados[1].push(...haciaMenos.flat())
    lados[-1].push(...haciaMas.flat())
  }
  const arr = a => a.length ? new Float32Array(a) : null
  return { positiva: arr(lados[1]), negativa: arr(lados[-1]), contornos: contornos.length }
}

module.exports = { cortarMalla }
