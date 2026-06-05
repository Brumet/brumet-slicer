# Brumet Slicer

**Cotizador de impresión 3D para Bamboo A1**  
Aplicación de escritorio Windows que lamina modelos 3D con BambuStudio y calcula automáticamente el precio de impresión.

![Version](https://img.shields.io/badge/version-1.1.0-red) ![Platform](https://img.shields.io/badge/platform-Windows-blue) ![License](https://img.shields.io/badge/license-Privado-gray)

---

## ¿Qué hace?

1. El cliente arrastra un archivo STL, OBJ o 3MF
2. La app lo lamina silenciosamente con BambuStudio CLI
3. Calcula el costo (filamento + energía + desgaste + operario) × 2
4. Muestra el precio y genera un PDF con el logo Brumet para enviar al cliente

---

## Características

- **Visor 3D** — previsualiza y transforma el modelo antes de cotizar (mover, rotar, escalar)
- **Multi-formato** — STL binario/ASCII, OBJ, 3MF (incluyendo 3MF con múltiples camas)
- **Multi-cama** — cuando el 3MF tiene varias placas muestra el precio por cama y total
- **Exportar PDF** — cotización profesional con thumbnail del modelo, logo y precio
- **Configuración protegida** — los costos solo son editables con contraseña (solo el dueño)
- **Sistema de licencias** — 30 días de prueba gratuita, luego código de activación (183 días)
- **Auto-update** — detecta nuevas versiones en GitHub Releases y se actualiza solo
- **Tema oscuro/claro** — toggle en el header, persiste entre sesiones

---

## Requisitos

- Windows 10/11 x64
- BambuStudio incluido en el instalador (no requiere instalación separada)

---

## Instalación (para clientes)

1. Descargar `Brumet.Slicer.Setup.x.x.x.exe` desde [Releases](https://github.com/Brumet/brumet-slicer/releases)
2. Ejecutar el instalador (ignorar la advertencia de SmartScreen → "Más información" → "Ejecutar de todas formas")
3. La app abre con 30 días de prueba gratuita
4. Para activar con código: clic en "Activar →" en el banner superior

---

## Desarrollo local

```bash
git clone https://github.com/Brumet/brumet-slicer.git
cd brumet-slicer
npm install
npm start
```

> **Requisito:** la carpeta `BambuStudio/` con `bambu-studio.exe` debe estar en la raíz del proyecto (no se sube a git por tamaño).

---

## Publicar nueva versión

```bash
# 1. Actualizar versión en package.json
# 2. Build
npm run build

# 3. Crear release en GitHub
# https://github.com/Brumet/brumet-slicer/releases/new
# Tag: v1.x.x — subir: Setup.exe + .blockmap + latest.yml (todos desde dist/)
```

---

## Generar códigos de licencia

```bash
node generar-codigos.js
```

Requiere la clave maestra. Genera los códigos, actualiza `licenses.json` y crea un documento en el Escritorio. El script **no está en el repositorio** (`.gitignore`).

---

## Estructura del proyecto

```
brumet-slicer/
├── main.js              # Proceso principal Electron (IPC, updater, PDF, settings)
├── index.html           # UI completa (pantalla principal, licencias, settings)
├── viewer.html          # Visor 3D Three.js (STL/OBJ/3MF, transformaciones)
├── slicer-bambu.js      # Motor de laminado (BambuStudio CLI wrapper)
├── licenses.json        # Hashes SHA-256 de códigos válidos
├── assets/              # Íconos
├── perfiles/            # Perfil de impresión Bamboo A1 (.3mf plantilla)
└── BambuStudio/         # BambuStudio CLI (no en git — va en extraResources)
```

---

## Fórmula de precio

```
costo = filamento + energía + desgaste_máquina + operario + espacio + fijos
precio = costo × 2
```

Todos los parámetros son configurables desde el ícono ⚙ (requiere contraseña).

---

## Tecnologías

| Tecnología | Uso |
|---|---|
| Electron 28 | Framework de escritorio |
| Three.js | Visor 3D |
| BambuStudio CLI | Motor de laminado |
| electron-updater | Auto-update vía GitHub Releases |
| AdmZip | Manipulación de archivos 3MF |
| SHA-256 (Node crypto) | Verificación de licencias |
| AES-256-CBC + PBKDF2 | Cifrado del store de licencias |

---

## Hecho por

**Brumet** · Bogotá, Colombia · [brumet.co](https://brumet.co) · WhatsApp 310 607 8712
