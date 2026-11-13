import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { AnyeApi, LaunchFlags, MenuCommand } from '../shared/api';
import type { BenchProgress } from '../shared/bench';

const flagArg = process.argv.find((arg) => arg.startsWith('--anye-flags='));
const flags: LaunchFlags = flagArg
  ? (JSON.parse(flagArg.slice('--anye-flags='.length)) as LaunchFlags)
  : { uncapped: false, autoBench: false, m1Check: null };

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T): void => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: AnyeApi = {
  flags,

  getStartupInfo: () => ipcRenderer.invoke('app:startup'),
  chooseNewProjectDir: () => ipcRenderer.invoke('project:choose-new'),
  chooseProjectDir: () => ipcRenderer.invoke('project:choose-open'),
  openProject: (dir) => ipcRenderer.invoke('project:open', dir),
  saveProject: (dir, file) => ipcRenderer.invoke('project:save', dir, file),
  pickImages: () => ipcRenderer.invoke('images:pick'),
  importImages: (sources) => ipcRenderer.invoke('images:import', sources),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  revealInFinder: (path) => ipcRenderer.send('shell:reveal', path),
  onCacheReady: (listener) => subscribe<string>('project:cache-ready', listener),
  onMenuCommand: (listener) => subscribe<MenuCommand>('menu:command', listener),
  onFlushRequest: (handler) =>
    subscribe<void>('app:flush', () => {
      void handler().finally(() => ipcRenderer.send('app:flushed'));
    }),
  writeCheckFile: (name, content) => ipcRenderer.invoke('check:write', name, content),
  readCheckFile: (name) => ipcRenderer.invoke('check:read', name),

  prepareBench: (count) => ipcRenderer.invoke('bench:prepare', count),
  onBenchProgress: (listener) => subscribe<BenchProgress>('bench:progress', listener),
  saveBenchReport: (report) => ipcRenderer.invoke('bench:report', report),
  quit: () => ipcRenderer.send('app:quit'),
};

contextBridge.exposeInMainWorld('anye', api);
