# 桌面端采用 Electron + React + TypeScript + PixiJS，渲染与界面分离

暗夜精灵只跑在 macOS，要求画布在 200 张图下平移缩放保持 120fps。我们选择 Electron + React + TypeScript 而不是 Tauri 或原生 Swift，以换取最成熟的界面生态和开发速度；性能通过分工保证：React 只负责工具栏、属性面板、AI 对话和任务编排，PixiJS 独占画布上的图片、选框、拖拽、缩放与平移，画布交互不触发 React 每帧更新；图片解码、缩略图和导出放在后台线程或独立进程；按缩放级别加载不同清晰度，只让必要纹理常驻 GPU。Rust 只在出现实测性能瓶颈时再引入。

## Considered Options

- Tauri 2 + Rust：包体小、内存低，但前期就要维护两种语言，收益在当前规模下不明显。
- 原生 SwiftUI + Metal：手感最好，但复杂的 AI 编排界面开发成本过高。
