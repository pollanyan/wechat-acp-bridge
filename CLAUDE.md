# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code)
when working with code in this repository.

## Build & Test Commands

```bash
# Type-check without emitting
npm run typecheck

# Build TypeScript
npm run build

# Clean build output
npm run clean

# Run all tests (with coverage)
npm test

# Run tests in watch mode
npm run test:dev

# Run a single test file
npx vitest src/acp/client.test.ts

# Run a single test (by name pattern)
npx vitest src/acp/client.test.ts -t "sendPrompt"

# Start in development mode
npm run dev

# Install locally (build + link)
bash scripts/install.sh
```

### Lint & Format

```bash
npm run lint              # ESLint check
npm run lint:fix          # ESLint auto-fix
npm run format            # Prettier --write
npm run format:check      # Prettier --check (dry-run)
npm run fix               # format + lint:fix (one-shot cleanup)
```

### Comprehensive Checks

```bash
npm run check             # typecheck + lint + format:check
npm run check:all         # check + jscpd + depdupes + depcheck + audit
npm run check:jscpd       # Duplicate code detection (jscpd, 5%)
npm run check:depdupes    # Packages in deps + devDeps
npm run check:depcheck    # Unused / missing dependency check
npm run check:audit       # Security scan (npm audit --audit-level=high)
```

## Architecture

**WeChat ACP Bridge** — relays WeChat messages to ACP-compatible
agents (OpenClaw, Hermes, OpenCode, Claude Code) and returns
their replies.

### Module Layout

```text
src/
├── index.ts           # WeChatACPBridge — main orchestrator
│                      #   supervisorLoop (10s) reloads active
│                      #   accounts, polls messages via WXAPI,
│                      #   dispatches to router. PID guard.
├── cli/commands.ts    # Commander CLI: login, run, start/stop/
│                      #   restart, install/uninstall, activate/
│                      #   deactivate, list, logout, logs, status.
│                      #   Uses action()/action1() wrappers.
├── weixin/api.ts      # WXAPI — WeChat iLink Bot HTTP client.
│                      #   QR login, long-poll getUpdates (35s),
│                      #   sendText, sendTyping. Credentials in
│                      #   ~/.wechat-acp-bridge/run/accounts/
├── acp/client.ts      # AcpBridgeClient (EventEmitter) — spawns
│                      #   agent subprocess, ACP over NDJSON
│                      #   stdin/stdout. 'error' listener prevents
│                      #   crash on spawn failure.
├── bridge/router.ts   # MessageRouter — routes by command prefix
│                      #   (/h, /new, /sessions, /session <key>,
│                      #   /<agent-short>), manages session
│                      #   lifecycle, persists state to disk.
├── config/agents.ts   # Loads config/agents.yaml; fallback to
│                      #   built-in defaults (OpenClaw, Hermes,
│                      #   OpenCode). Exports AGENT_CONFIGS,
│                      #   AGENT_COMMAND_MAP, etc.
├── service/
│   ├── types.ts       # ServiceManager interface, errors
│   ├── systemd.ts     # SystemdServiceManager — systemctl --user.
│   │                  #   generateUnitFile() bakes PATH + NODE_ENV
│   ├── launchd.ts     # LaunchdServiceManager (macOS)
│   └── manager.ts     # getServiceManager() — auto-detect
├── storage/
│   ├── active-accounts.ts  # read/write active_accounts.json
│   ├── account-state.ts    # per-account agent/session state
│   └── session-meta.ts     # session metadata CRUD
├── schemas/           # Zod schemas
│   ├── agents.ts, api.ts, credentials.ts, index.ts,
│   └── runtime.ts, settings.ts
└── util/
    ├── logger.ts      # Winston (file JSON + console colorized)
    ├── paths.ts       # RUN_DIR, getPidFile, etc.
    ├── platform.ts    # detectServiceBackend()
    └── settings.ts    # Loads package.json + config/settings.yaml
```

### Data Flow

```text
WeChat user --msg--> WXAPI.getUpdates()
  --text--> MessageRouter.routeMessage()
  --> AcpBridgeClient.sendPrompt()
  --ACP--> agent subprocess (stdin/stdout NDJSON)
  <-- reply <-- AcpBridgeClient
  --> WXAPI.sendText() --> WeChat user

Each account runs an independent WXAPI pollAccount() IIFE.
Supervisor loop (10s) hot-reloads active_accounts.json.
```

## Code Quality & Conventions

### ESLint

Config: `eslint.config.mts` (ESLint v10 flat, TypeScript).

- Extends `typescript-eslint` recommended rules.
- `@typescript-eslint/no-explicit-any` is **off** for test files.
- Unused args with `_` prefix allowed (`argsIgnorePattern: "^_"`).
- Prettier integration via `eslint-config-prettier`.

### Prettier

Config: `.prettierrc.json`

- `singleQuote: true`, `trailingComma: "all"`
- `printWidth: 120`, `tabWidth: 2`

### Git Commit Convention

Config: `commitlint.config.mjs` (Conventional Commits)

Format: `type(scope?): message`

| type       | usage                       |
| ---------- | --------------------------- |
| `feat`     | new feature                 |
| `fix`      | bug fix                     |
| `docs`     | documentation only          |
| `test`     | add/update tests            |
| `refactor` | code change without feature |
| `chore`    | build, CI, deps, tooling    |

Git hooks (`simple-git-hooks`):
`commit-msg` runs commitlint, `pre-commit` runs `npm run check`.

### Duplicate Code Detection

Config: `.jscpd.json` — threshold 5%, skips test files and
generated code. Run via `npm run check:jscpd`.

### Dependency Checks

- `depcheck` (`.depcheckrc.json`) — verifies all used deps
  are declared and vice versa.
- `npm audit` (`check:audit`) — security scan at `high`.
- `check:depdupes` — no package in both deps + devDeps.

## Session Management

- Each account has its own agent session state (persisted to
  `~/.wechat-acp-bridge/run/`).
- Sessions auto-timeout after inactivity (configurable in
  `config/settings.yaml` via `Agent.session_timeout`,
  default 30 minutes).
- Commands: `/new`, `/sessions`, `/session <key>`
  (supports prefix matching and `latest`), `/<short>`
  (switch agent, e.g. `/oc` for OpenCode).

## Agent Configuration

`config/agents.yaml` defines agents with `command`, `args`,
`short`, `logo`, and `description`. Falls back to built-in
defaults (OpenClaw, Hermes, OpenCode) if missing.

## Key Dependencies

- `@agentclientprotocol/sdk` — ACP protocol over stdio
- `axios` — HTTP client for WeChat API
- `commander` — CLI framework
- `winston` — logging
- `yaml` / `js-yaml` — agent config parsing
- `zod` — schema validation
- `vitest` — testing framework
- `typescript@^6` — ESNext, NodeNext module resolution
- `jscpd` — duplicate code detection
- `depcheck` — unused dependency detection
- `commitlint` — commit message validation

## Commander Action Convention

Use `action()` / `action1()` wrappers (defined in
`src/cli/commands.ts`) to normalize Commander params:

- **No positional args**: `.action(action(async (opts) => {...}))`
- **1 positional arg**: `.action(action1(async (arg, opts) => {...}))`

Never write `.action(async (_, options) => ...)` — `_` gets the
real options object on arg-less commands.

## Agent Process Lifecycle

- `AcpBridgeClient` spawns the agent as a child process on
  construction.
- Communication via ACP NDJSON streams over stdin/stdout.
- An `'error'` listener prevents uncaught exceptions when
  spawn fails (e.g. command not found due to PATH mismatch).
- Each agent subprocess hosts one session; multiple accounts
  can each have their own agent process.
