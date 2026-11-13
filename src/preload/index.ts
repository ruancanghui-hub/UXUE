import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { AnyeApi, LaunchFlags, MenuCommand } from '../shared/api';
import type { BenchProgress } from '../shared/bench';
import type { JobUpdate } from '../shared/generation';

const flagArg = process.argv.find((arg) => arg.startsWith('--anye-flags='));
const flags: LaunchFlags = flagArg
  ? (JSON.parse(flagArg.slice('--anye-flags='.length)) as LaunchFlags)
  : { uncapped: false, autoBench: false, m1Check: null, m2Check: null, m3Check: null, m4Check: null, realCheck: false };

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

  getGenerationConfig: () => ipcRenderer.invoke('gen:config'),
  updateGenerationConfig: (patch) => ipcRenderer.invoke('gen:update-config', patch),
  setApiKey: (key) => ipcRenderer.invoke('gen:set-key', key),
  testConnection: () => ipcRenderer.invoke('gen:test'),
  submitGeneration: (request) => ipcRenderer.invoke('gen:submit', request),
  cancelGeneration: (jobId) => ipcRenderer.send('gen:cancel', jobId),
  cancelAllGenerations: () => ipcRenderer.send('gen:cancel-all'),
  onGenerationUpdate: (listener) => subscribe<JobUpdate>('gen:update', listener),
  askAssistant: (request) => ipcRenderer.invoke('assistant:ask', request),
  exportPage: (projectDir, plan) => ipcRenderer.invoke('export:page', projectDir, plan),
  sampleLowFi: () => ipcRenderer.invoke('dev:sample-lowfi'),

  prepareBench: (count) => ipcRenderer.invoke('bench:prepare', count),
  onBenchProgress: (listener) => subscribe<BenchProgress>('bench:progress', listener),
  saveBenchReport: (report) => ipcRenderer.invoke('bench:report', report),
  quit: () => ipcRenderer.send('app:quit'),
};

contextBridge.exposeInMainWorld('anye', api);
