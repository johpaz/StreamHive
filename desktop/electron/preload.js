const { contextBridge, ipcRenderer } = require("electron");
// Puente mínimo: el estudio abre el compositor y elige o abre la carpeta de grabaciones.
contextBridge.exposeInMainWorld("streamhiveDesktop", {
  openRenderer: (path) => ipcRenderer.invoke("renderer:open", path),
  closeRenderer: () => ipcRenderer.invoke("renderer:close"),
  chooseFolder: (current) => ipcRenderer.invoke("folder:choose", current),
  openFolder: (folder) => ipcRenderer.invoke("folder:open", folder),
  // Vuelve a entrar al estudio con el token de esta app, sin pedir la clave.
  enter: () => ipcRenderer.invoke("session:enter"),
  // Aviso del sistema si la ventana no está al frente (alguien llegó a la sala de espera).
  notify: (body) => ipcRenderer.invoke("attention:notify", body),
});
