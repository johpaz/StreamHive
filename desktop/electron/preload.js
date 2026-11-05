const { contextBridge, ipcRenderer } = require("electron");
// Puente mínimo: solo el estudio puede pedir abrir/cerrar la ventana del compositor.
contextBridge.exposeInMainWorld("streamhiveDesktop", {
  openRenderer: (path) => ipcRenderer.invoke("renderer:open", path),
  closeRenderer: () => ipcRenderer.invoke("renderer:close"),
});
