const path = require("path");
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, powerMonitor, shell, Tray } = require("electron");
const { CompanionService } = require("./companion-service");

let mainWindow = null;
let tray = null;
let service = null;
let isQuitting = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

function appRoot() {
  return app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "..", "..", "..");
}

function sendStateToWindow(state) {
  // Bridge shutdown/reconnect events can arrive after Electron has destroyed
  // the BrowserWindow. Optional chaining on `mainWindow` alone is not enough:
  // `webContents.send()` throws when its native WebContents has been disposed.
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const contents = mainWindow.webContents;
  if (!contents || contents.isDestroyed()) return;
  contents.send("codexlink:state", state);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1060,
    height: 720,
    minWidth: 880,
    minHeight: 620,
    title: "CodexLink Companion",
    show: false,
    backgroundColor: "#f5f3ee",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.once("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  service.on("state", sendStateToWindow);
}

function createTray() {
  const icon = nativeImage.createFromDataURL(
    "data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#18231f"/><path d="M19 20h26v7H26v10h19v7H19z" fill="#d9ff72"/></svg>').toString("base64")
  );
  tray = new Tray(icon.resize({ width: 20, height: 20 }));
  tray.setToolTip("CodexLink Companion");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 CodexLink", click: () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    } },
    { label: "刷新 Tailnet", click: () => void service.refreshNetwork() },
    { type: "separator" },
    { label: "退出", click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on("double-click", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });
}

function installIpcHandlers() {
  ipcMain.handle("codexlink:snapshot", () => service.snapshot());
  ipcMain.handle("codexlink:project:add", async () => {
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: "选择允许 CodexLink 操作的项目目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    return service.addProject(selection.filePaths[0]);
  });
  ipcMain.handle("codexlink:project:remove", (_, id) => service.removeProject(id));
  ipcMain.handle("codexlink:provider:upsert", (_, profile) => service.upsertProvider(profile));
  ipcMain.handle("codexlink:provider:delete", (_, id) => service.deleteProvider(id));
  ipcMain.handle("codexlink:provider:test", (_, id) => service.testProvider(id));
  ipcMain.handle("codexlink:pairing:reset", () => service.resetTrustedPhone());
  ipcMain.handle("codexlink:security:update", (_, settings) => service.updateSecuritySettings(settings));
  ipcMain.handle("codexlink:network:refresh", () => service.refreshNetwork());
}

app.on("second-instance", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  app.setAppUserModelId("dev.local.codexlink.companion");
  app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
  service = new CompanionService({ userDataPath: app.getPath("userData"), appRoot: appRoot() });
  installIpcHandlers();
  createWindow();
  createTray();
  powerMonitor.on("resume", () => void service.refreshNetwork());
  try {
    await service.start();
  } catch (error) {
    service.log("error", error.message);
    dialog.showErrorBox("CodexLink 无法启动", error.message);
  }
});

app.on("before-quit", () => { isQuitting = true; });
app.on("will-quit", (event) => {
  if (service && !service.__stopped) {
    event.preventDefault();
    service.__stopped = true;
    void service.stop().finally(() => app.quit());
  }
});
