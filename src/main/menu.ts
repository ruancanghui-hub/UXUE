import { app, Menu, type MenuItemConstructorOptions } from 'electron';
import type { MenuCommand, RecentProject } from '../shared/api';

/**
 * 撤销、重做、全选这些快捷键必须由菜单转发给渲染进程：
 * 菜单快捷键会先于网页收到按键，用系统默认的 role 只会作用在输入框上。
 */
export function buildMenu(recent: RecentProject[], send: (command: MenuCommand) => void): void {
  const item = (label: string, command: MenuCommand, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => send(command),
  });
  /** 只在菜单里显示快捷键、不真正注册：这些键由画布处理，在输入框里打字时不能被菜单截走 */
  const canvasKey = (label: string, command: MenuCommand, accelerator: string): MenuItemConstructorOptions => ({
    ...item(label, command, accelerator),
    registerAccelerator: false,
  });

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: '关于暗夜精灵' },
        { type: 'separator' },
        item('设置…', 'openSettings', 'CmdOrCtrl+,'),
        { type: 'separator' },
        { role: 'hide', label: '隐藏暗夜精灵' },
        { role: 'hideOthers', label: '隐藏其他' },
        { type: 'separator' },
        { role: 'quit', label: '退出暗夜精灵' },
      ],
    },
    {
      label: '文件',
      submenu: [
        item('新建项目…', 'newProject', 'CmdOrCtrl+N'),
        item('打开项目…', 'openProject', 'CmdOrCtrl+O'),
        {
          label: '最近项目',
          enabled: recent.length > 0,
          submenu: recent.map((project) => item(project.name, `openRecent:${project.dir}`)),
        },
        { type: 'separator' },
        item('导入图片…', 'importImages', 'CmdOrCtrl+Shift+K'),
        { type: 'separator' },
        { role: 'close', label: '关闭窗口' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        item('撤销', 'undo', 'CmdOrCtrl+Z'),
        item('重做', 'redo', 'CmdOrCtrl+Shift+Z'),
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        item('全选', 'selectAll', 'CmdOrCtrl+A'),
        { type: 'separator' },
        item('创建副本', 'duplicate', 'CmdOrCtrl+D'),
        item('移到最前', 'bringToFront', 'CmdOrCtrl+Shift+]'),
        item('移到最后', 'sendToBack', 'CmdOrCtrl+Shift+['),
      ],
    },
    {
      label: '生成',
      submenu: [
        canvasKey('新建提示词卡', 'newPrompt', 'P'),
        item('生成', 'generate', 'CmdOrCtrl+Enter'),
      ],
    },
    {
      label: '视图',
      submenu: [
        item('视觉主题区', 'region:theme', 'CmdOrCtrl+1'),
        item('核心素材区', 'region:assets', 'CmdOrCtrl+2'),
        item('高保真页面区', 'region:pages', 'CmdOrCtrl+3'),
        item('只看当前区域', 'toggleFocus', 'CmdOrCtrl+Shift+F'),
        { type: 'separator' },
        item('放大', 'zoomIn', 'CmdOrCtrl+='),
        item('缩小', 'zoomOut', 'CmdOrCtrl+-'),
        canvasKey('缩放到全部', 'fitAll', 'Shift+1'),
        canvasKey('缩放到选中', 'zoomToSelection', 'Shift+2'),
        canvasKey('100%', 'zoomReset', 'Shift+0'),
        { type: 'separator' },
        item('性能面板', 'togglePerf', 'CmdOrCtrl+Alt+P'),
        { role: 'toggleDevTools', label: '开发者工具' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    { role: 'windowMenu', label: '窗口' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
