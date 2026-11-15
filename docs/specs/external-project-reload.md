# 规格：外部改动 `project.json` 不再用阻塞弹框打断

> 决策来自 2026-11-14 grill（Q1–Q7 全部采纳推荐项）。  
> 相关：ADR-0003（目录项目与外部改动检测）、PLAN「F 监听项目目录」。

## 0. 一句话

自己保存或同步盘原样回写不再误报；磁盘上 `project.json` 真变了且本地无未保存改动时静默重载；有未保存时用画布上方横幅选择，**废除 `window.confirm` 打断专注**。

## 1. 已锁定的决策

| # | 决策 | 选择 |
|---|---|---|
| Q1 | 打扰方式 | 无脏自动重载；有脏非阻塞横幅；不用阻塞弹框 |
| Q2 | 降误报 | 自己写入内容指纹；watch 防抖约 1s；忽略窗约 2s |
| Q3 | 有脏冲突 | 横幅：重载（丢弃本地）/ 保留本地；可关掉 |
| Q4 | 范围 | 只修 `project` 类事件；assets 逻辑不动 |
| Q5 | 静默反馈 | 无脏重载完全静默；失败才 toast |
| Q6 | 指纹位置 | 主进程 save 成功后记 hash；相同则不发事件 |
| Q7 | 横幅位置 | 画布上方窄条 |

## 2. 实现要点

### 2.1 主进程 `ProjectService`

- `OWN_SAVE_IGNORE_MS`：800 → **2000**。
- `lastSavedHash: string | null`：每次 `save` 写入的 JSON 文本做 hash（如 sha256 前 16 hex，或整串 sha256）。
- `watch`：对 `project.json` 事件 **防抖 ~1000ms** 后：
  1. 若仍在 `ignoreUntil` 内 → 丢弃；
  2. 读盘文本，算 hash；若 `=== lastSavedHash` → 丢弃（同步盘原样回写）；
  3. 否则 `onFsChange({ kind: 'project', ... })`，并可带上 `hash`（可选）。
- `open` 成功后把当前磁盘内容写入 `lastSavedHash`，避免打开瞬间误报。

### 2.2 渲染进程

- 删除 `window.confirm(...)` 外部改动分支。
- `kind === 'project'`：
  - `!isDirty()` → `reloadFromDisk()`，无提示；
  - `isDirty()` → 显示 `ExternalReloadBanner`（状态即可），不自动重载。
- 横幅按钮：
  - **重载**：`reloadFromDisk()` 并收起；
  - **保留本地** / **×**：收起横幅；本地继续编，下次保存覆盖磁盘。
- 若横幅开着期间再次收到 `project` 事件：保持横幅即可（不必叠多个）。

### 2.3 UI

- 画布区域顶部（`CanvasView` 或 `ProjectApp` 主列上方）一条：文案「磁盘上的项目已更新」；按钮「重载」「保留本地」。

## 3. 验收

- [x] 正常编辑自动保存：不再弹出 `confirm`。
- [x] 自己写入后同步盘回写相同内容：不发事件 / 不重载打扰。
- [x] 外部真改 `project.json` 且本地已保存：静默重载，画布与磁盘一致。
- [x] 本地有未保存改动且外部改了：出现横幅；重载丢本地；保留则继续编辑。
- [x] `npm test` / `typecheck` 通过（`projectHash.test.ts`）。

## 4. 非目标

- 三路合并、关掉监听的设置项、因 `exports/` / `themes/` 弹窗（本来就不会）。
