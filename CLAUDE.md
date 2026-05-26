# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
npm run check             # typecheck + lint + format:check (fast, for pre-commit)
npm run check:all         # check + jscpd + depdupes + depcheck + audit (slow, for CI / prepublish)
npm run check:jscpd       # Duplicate code detection (jscpd, threshold 5%)
npm run check:depdupes    # Check for packages in both dependencies and devDependencies
npm run check:depcheck    # Unused / missing dependency check
npm run check:audit       # Security vulnerability scan (npm audit --audit-level=high)
```

## Architecture

**WeChat ACP Bridge** — relays WeChat messages to ACP-compatible agents (OpenClaw, Hermes, OpenCode) and returns their replies.

### Module Layout

```
src/
├── index.ts           # WeChatACPBridge — main orchestrator: polls WeChat for messages,
│                      #   dispatches to router, sends reply back to WeChat
├── cli/commands.ts    # Commander-based CLI: login, start, stop, list, logout, logs, status
├── weixin/api.ts      # WXAPI — WeChat HTTP API client (QR login, long-poll getUpdates, sendText,
│                      #   sendTyping), credentials persisted to ~/.wechat-acp-bridge/accounts/
├── acp/client.ts      # AcpBridgeClient — spawns agent subprocess, communicates via ACP SDK
├── bridge/router.ts   # MessageRouter — routes messages by command prefix (/help, /new, /sessions,
│                      #   /session <key>, /<agent-short>), manages session lifecycle & persistence
└── util/logger.ts     # Winston logger (file JSON + console colorized), level persisted to log_level.json
```

### Data Flow

```
WeChat user --message--> WXAPI.getUpdates() --text--> MessageRouter.routeMessage()
  --> AcpBridgeClient.sendPrompt() --ACP--> agent subprocess (stdin/stdout NDJSON)
  <-- reply <-- AcpBridgeClient <-- ACP <--
  --> WXAPI.sendText() --> WeChat user
```

## Code Quality & Conventions

### ESLint

Config: `eslint.config.mts` (ESLint v10 flat config, TypeScript).
- Extends `typescript-eslint` recommended rules.
- `@typescript-eslint/no-explicit-any` is **off** for test files (mocking requires flexible types).
- Unused function arguments with `_` prefix are allowed (`argsIgnorePattern: "^_"`).
- Prettier integration: `eslint-config-prettier` disables formatting rules that conflict.

### Prettier

Config: `.prettierrc.json`
- `singleQuote: true`, `trailingComma: "all"`, `printWidth: 120`, `tabWidth: 2`

### Git Commit Convention

Config: `commitlint.config.mjs` (Conventional Commits)

Format: `type(scope?): message`

| type | usage |
|------|-------|
| `feat` | new feature |
| `fix` | bug fix |
| `docs` | documentation only |
| `test` | add/update tests |
| `refactor` | code change without feature/fix |
| `chore` | build, CI, deps, tooling |

Git hooks (`simple-git-hooks`): `commit-msg` runs commitlint, `pre-commit` runs `npm run check`.

### Duplicate Code Detection

Config: `.jscpd.json` — thresholds at 5%, skips test files and generated code. Run via `npm run check:jscpd`.

### Dependency Checks

- `depcheck` (`.depcheckrc.json`) — verifies all declared dependencies are used and all used packages are declared.
- `npm audit` (`check:audit`) — security scan at `high` level.
- `check:depdupes` — ensures no package appears in both `dependencies` and `devDependencies`.

## Session Management

- Each WeChat account alias maintains its own agent session state (persisted to `~/.wechat-acp-bridge/`).
- Sessions auto-timeout after 15 minutes of inactivity (configurable in `config/agents.yaml` via `session_timeout_minutes`).
- Commands: `/new` (create session), `/sessions` (list), `/session <key>` (switch), `/<short>` (switch agent, e.g. `/cl` for OpenClaw).

## Agent Configuration

`config/agents.yaml` defines available agents with `command`, `args`, `short` (command prefix). Falls back to built-in defaults (OpenClaw + Hermes) if the file is missing.

## Key Dependencies

- `@agentclientprotocol/sdk` — ACP protocol (NDJSON-over-stdio subprocess communication)
- `commander` — CLI framework (see Commander action convention below)
- `winston` — logging
- `yaml` — agent config parsing
- `vitest` — testing framework
- `typescript@^6` — ESNext target, NodeNext module resolution
- `jscpd` — duplicate code detection
- `depcheck` — unused dependency detection
- `commitlint` — git commit message validation

## Commander Action Convention

Commands use `action()` / `action1()` wrappers (defined in `src/cli/commands.ts`) to normalize Commander's parameter order:

- **No positional args**: Commander passes `(options, command)`. Use `.action(action(async (opts) => { ... }))`
- **1 positional arg**: Commander passes `(arg, options, command)`. Use `.action(action1(async (arg, opts) => { ... }))`

Never write `.action(async (_, options) => ...)` — `_` receives the real options object on commands without positional args.

## Agent Process Lifecycle

- `AcpBridgeClient` spawns the agent command as a child process on construction.
- Communication is via ACP's NDJSON streams over stdin/stdout.
- Each agent subprocess hosts one session; multiple accounts can each have their own agent process.
