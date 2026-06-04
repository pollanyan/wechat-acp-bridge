**WeChat ACP Bridge**

微信 ACP 桥接器 — 让微信与 ACP 兼容的 AI Agent 无缝对话。
支持 OpenClaw、Hermes、OpenCode、Claude Code 等 Agent，支持多微信账号。

# 1. 缘起

从 OpenClaw 到 Hermes Agent，他们都原生支持微信了，但你不能在同一个账号上双开。HermesClaw 就是为了解决这个问题的，但折腾一番后，反复遇到通信异常。索性让 DeepSeek 重写一个初始版本，又因DeepSeek网页版不便，转而用 Claude Code 接入 DeepSeek 进行迭代，最终有了 WeChat-ACP-Bridge。

# 2. 功能特性

- **多 Agent 支持** — 通过 ACP 协议对接 OpenClaw、Hermes、OpenCode、Claude Code 等 AI Agent
- **多账号并行** — 支持多个微信账号同时访问，每账号独立选择后端 Agent
- - **扫码登录** — 终端二维码扫码登录，凭证安全持久化
- **热加载** — 账号激活/去激活、Agent 切换实时生效，无需重启服务
- **Session 管理** — 会话上下文持久化，支持超时自动过期、历史查看、手动切换
- **系统服务** — 支持 systemd（Linux）和 launchd（macOS）作为后台服务运行
- **配置驱动** — Agent、超时、显示名称等均通过 YAML 配置，无需修改代码

# 3. 快速开始

```bash
# 1. 安装
npm install -g @pollanyan/wechat-acp-bridge

# 2. 扫码登录微信
wechat-acp-bridge login

# 3. （可选）配置 Agent — 编辑 ~/.wechat-acp-bridge/config/agents.yaml

# 4. 启动桥接服务
wechat-acp-bridge run
```

在微信中发送消息，Agent 将自动回复。发送 `/h` 查看微信端可用命令。

# 4. 安装

## 4.1. 全局安装（推荐）

```bash
npm install -g wechat-acp-bridge
```

## 4.2. 从源码安装

```bash
git clone <repo-url>
cd wechat-acp-bridge
npm install
npm run build
npm link
```

## 4.3. 安装为系统服务(用户级)

```bash
# Linux (systemd)/macOS (launchd)
wechat-acp-bridge install
wechat-acp-bridge start
```

# 5. 使用指南

## 5.1. CLI 命令

| 命令                 | 说明                                       |
| -------------------- | ------------------------------------------ |
| `login [alias]`      | 扫码登录微信账号，`alias` 默认为 `default` |
| `login -f`           | 强制重新扫码（已有凭证时跳过确认）         |
| `run`                | 前台运行桥接服务                           |
| `install`            | 安装为系统服务(用户级)                     |
| `uninstall`          | 卸载系统服务                               |
| `start`              | 启动后台服务（systemd/launchd）            |
| `stop`               | 停止后台服务                               |
| `restart`            | 重启后台服务                               |
| `status [alias]`     | 查看账号、Agent、Session 及进程状态        |
| `list`               | 列出所有已保存账号                         |
| `activate <alias>`   | 激活已登录账号（热加载，实时生效）         |
| `deactivate <alias>` | 去激活账号                                 |
| `logout <alias>`     | 删除登录凭证并去激活                       |
| `logs`               | 查看日志文件路径和当前级别                 |
| `logs -l DEBUG`      | 设置日志级别（DEBUG/INFO/WARNING/ERROR）   |
| `logs -f`            | 实时跟随日志文件（类似 `tail -f`）         |

## 5.2. 微信端命令

在微信聊天中直接发送以下命令：

| 命令              | 说明                                              |
| ----------------- | ------------------------------------------------- |
| `/h`              | 显示帮助信息                                      |
| `/new`            | 创建新会话（重置上下文）                          |
| `/sessions`       | 列出历史会话                                      |
| `/session <id>`   | 切换到指定会话（支持短 ID 前缀匹配）              |
| `/session latest` | 切换到最近活跃的会话                              |
| `/<short>`        | 切换到指定 Agent（如 `/cl`、`/ha`、`/oc`、`/cc`） |

直接发送文本即可与当前 Agent 对话。

## 5.3. 多账号使用

```bash
# 登录多个微信账号
wechat-acp-bridge login -a zhangsan  # 张三微信号
wechat-acp-bridge login -a lisi      # 李四微信号

# 查看所有账号
wechat-acp-bridge list

# 只激活需要用的
wechat-acp-bridge deactivate zhangsan  # 暂时停用账号
wechat-acp-bridge activate zhangsan    # 重新激活账号

```

# 6. 功能结构与说明

## 6.1. 系统分层

| 层级                 | 组件                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| **CLI 管理接口**     | login · run · start · stop · status · logs ···                                                   |
| **WeChatACPBridge**  | 主控循环 (supervisorLoop 10s 热加载)                                                             |
| **核心模块**         | WXAPI（微信 API 封装） / MessageRouter（消息路由·Session） / AcpBridgeClient（ACP NDJSON stdio） |
| **Storage 持久化层** | 凭证 · 激活列表 · 账号状态 · Session 元数据 · 日志                                               |

## 6.2. 核心组件

**WeChatACPBridge** (`src/index.ts`) — 主控循环

- 每 10 秒从 `active_accounts.json` 读取激活账号列表
- 为新增激活账号创建 WXAPI 实例并启动独立长轮询
- 去激活账号的轮询自行退出

**WXAPI** (`src/weixin/api.ts`) — 微信 API 客户端

- 扫码登录：获取二维码 → 终端展示 → 轮询确认 → 持久化凭证
- 长轮询：POST `/ilink/bot/getupdates`（无新消息时保持连接 35s）
- 发送文本：POST `/ilink/bot/sendmessage`
- 输入状态：先获取 `typing_ticket`（按用户缓存），再 POST `/ilink/bot/sendtyping`
- 所有外部输入经 Zod Schema 校验

**MessageRouter** (`src/bridge/router.ts`) — 消息路由

- 命令解析优先级：`/h` > `/sessions` > `/session <key>` > `/new` > `/<short>`
- Session 生命周期：自动创建 → 超时过期 → 手动切换 → 历史查看
- Session 描述首条消息自动生成（截取首句前 80 字）

**AcpBridgeClient** (`src/acp/client.ts`) — ACP 客户端

- spawn Agent 子进程，stdin/stdout 走 ACP NDJSON 协议
- `sessionUpdate` 累积 `agent_message_chunk` 文本块
- `requestPermission` 自动授权（优先 `allow_once`）

## 6.3. 数据持久化

```
~/.wechat-acp-bridge/run/
├── bridge.pid                  # 前台进程 PID（防重复启动）
├── active_accounts.json        # 激活账号列表（热加载）
├── log_level.json              # 日志级别持久化
├── logs/bridge.log             # Winston JSON 日志
├── accounts/<alias>.json       # 登录凭证（token, baseUrl, ilink_bot_id）
├── account_state/<alias>/state.json  # 当前 Agent、当前 sessionID
└── sessions/<alias>/<agent>/<uuid>.json  # 每条 session 独立元数据
```

# 7. 消息流程

## 7.1. 普通文本消息

```
微信客户端 ──"你好"──▶ 微信服务器
                        │
        WXAPI.getUpdates() 长轮询 ── 返回消息
                        │
        sendTyping(START) ── 每 5s 重发 keep-alive
                        │
        MessageRouter.routeMessage()
          ├─ 非命令文本 → ensureCurrentSession()
          │    ├─ 有活跃 session (未超时) → 复用
          │    └─ 无活跃 session → createSession()
          │         ├─ spawn Agent 子进程
          │         ├─ ACP initialize + newSession
          │         └─ 持久化 SessionMeta
          │
          └─ AcpBridgeClient.sendPrompt("你好")
               └─ ACP prompt → agent 子进程处理
                        │
        sendTyping(STOP) ── finally 块保证
                        │
        sendText(reply) ──▶ 微信服务器 ──▶ 微信客户端
```

## 7.2. 命令处理流程

```
微信客户端 ──"/cl"──▶ MessageRouter.routeMessage()
                      │
                      ├─ resolveModeByCommand("/cl") → "OpenClaw"
                      ├─ switchAgent(alias, "OpenClaw")
                      │    ├─ 更新 accountState.currentAgentKey
                      │    └─ ensureCurrentSession()
                      │
                      └─ 返回 "✅ 已切换后端为 OpenClaw，当前 session: xxxxxxxx"
```

## 7.3. /session 短 ID 匹配

```
/session a1b2c3d4
  │
  ├─ 精确 UUID 匹配 → 找到 → 直接恢复
  ├─ 前缀匹配
  │    ├─ 0 个匹配 → "❌ 未找到 session"
  │    ├─ 1 个匹配 → 直接恢复
  │    └─ 多个匹配 → "❌ 短 ID 匹配多个 session，请使用更长前缀"
  └─ /session latest → 切换到最近活跃 session
```

# 8. 配置

## 8.1. Agent 配置 (`config/agents.yaml`)

**可添加任意多个 Agent，command、args 为必填**

```yaml
OpenClaw:
  command: 'openclaw'
  args: ['acp']
  short: CL # 微信端快捷命令 /cl
  logo: '🦞' # 微信聊天框Agent消息Logo

Claude Agent:
  command: 'npx'
  args: ['@agentclientprotocol/claude-agent-acp']
  short: CC
  logo: '✳️'
```

## 8.2. 全局设置 (`config/settings.yaml`)

```yaml
displayName: WeChat ACP Bridge
Agent:
  session_timeout: 30 # Session 超时（分钟），默认 30
```

# 9. 贡献

欢迎贡献！请在GitHub]上提交 issue 或 PR。

## 9.1. 设计文档

请参考[设计文档](./DESIGN.md)。

## 9.2. 项目结构

```
src/
├── index.ts              # WeChatACPBridge 主控循环
├── cli/commands.ts       # Commander CLI 入口
├── weixin/api.ts         # WXAPI — 微信 iLink Bot HTTP 客户端
├── acp/client.ts         # AcpBridgeClient — ACP NDJSON stdio 客户端
├── bridge/router.ts      # MessageRouter — 消息路由、Session 管理
├── config/agents.ts      # Agent 配置加载与默认值
├── storage/              # 持久化层
│   ├── active-accounts.ts
│   ├── account-state.ts
│   └── session-meta.ts
├── schemas/              # Zod Schema 定义
│   ├── index.ts
│   ├── agents.ts
│   ├── account-state.ts
│   ├── session.ts
│   ├── credentials.ts
│   ├── api.ts
│   ├── runtime.ts
│   ├── settings.ts
│   └── service.ts
├── service/              # 系统服务管理（systemd/launchd）
├── util/                 # 工具
│   ├── logger.ts         # Winston 日志
│   ├── paths.ts          # 运行时目录路径
│   └── settings.ts       # 全局设置加载
config/
├── agents.yaml           # Agent 配置文件
└── settings.yaml         # 全局设置文件
```

# 10. 技术栈

| 类别       | 技术                     | 版本       | 用途                 |
| ---------- | ------------------------ | ---------- | -------------------- |
| 语言       | TypeScript               | ^6.0       | ESNext, NodeNext     |
| 运行时     | Node.js                  | ≥22        | ESM 模块系统         |
| Agent 协议 | @agentclientprotocol/sdk | ^0.21      | NDJSON-over-stdio    |
| HTTP       | axios                    | ^1.16      | 微信 API 长轮询      |
| CLI        | commander                | ^14.0      | 命令行接口           |
| 日志       | winston                  | ^3.19      | 文件+终端双输出      |
| 配置       | yaml                     | ^2.9       | YAML 解析            |
| 校验       | zod                      | ^4.4       | Schema 校验          |
| 交互       | inquirer                 | ^13.4      | 终端交互提示         |
| 二维码     | qrcode-terminal          | ^0.12      | 终端扫码             |
| 测试       | vitest                   | ^4.1       | 单元测试+覆盖率      |
| 代码规范   | ESLint + Prettier        | ^10 / ^3.8 | 代码格式与检查       |
| 提交规范   | commitlint               | ^21.0      | Conventional Commits |

# 11. 鸣谢

- [HermesClaw](https://github.com/AaronWong1999/hermesclaw) — 在同一个微信账号上同时多开 Hermes Agent、OpenClaw 和 OpenCode。
- [openclaw-weixin](https://github.com/Tencent/openclaw-weixin) — OpenClaw 的微信渠道插件，支持通过扫码完成登录授权。
- [wechat-acp](https://github.com/formulahendry/wechat-acp) — Bridge WeChat direct messages to any ACP-compatible AI agent.
- [acp-ui](https://github.com/formulahendry/acp-ui) — A modern, cross-platform client for the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) on desktop, mobile, and the web.
- [
  Agent Client Protocol (ACP)](https://github.com/agentclientprotocol)

# 12. 其他

如果OpenClaw/Hermes Agent等已启用了微信通道，在使用相同的微信账号扫码本程序登录二维码，原Agent微信通道将失效，因为同一个账号不能双开。此时，最好禁用原Agent微信通道。

# 13. License

MIT 许可证 - 详见 [MIT LICENSE](https://opensource.org/license/mit)。
