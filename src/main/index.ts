import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { CheckPhase, ImportSource, LaunchFlags, MenuCommand, StartupInfo } from '../shared/api';
import { BENCH_HOST, PROJECT_HOST, type BenchManifest, type BenchReport } from '../shared/bench';
import type { GenerationRequest, ProviderId } from '../shared/generation';
import { GenerationQueue } from './generation/GenerationQueue';
import { MockProvider, OpenAIProvider } from './generation/providers';
import { GenerationSettingsStore } from './generation/settingsStore';
import type { ProjectFile } from '../shared/project';
import type { PrepareBenchResult, SelfTestResult } from '../shared/workerProtocol';
import { handleAssetProtocol, registerAssetScheme } from './assetProtocol';
import { ImageWorkerClient } from './imageWorkerClient';
import { buildMenu } from './menu';
import { ProjectService } from './projectService';

const hasFlag = (flag: string, env: string): boolean =>
  process.argv.includes(flag) || process.env[env] === '1';

const checkPhase = (name: string): CheckPhase | null => {
  const value = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1];
  return value === 'write' || value === 'verify' ? value : null;
};
const flags: LaunchFlags = {
  uncapped: hasFlag('--uncapped', 'ANYE_UNCAPPED'),
  autoBench: hasFlag('--auto-bench', 'ANYE_AUTO_BENCH'),
  m1Check: checkPhase('m1-check'),
  m2Check: checkPhase('m2-check'),
};
const checkName = flags.m1Check ? 'm1' : flags.m2Check ? 'm2' : null;
const checkPhaseValue = flags.m1Check ?? flags.m2Check;
const selfTestMode = hasFlag('--self-test', 'ANYE_SELF_TEST');
/** 开发用：窗口加载完 1.5 秒后把界面截图存到这个路径并退出 */
const capturePath = process.argv.find((arg) => arg.startsWith('--capture='))?.slice('--capture='.length) ?? null;
const automated = flags.autoBench || checkName !== null || capturePath !== null;

if (flags.uncapped) {
  app.commandLine.appendSwitch('disable-frame-rate-limit');
  app.commandLine.appendSwitch('disable-gpu-vsync');
}

registerAssetScheme();

const worker = new ImageWorkerClient();
const assetRoots = new Map<string, string>();
const benchDir = (): string => join(app.getPath('userData'), 'bench-project');
const checkRoot = (): string => join(app.getPath('temp'), `anye-${checkName ?? 'm1'}-check`);
let mainWindow: BrowserWindow | null = null;

const sendMenuCommand = (command: MenuCommand): void => {
  mainWindow?.webContents.send('menu:command', command);
};

const generationSettings = new GenerationSettingsStore(app.getPath('userData'));
const openai = new OpenAIProvider(worker, () => generationSettings.getApiKey());
const generationQueue = new GenerationQueue(
  worker,
  generationSettings,
  { openai, mock: new MockProvider(worker) },
  (update) => mainWindow?.webContents.send('gen:update', update),
  checkName ? 'mock' : null,
);

const projects = new ProjectService(
  worker,
  join(app.getPath('userData'), 'recent.json'),
  {
    onCacheReady: (versionId) => mainWindow?.webContents.send('project:cache-ready', versionId),
    onRecentChanged: (recent) => buildMenu(recent, sendMenuCommand),
  },
  (dir) => assetRoots.set(PROJECT_HOST, dir),
  !automated,
);

app.whenReady().then(async () => {
  if (selfTestMode) {
    await runSelfTest();
    return;
  }

  await mkdir(benchDir(), { recursive: true });
  await generationSettings.load();
  assetRoots.set(BENCH_HOST, benchDir());
  if (checkPhaseValue === 'write') await rm(checkRoot(), { recursive: true, force: true });
  if (checkName) await mkdir(join(checkRoot(), '项目'), { recursive: true });

  handleAssetProtocol(assetRoots);
  buildMenu(await projects.readRecent(), sendMenuCommand);
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  worker.dispose();
  app.quit();
});

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: '暗夜精灵',
    backgroundColor: '#111114',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      // 自动测试时窗口可能被挡住；被遮挡的窗口会暂停 rAF，测试就会一直等下去
      backgroundThrottling: !automated,
      additionalArguments: [`--anye-flags=${JSON.stringify(flags)}`],
    },
  });
  mainWindow = window;
  window.once('ready-to-show', () => window.show());
  if (automated) {
    window.webContents.on('console-message', ({ level, message }) => console.log(`[renderer:${level}] ${message}`));
  }
  guardCloseUntilFlushed(window);
  if (capturePath) {
    window.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        await writeFile(capturePath, (await window.webContents.capturePage()).toPNG());
        app.quit();
      }, 1500);
    });
  }
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(join(__dirname, '../renderer/index.html'));
}

/** 关窗前先让渲染进程把还没写盘的改动保存掉，最多等 3 秒 */
function guardCloseUntilFlushed(window: BrowserWindow): void {
  let flushed = false;
  window.on('close', (event) => {
    if (flushed) return;
    event.preventDefault();
    const finish = (): void => {
      if (flushed) return;
      flushed = true;
      clearTimeout(timer);
      ipcMain.removeListener('app:flushed', onFlushed);
      window.close();
    };
    const onFlushed = (flushEvent: Electron.IpcMainEvent): void => {
      if (flushEvent.sender === window.webContents) finish();
    };
    const timer = setTimeout(finish, 3000);
    ipcMain.on('app:flushed', onFlushed);
    window.webContents.send('app:flush');
  });
}

function registerIpc(): void {
  ipcMain.handle('app:startup', async (): Promise<StartupInfo> => ({
    recent: await projects.readRecent(),
    reopen: automated ? null : await projects.findReopen(),
    checkDir: checkName ? join(checkRoot(), '项目') : null,
  }));

  ipcMain.handle('gen:config', () => generationSettings.config());
  ipcMain.handle('gen:update-config', (_event, patch: { provider?: ProviderId; model?: string }) =>
    generationSettings.update(patch),
  );
  ipcMain.handle('gen:set-key', (_event, key: string | null) => generationSettings.setApiKey(key));
  ipcMain.handle('gen:test', () => openai.testConnection(generationSettings.config().model));
  ipcMain.handle('gen:submit', (_event, request: GenerationRequest) => {
    if (request.projectDir !== projects.currentDir()) throw new Error('只能为当前打开的项目生成');
    if (request.inputs.some((input) => input.file.includes('..') || input.file.startsWith('/'))) {
      throw new Error('输入图路径不合法');
    }
    return generationQueue.submit(request);
  });
  ipcMain.on('gen:cancel', (_event, jobId: string) => generationQueue.cancel(jobId));
  ipcMain.on('gen:cancel-all', () => generationQueue.cancelAll());

  ipcMain.handle('project:choose-new', async () => {
    const result = await dialog.showOpenDialog({
      title: '新建项目',
      message: '选择或新建一个空文件夹，暗夜精灵会把这个项目的全部内容放在里面',
      buttonLabel: '在这里新建项目',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('project:choose-open', async () => {
    const result = await dialog.showOpenDialog({
      title: '打开项目',
      buttonLabel: '打开项目',
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('project:open', (_event, dir: string) => projects.open(dir));
  ipcMain.handle('project:save', (_event, dir: string, file: ProjectFile) => projects.save(dir, file));

  ipcMain.handle('images:pick', async () => {
    const result = await dialog.showOpenDialog({
      title: '导入图片',
      buttonLabel: '导入',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'tif', 'tiff', 'svg', 'heic'] }],
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle('images:import', (_event, sources: ImportSource[]) => projects.importImages(sources));

  ipcMain.on('shell:reveal', (_event, path: string) => shell.showItemInFolder(path));

  ipcMain.handle('check:write', async (_event, name: string, content: string) => {
    const file = join(checkRoot(), name.replace(/[^\w.-]/g, '_'));
    await writeFile(file, content);
    return file;
  });
  ipcMain.handle('check:read', async (_event, name: string) =>
    readFile(join(checkRoot(), name.replace(/[^\w.-]/g, '_')), 'utf8').catch(() => null),
  );

  ipcMain.handle('bench:prepare', async (event, count: number): Promise<BenchManifest> => {
    const startedAt = performance.now();
    const result = await worker.request<PrepareBenchResult>(
      { type: 'prepareBench', dir: benchDir(), count },
      (progress) => event.sender.send('bench:progress', progress),
    );
    return {
      images: result.images.map((image) => ({
        key: image.key,
        width: image.width,
        height: image.height,
        originalPath: join(benchDir(), image.original),
      })),
      reused: result.reused,
      elapsedMs: Math.round(performance.now() - startedAt),
    };
  });

  ipcMain.handle('bench:report', async (_event, report: BenchReport): Promise<string> => {
    const file = join(benchDir(), 'bench-report.json');
    await writeFile(file, JSON.stringify(report, null, 2));
    console.log(`[bench] report saved: ${file}`);
    return file;
  });

  ipcMain.on('app:quit', async (event) => {
    if (automated) {
      const image = await event.sender.capturePage();
      const target = checkName
        ? join(checkRoot(), `screenshot-${checkPhaseValue}.png`)
        : join(benchDir(), 'bench-screenshot.png');
      await writeFile(target, image.toPNG());
    }
    app.quit();
  });
}

async function runSelfTest(): Promise<void> {
  const dir = join(app.getPath('temp'), 'anye-selftest');
  try {
    const result = await worker.request<SelfTestResult>({ type: 'selfTest', dir });
    console.log(`[self-test] ok ${JSON.stringify(result)}`);
    worker.dispose();
    app.exit(0);
  } catch (error) {
    console.error('[self-test] failed', error);
    worker.dispose();
    app.exit(1);
  }
}
