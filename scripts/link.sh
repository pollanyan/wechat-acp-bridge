#!/bin/bash
set -e
echo "🚀 安装 WeChat ACP Bridge"
if ! command -v node &> /dev/null; then echo "❌ Node.js 未安装"; exit 1; fi
npm install
npm run clean
npm run build
npm link
echo "✅ 安装完成，请执行 wechat-acp-bridge login"

#!/bin/bash
set -e

echo "==================================="
echo "🚀 安装 WeChat ACP Bridge 调试环境"
echo "==================================="

# 1. 编译（必须先编译，再 link）
echo "🔨 1. 编译最新代码..."
npm run build

# 2. 链接到全局
echo "🔗 2. 创建全局链接..."
npm link

echo "==================================="
echo " ✅ 成功！"
echo " 👉 请执行wechat-acp-bridge run"
echo "==================================="
