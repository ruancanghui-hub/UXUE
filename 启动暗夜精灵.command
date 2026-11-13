#!/bin/zsh
# 双击启动暗夜精灵：首次运行自动安装依赖，每次启动前重新构建，关掉应用后这个窗口可以直接关闭。
set -e
cd "${0:A:h}"

export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"

if ! command -v npm >/dev/null 2>&1; then
  echo "没有找到 npm，请先安装 Node.js 22 或更高版本：https://nodejs.org"
  read -k 1 "?按任意键关闭…"
  exit 1
fi

if [[ ! -d node_modules/electron/dist ]]; then
  echo "▶ 首次运行，正在安装依赖…"
  npm install
fi

echo "▶ 正在构建…"
npm run build --silent >/dev/null

echo "▶ 启动暗夜精灵"
npx electron .
