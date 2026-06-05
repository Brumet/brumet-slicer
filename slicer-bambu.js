const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const AdmZip = require('adm-zip')

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
const PLANTILLA_3MF = path.join(__dirname, 'perfiles', 'elevador_config.3mf')
const TEMP_DIR = path.join(require('os').homedir(), 'AppData', 'Roaming', 'Brumet Slicer', 'temp')
const OUTPUT_DIR = TEMP_DIR

function esSTLAscii(buf) {
  const inicio = buf.slice(0, 256).toString('utf8')
  return inicio.trimStart().startsWith('solid') && inicio.includes('facet normal')
}

function calcularEscala(bboxMax) {
  if (bboxMax < 0.1) {
    console.log('[Brumet] Metros detectados escalando x1000')
    return 1000
  }
  if (bboxMax < 2) {
    console.log('[Brumet] Pulgadas pequenas detectadas escalando x25.4')
    return 25.4
  }
  if (bboxMax < 25) {
    console.log('[Brumet] Pulgadas detectadas escalando x25.4')
    return 25.4
  }
  console.log('[Brumet] Milimetros correctos sin cambio')
  return 1
}

function bboxDeSTLAscii(texto) {
  let minX=Infinity,minY=Infinity,minZ=Infinity
  let maxX=-Infinity,maxY=-Infinity,maxZ=-Infinity
  const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g
  let m
  while ((m = re.exec(texto)) !== null) {
    const x=parseFloat(m[1]),y=parseFloat(m[2]),z=parseFloat(m[3])
    if(x<minX)minX=x; if(x>maxX)maxX=x
    if(y<minY)minY=y; if(y>maxY)maxY=y
    if(z<minZ)minZ=z; if(z>maxZ)maxZ=z
  }
  return {minX,minY,minZ,maxX,maxY,maxZ}
}

function bboxDeSTLBinario(buf, escala) {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const dv = new DataView(ab)
  const faceCount = dv.getUint32(80, true)
  let minX=Infinity,minY=Infinity,minZ=Infinity
  let maxX=-Infinity,maxY=-Infinity,maxZ=-Infinity
  let off = 84
  for (let i=0; i<faceCount; i++) {
    off += 12
    for (let j=0; j<3; j++) {
      const x=dv.getFloat32(off,true)*escala
      const y=dv.getFloat32(off+4,true)*escala
      const z=dv.getFloat32(off+8,true)*escala
      if(x<minX)minX=x; if(x>maxX)maxX=x
      if(y<minY)minY=y; if(y>maxY)maxY=y
      if(z<minZ)minZ=z; if(z>maxZ)maxZ=z
      off += 12
    }
    off += 2
  }
  return {minX,minY,minZ,maxX,maxY,maxZ}
}

function stlToModelXML(stlPath, scalePct) {
  const buf = fs.readFileSync(stlPath)
  const escalaUsuario = (scalePct || 100) / 100
  let verts = []
  let tris = []

  if (esSTLAscii(buf)) {
    const texto = buf.toString('utf8')
    const bbox = bboxDeSTLAscii(texto)
    const bboxMax = Math.max(bbox.maxX-bbox.minX, bbox.maxY-bbox.minY, bbox.maxZ-bbox.minZ)
    const escalaAuto = calcularEscala(bboxMax)
    const escala = escalaAuto
    const re = /facet normal[\s\S]*?endloop/g
    let faceta
    while ((faceta = re.exec(texto)) !== null) {
      const vre = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g
      const base = verts.length
      let vm
      while ((vm = vre.exec(faceta[0])) !== null) {
        verts.push([
          (parseFloat(vm[1])*escala*escalaUsuario).toFixed(6),
          (parseFloat(vm[2])*escala*escalaUsuario).toFixed(6),
          (parseFloat(vm[3])*escala*escalaUsuario).toFixed(6)
        ])
      }
      tris.push([base, base+1, base+2])
    }
  } else {
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const dv = new DataView(ab)
    const faceCount = dv.getUint32(80, true)
    const bboxRaw = bboxDeSTLBinario(buf, 1)
    const bboxMax = Math.max(bboxRaw.maxX-bboxRaw.minX, bboxRaw.maxY-bboxRaw.minY, bboxRaw.maxZ-bboxRaw.minZ)
    const escalaAuto = calcularEscala(bboxMax)
    const escala = escalaAuto
    let off = 84
    for (let i=0; i<faceCount; i++) {
      off += 12
      const base = verts.length
      for (let j=0; j<3; j++) {
        verts.push([
          (dv.getFloat32(off,true)*escala*escalaUsuario).toFixed(6),
          (dv.getFloat32(off+4,true)*escala*escalaUsuario).toFixed(6),
          (dv.getFloat32(off+8,true)*escala*escalaUsuario).toFixed(6)
        ])
        off += 12
      }
      tris.push([base, base+1, base+2])
      off += 2
    }
  }

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <resources>
  <object id="1" p:UUID="00010000-81cb-4c03-9d28-80fed5dfa1dc" type="model">
   <mesh>
    <vertices>\n`

  for (const [x,y,z] of verts) {
    xml += `     <vertex x="${x}" y="${y}" z="${z}"/>\n`
  }
  xml += `    </vertices>
    <triangles>\n`
  for (const [v1,v2,v3] of tris) {
    xml += `     <triangle v1="${v1}" v2="${v2}" v3="${v3}"/>\n`
  }
  xml += `    </triangles>
   </mesh>
  </object>
 </resources>
</model>`

  return xml
}

function calcularBboxFinal(stlPath, scalePct) {
  const buf = fs.readFileSync(stlPath)
  const escalaUsuario = (scalePct || 100) / 100
  if (esSTLAscii(buf)) {
    const texto = buf.toString('utf8')
    const bbox = bboxDeSTLAscii(texto)
    const bboxMax = Math.max(bbox.maxX-bbox.minX, bbox.maxY-bbox.minY, bbox.maxZ-bbox.minZ)
    const escala = calcularEscala(bboxMax) * escalaUsuario
    return {
      minX: bbox.minX*escala, maxX: bbox.maxX*escala,
      minY: bbox.minY*escala, maxY: bbox.maxY*escala,
      minZ: bbox.minZ*escala, maxZ: bbox.maxZ*escala
    }
  } else {
    const bboxRaw = bboxDeSTLBinario(buf, 1)
    const bboxMax = Math.max(bboxRaw.maxX-bboxRaw.minX, bboxRaw.maxY-bboxRaw.minY, bboxRaw.maxZ-bboxRaw.minZ)
    const escala = calcularEscala(bboxMax) * escalaUsuario
    return bboxDeSTLBinario(buf, escala)
  }
}

function crearTemp3MF(stlPath, scalePct, callback) {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true })
  const temp3MF = path.join(TEMP_DIR, 'modelo_cliente.3mf')
  try {
    const zip = new AdmZip(PLANTILLA_3MF)
    const modelXML = stlToModelXML(stlPath, scalePct)
    zip.updateFile('3D/Objects/object_1.model', Buffer.from(modelXML, 'utf8'))
    const {minX,maxX,minY,maxY,minZ} = calcularBboxFinal(stlPath, scalePct)
    const cx = 128 - (minX+maxX)/2
    const cy = 128 - (minY+maxY)/2
    const cz = -minZ
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
      const bboxX1 = parseFloat((minX+cx).toFixed(5))
      const bboxY1 = parseFloat((minY+cy).toFixed(5))
      const bboxX2 = parseFloat((maxX+cx).toFixed(5))
      const bboxY2 = parseFloat((maxY+cy).toFixed(5))
      plate1.bbox_all = [bboxX1,bboxY1,bboxX2,bboxY2]
      plate1.bbox_objects[0].bbox = [bboxX1,bboxY1,bboxX2,bboxY2]
      plate1.bbox_objects[0].name = path.basename(stlPath)
      zip.updateFile('Metadata/plate_1.json', Buffer.from(JSON.stringify(plate1), 'utf8'))
    }
    zip.writeZip(temp3MF)
    callback(null, temp3MF)
  } catch(e) {
    callback('Error creando 3MF: ' + e.message)
  }
}

function laminarConBambu(stlPath, scalePct, callback) {
  crearTemp3MF(stlPath, scalePct, (err, temp3MF) => {
    if (err) return callback(err)
    const resultPath = path.join(OUTPUT_DIR, 'result.json')
    if (fs.existsSync(resultPath)) fs.unlinkSync(resultPath)
    const proc = spawn(BAMBU_EXE, ['--slice', '1', '--outputdir', OUTPUT_DIR, temp3MF])
    let stderr = ''
    proc.stderr.on('data', d => stderr += d.toString())
    proc.on('close', () => {
      if (!fs.existsSync(resultPath)) return callback('BambuStudio no genero result.json. ' + stderr)
      try {
        const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
        if (result.return_code !== 0) return callback('BambuStudio error: ' + result.error_string)
        const plate = result.sliced_plates[0]
        const gramos = plate.filaments.reduce((s, f) => s + f.total_used_g, 0)
        const horas = plate.main_predication / 3600
        const h = Math.floor(horas)
        const m = Math.floor((horas - h) * 60)
        const s = Math.floor(((horas - h) * 60 - m) * 60)
        const tiempo = h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`
        callback(null, { tiempo, horas: horas.toFixed(2), gramos: gramos.toFixed(2) })
      } catch(e) {
        callback('Error leyendo result.json: ' + e.message)
      }
    })
  })
}

module.exports = { laminarConBambu }

