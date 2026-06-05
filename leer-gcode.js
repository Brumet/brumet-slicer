const fs = require('fs');

const gcode = fs.readFileSync('resultado.gcode', 'utf8');
const lines = gcode.split('\n');

let totalE = 0;
let lastE = 0;
let printTime = '';

for (const line of lines) {
  // Extraer tiempo
  if (line.includes('estimated printing time (normal mode)')) {
    printTime = line.split('=')[1].trim();
  }
  
  // Sumar extrusiones
  if (line.startsWith('G1') && line.includes('E')) {
    const match = line.match(/E([\d.]+)/);
    if (match) {
      const e = parseFloat(match[1]);
      if (e > lastE) {
        totalE += e - lastE;
      }
      lastE = e;
    }
  }
  
  if (line.includes('G92 E0')) {
    lastE = 0;
  }
}

// Convertir mm de filamento a gramos
// Diametro 1.75mm, densidad PLA 1.24 g/cm3
const radio = 1.75 / 2;
const volumen = Math.PI * radio * radio * totalE; // mm3
const gramos = (volumen * 1.24) / 1000; // gramos

// Convertir tiempo a horas
let horas = 0;
if (printTime) {
  const h = printTime.match(/(\d+)h/);
  const m = printTime.match(/(\d+)m/);
  const s = printTime.match(/(\d+)s/);
  if (h) horas += parseInt(h[1]);
  if (m) horas += parseInt(m[1]) / 60;
  if (s) horas += parseInt(s[1]) / 3600;
}

// Formula de costo
const costo = ((1210.7 * horas) + 1200 + (gramos * 80)) * 1.6;

console.log('=================================');
console.log('BRUMET SLICER - RESULTADO');
console.log('=================================');
console.log('Tiempo de impresion: ' + printTime);
console.log('Horas: ' + horas.toFixed(2));
console.log('Filamento: ' + gramos.toFixed(2) + 'g');
console.log('PRECIO: $' + Math.round(costo).toLocaleString('es-CO') + ' COP');
console.log('=================================');