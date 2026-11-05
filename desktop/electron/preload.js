const { contextBridge, ipcRenderer } = require("electron");
// Puente mínimo: el estudio abre el compositor y elige o abre la carpeta de grabaciones.
contextBridge.exposeInMainWorld("streamhiveDesktop", {
  openRenderer: (path) => ipcRenderer.invoke("renderer:open", path),
  closeRenderer: () => ipcRenderer.invoke("renderer:close"),
  chooseFolder: (current) => ipcRenderer.invoke("folder:choose", current),
  openFolder: (folder) => ipcRenderer.invoke("folder:open", folder),
});
