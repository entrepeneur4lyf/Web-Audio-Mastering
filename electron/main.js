const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1050,
    height: 800,
    minWidth: 1000,
    minHeight: 750,
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    backgroundColor: '#080808',
    icon: path.join(__dirname, '..', 'logo-icon.png')
  });

  // Load from Vite dev server or built files
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // Clear reference when window is closed
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Window control handlers
ipcMain.handle('window-minimize', () => {
  mainWindow.minimize();
});

ipcMain.handle('window-maximize', () => {
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});

ipcMain.handle('window-close', () => {
  mainWindow.close();
});

ipcMain.handle('window-resize', (event, { width, height }) => {
  const [currentWidth, currentHeight] = mainWindow.getSize();
  const minWidth = 800, maxWidth = 2560;
  const minHeight = 600, maxHeight = 1440;

  const newWidth = Math.min(Math.max(width || currentWidth, minWidth), maxWidth);
  const newHeight = Math.min(Math.max(height || currentHeight, minHeight), maxHeight);
  mainWindow.setSize(newWidth, newHeight, true);
});

app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  // Remove all IPC handlers to prevent leaks
  ipcMain.removeHandler('window-minimize');
  ipcMain.removeHandler('window-maximize');
  ipcMain.removeHandler('window-close');
  ipcMain.removeHandler('window-resize');
  ipcMain.removeHandler('select-file');
  ipcMain.removeHandler('save-file');
  ipcMain.removeHandler('read-file-data');
  ipcMain.removeHandler('write-file-data');
  ipcMain.removeHandler('send-progress');

  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// File selection dialog
ipcMain.handle('select-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Audio Files', extensions: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'mp4'] }]
  });
  return result.filePaths[0] || null;
});

// Save file dialog
ipcMain.handle('save-file', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    filters: [{ name: 'WAV File', extensions: ['wav'] }]
  });
  return result.filePath || null;
});

// Read file data - returns Uint8Array
ipcMain.handle('read-file-data', async (event, filePath) => {
  if (!filePath) {
    throw new Error('No file path provided');
  }

  // Normalize and resolve path
  const normalized = path.normalize(filePath);
  const resolved = path.resolve(normalized);

  if (!fs.existsSync(resolved)) {
    throw new Error('File not found');
  }

  const buffer = fs.readFileSync(resolved);
  return new Uint8Array(buffer);
});

// Write file data - receives Uint8Array from renderer
ipcMain.handle('write-file-data', async (event, { filePath, data }) => {
  if (!filePath) {
    throw new Error('No output path specified');
  }
  if (!data || data.length === 0) {
    throw new Error('No data to write');
  }

  // Normalize path
  const normalized = path.normalize(filePath);
  const resolved = path.resolve(normalized);

  // Ensure it's a .wav file
  if (!resolved.toLowerCase().endsWith('.wav')) {
    throw new Error('Output must be a WAV file');
  }

  // Handle both Uint8Array and regular arrays (IPC may serialize differently)
  let buffer;
  if (data instanceof Uint8Array) {
    buffer = Buffer.from(data);
  } else if (ArrayBuffer.isView(data)) {
    buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  } else if (Array.isArray(data)) {
    buffer = Buffer.from(new Uint8Array(data));
  } else {
    throw new Error('Invalid data format');
  }

  fs.writeFileSync(resolved, buffer);
  return { success: true };
});

// Send progress updates to renderer
ipcMain.handle('send-progress', (event, progress) => {
  mainWindow.webContents.send('processing-progress', progress);
});
