const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getBridgeStatus: () => ipcRenderer.invoke("bridge:status"),
  // DLL picker / live reconnect
  getTobiiInfo: () => ipcRenderer.invoke("tobii:getInfo"),
  selectDll: () => ipcRenderer.invoke("tobii:selectDll"),
  setDll: (dllPath) => ipcRenderer.invoke("tobii:setDll", dllPath),
  clearDll: () => ipcRenderer.invoke("tobii:clearDll"),
  openLog: () => ipcRenderer.invoke("tobii:openLog"),
});
