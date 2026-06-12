"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wizard", {
  status: () => ipcRenderer.invoke("wizard:status"),
  install: () => ipcRenderer.invoke("wizard:install"),
  login: (provider) => ipcRenderer.invoke("wizard:login", provider),
  openUrl: (url) => ipcRenderer.invoke("wizard:open-url", url),
  finish: (payload) => ipcRenderer.invoke("wizard:finish", payload),
  cancel: () => ipcRenderer.invoke("wizard:cancel"),
  onStatus: (cb) => {
    const wrapped = (_e, s) => cb(s);
    ipcRenderer.on("wizard-status", wrapped);
    return () => ipcRenderer.removeListener("wizard-status", wrapped);
  },
});
