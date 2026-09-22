const { app, BrowserWindow, dialog } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const serviceProcesses = []
const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (window) {
      if (window.isMinimized()) window.restore()
      window.focus()
    }
  })
}

function startLocalServices() {
  const projectRoot = app.getAppPath()
  const logs = app.getPath('logs')
  fs.mkdirSync(logs, { recursive: true })
  const bridge = spawn(process.execPath, [path.join(projectRoot, 'scripts', 'ltx-bridge.mjs')], {
    cwd: projectRoot,
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MOTION_CONFIG_FILE: path.join(app.getPath('userData'), 'motion-config.json') },
    stdio: ['ignore', fs.openSync(path.join(logs, 'bridge.log'), 'a'), fs.openSync(path.join(logs, 'bridge.error.log'), 'a')],
  })
  serviceProcesses.push(bridge)

  const ltxPython = 'C:\\Users\\Roy\\AppData\\Local\\LTXDesktop\\python\\python.exe'
  const ltxScript = path.join(projectRoot, 'scripts', 'ltx-server.py')
  const ltxBackend = 'C:\\Users\\Roy\\AppData\\Local\\Programs\\LTX Desktop\\resources\\backend'
  if (fs.existsSync(ltxPython) && fs.existsSync(ltxScript)) {
    const ltx = spawn(ltxPython, ['-u', ltxScript], {
      cwd: ltxBackend,
      windowsHide: true,
      env: { ...process.env, LTX_APP_DATA_DIR: 'C:\\Users\\Roy\\AppData\\Local\\LTXDesktop', LTX_AUTH_TOKEN: 'motion-local-token', LTX_ADMIN_TOKEN: 'motion-local-admin', LTX_PORT: '41954' },
      stdio: ['ignore', fs.openSync(path.join(logs, 'ltx.log'), 'a'), fs.openSync(path.join(logs, 'ltx.error.log'), 'a')],
    })
    serviceProcesses.push(ltx)
  }
}

function stopLocalServices() {
  const projectRoot = app.getAppPath()
  const script = path.join(projectRoot, 'scripts', 'restart-local.ps1')
  spawn('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', script], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: 'ignore',
  })
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0d1112',
    autoHideMenuBar: true,
    title: 'Motion Studio',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  window.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'))
}

if (gotSingleInstanceLock) app.whenReady().then(() => {
  startLocalServices()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  for (const service of serviceProcesses) service.kill()
  stopLocalServices()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

process.on('uncaughtException', (error) => {
  dialog.showErrorBox('Motion Studio', error.message)
})