#!/usr/bin/env node
import { readFileSync, createReadStream, watch, constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { Command } from 'commander';

/**
 * Commander action 参数规范：
 * - 有 N 个位置参数 → (...args, options, command)
 * - 无位置参数       → (options, command)
 *
 * 以下 helper 将参数规范化，避免误写 _(占位) 导致 options 错位。
 * 用法：.action(action((opts) => { ... }))          // 无位置参数
 *       .action(action1((arg, opts) => { ... }))    // 1 个位置参数
 */

/** 命令无位置参数时使用：params[0] = options */
function action<TOpts>(handler: (opts: TOpts) => void | Promise<void>): (...args: unknown[]) => void {
  return (...args: unknown[]) => handler((args[0] ?? {}) as TOpts);
}

/** 命令有 1 个位置参数时使用：params[0] = arg, params[1] = options */
function action1<TArg, TOpts>(handler: (arg: TArg, opts: TOpts) => void | Promise<void>): (...args: unknown[]) => void {
  return (...args: unknown[]) => handler(args[0] as TArg, (args[1] ?? {}) as TOpts);
}
import { WXAPI } from '../weixin/api.js';
import { WeChatACPBridge } from '../index.js';
import logger, { getLogFilePath, getLogLevel, setLogLevel } from '../util/logger.js';
import { getPidFile } from '../util/paths.js';
import { settings } from '../util/settings.js';
import { getServiceManager } from '../service/manager.js';
import { ServiceError } from '../service/types.js';
import { detectServiceBackend } from '../util/platform.js';
import { loadAgentDisplayNames } from '../config/agents.js';
import { readActiveAliases, writeActiveAliases } from '../storage/active-accounts.js';
import { readAccountState } from '../storage/account-state.js';
import { readSessionSummary } from '../storage/session-meta.js';

const program = new Command();

program.name(settings.name).version(settings.version);

program.addHelpText(
  'after',
  `
━━━━━━━━━━━━━━━━━━━━
CLI 服务管理命令：

  run              - 前台运行桥接器服务进程
  start            - 启动后台服务（systemd / launchd）
  stop             - 停止桥接器服务（后台服务或前台进程）
  restart          - 重启后台服务
  install          - 安装为系统服务
  uninstall        - 卸载系统服务

━━━━━━━━━━━━━━━━━━━━
微信端命令（在微信聊天中发送）：

  会话管理：
    /h             - 显示本帮助
    /new           - 创建新会话（重置上下文）
    /sessions      - 列出历史会话
    /session <key> - 切换到指定会话

  Agent 切换：
    /<short>       - 切换到指定 Agent（如 /cl、/ha）

  直接发送文本即可与当前 Agent 对话。发送 /h 获取微信端帮助。
`,
);

// login — 扫码登录，自动激活
program
  .command('login [alias]')
  .description('扫码登录微信，账号别名可选，默认 alias 为 default，登录后自动激活')
  .option('-a, --alias <alias>', '指定账号别名，默认 default')
  .option('-f, --force', '强制重新登录，跳过已有凭证时的确认提示')
  .action(
    action1(async (alias?: string, options?: { alias?: string; force?: boolean }) => {
      const accountId = options?.alias || alias || 'default';
      const api = new WXAPI(accountId);

      const hasCredentials = await api.loadCredentials();
      if (hasCredentials && !options?.force) {
        const { default: inquirer } = await import('inquirer');
        const answer = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'forceLogin',
            message: `账号 '${accountId}' 已有登录凭证，是否强制重新扫码登录？`,
            default: false,
          },
        ]);
        if (!answer.forceLogin) {
          logger.info('已取消登录');
          return;
        }
      }

      const creds = await api.login();
      logger.info('✅ 登录成功');
      logger.info(`   账号别名: ${accountId}`);
      logger.debug(`   Token: ${creds.token.substring(0, 20)}...`);
      logger.info(`   Bot ID: ${creds.accountId}`);
      if (creds.userId) {
        logger.info(`   User ID: ${creds.userId}`);
      }

      // 自动激活
      try {
        const aliases = readActiveAliases();
        if (!aliases.includes(accountId)) {
          aliases.push(accountId);
          writeActiveAliases(aliases);
          logger.info(`✅ 已自动激活账号 '${accountId}'`);
        }
      } catch (err) {
        logger.warn('⚠️ 无法更新激活账号列表: %O', err);
      }
    }),
  );

// run — 前台运行服务进程
program
  .command('run')
  .description('前台运行桥接器服务进程，为所有激活账号提供桥接服务')
  .action(
    action(async () => {
      // 检查是否已在运行
      try {
        const pid = readFileSync(getPidFile(), 'utf-8');
        process.kill(parseInt(pid), 0);
        logger.info(`ℹ️  桥接器已在运行 (PID: ${pid})，无需重复启动`);
        return;
      } catch {
        // 未运行，继续
      }

      const activeAliases = readActiveAliases();
      if (activeAliases.length === 0) {
        logger.warn('⚠️  无激活账号，服务进程将空跑');
        logger.info('💡 请先执行 login 登录账号，或执行 activate <alias> 激活已有账号');
      } else {
        logger.info(`✅ 已激活账号: ${activeAliases.join(', ')}`);
        const agentNames = loadAgentDisplayNames();
        const defaultAgentKey = Object.keys(agentNames)[0];
        for (const alias of activeAliases) {
          const state = readAccountState(alias);
          const agentKey = state?.currentAgentKey || defaultAgentKey;
          const agentName = agentNames[agentKey] || agentKey;
          logger.info(`   ${alias}: 当前 Agent - ${agentName}`);
        }
      }

      const bridge = new WeChatACPBridge();
      await bridge.run();
    }),
  );

// start — 启动后台服务（systemd/launchd）
program
  .command('start')
  .description('启动后台服务（systemd / launchd）')
  .action(
    action(async () => {
      try {
        const mgr = await getServiceManager();
        const svcStatus = await mgr.status();
        if (svcStatus.running) {
          logger.info(`ℹ️  后台服务已在运行 (PID: ${svcStatus.pid ?? 'unknown'})`);
          return;
        }
        if (!svcStatus.installed) {
          logger.error(`❌ 后台服务未安装，请先执行 "${settings.name} install"`);
          return;
        }
        await mgr.start();
        logger.info('✅ 后台服务已启动');
      } catch (err) {
        if (err instanceof ServiceError) {
          logger.error(`❌ 启动失败: ${err.message}`);
        } else {
          logger.error('❌ 启动失败: %O', err);
        }
      }
    }),
  );

// stop — 停止服务进程（优先服务管理器，fallback PID 信号）
program
  .command('stop')
  .description('停止桥接器服务（后台服务或前台进程）')
  .action(
    action(async () => {
      try {
        const mgr = await getServiceManager();
        const svcStatus = await mgr.status();
        if (svcStatus.installed && svcStatus.running) {
          await mgr.stop();
          logger.info('✅ 后台服务已停止');
          return;
        }
      } catch (err) {
        if (!(err instanceof ServiceError)) {
          logger.error('❌ 停止后台服务失败: %O', err);
        }
      }
      // Fallback: PID 信号停止前台进程
      try {
        const pid = readFileSync(getPidFile(), 'utf-8');
        process.kill(parseInt(pid), 'SIGTERM');
        logger.info('✅ 已停止前台进程');
      } catch {
        logger.error('❌ 服务未运行（既无后台服务也无前台进程）');
      }
    }),
  );

// restart — 重启后台服务
program
  .command('restart')
  .description('重启后台服务（systemd / launchd）')
  .action(
    action(async () => {
      try {
        const mgr = await getServiceManager();
        await mgr.restart();
        logger.info('✅ 后台服务已重启');
      } catch (err) {
        if (err instanceof ServiceError) {
          logger.error(`❌ 重启失败: ${err.message}`);
        } else {
          logger.error('❌ 重启失败: %O', err);
        }
      }
    }),
  );

// install — 安装为后台服务
program
  .command('install')
  .description('安装桥接器为系统服务（Linux systemd / macOS launchd）')
  .action(
    action(async () => {
      try {
        const mgr = await getServiceManager();
        await mgr.install();
        logger.info(`✅ 系统服务已安装，使用 "${settings.name} start" 启动`);
        if (detectServiceBackend() === 'systemd') {
          logger.info(
            '💡 Linux 系统：开启 linger 后，用户实例会在开机时启动、关机时停止，不再受登录/登出行为影响，从而保证休眠恢复时服务正常，请执行：',
          );
          logger.info(`   sudo loginctl enable-linger $USER`);
        }
      } catch (err) {
        if (err instanceof ServiceError) {
          logger.error(`❌ 安装失败: ${err.message}`);
        } else {
          logger.error('❌ 安装失败: %O', err);
        }
      }
    }),
  );

// uninstall — 卸载后台服务
program
  .command('uninstall')
  .description('卸载桥接器系统服务')
  .action(
    action(async () => {
      try {
        const mgr = await getServiceManager();
        await mgr.uninstall();
        logger.info('✅ 系统服务已卸载');
      } catch (err) {
        if (err instanceof ServiceError) {
          logger.error(`❌ 卸载失败: ${err.message}`);
        } else {
          logger.error('❌ 卸载失败: %O', err);
        }
      }
    }),
  );

// activate — 激活已登录账号
program
  .command('activate <alias>')
  .description('激活指定已登录账号，使其参与桥接服务（实时生效）')
  .action(
    action1(async (alias: string) => {
      // 检查凭证是否存在
      const api = new WXAPI(alias);
      const loggedIn = await api.loadCredentials();
      if (!loggedIn) {
        logger.error(`❌ 账号 '${alias}' 未登录，请先执行: ${settings.name} login ${alias}`);
        return;
      }

      const aliases = readActiveAliases();
      if (aliases.includes(alias)) {
        logger.info(`ℹ️  账号 '${alias}' 已处于激活状态`);
        return;
      }

      aliases.push(alias);
      writeActiveAliases(aliases);
      logger.info(`✅ 已激活账号 '${alias}'，实时生效`);
    }),
  );

// deactivate — 去激活账号
program
  .command('deactivate <alias>')
  .description('去激活指定账号，停止其桥接服务（实时生效）')
  .action(
    action1(async (alias: string) => {
      // 检查凭证是否存在
      const api = new WXAPI(alias);
      const loggedIn = await api.loadCredentials();
      if (!loggedIn) {
        logger.error(`❌ 账号 '${alias}' 未登录，请先执行: ${settings.name} login ${alias}`);
        return;
      }

      const aliases = readActiveAliases();
      if (!aliases.includes(alias)) {
        logger.info(`ℹ️  账号 '${alias}' 未处于激活状态`);
        return;
      }

      const remaining = aliases.filter((a) => a !== alias);
      writeActiveAliases(remaining);
      logger.info(`✅ 已去激活账号 '${alias}'，实时生效`);
    }),
  );

// list — 列出所有已保存账号
program
  .command('list')
  .description('列出所有已保存的微信账号别名')
  .action(
    action(async () => {
      const accounts = await WXAPI.getSavedAccounts();
      if (accounts.length === 0) {
        logger.error('❌ 未检测到任何已保存账号');
        return;
      }
      const activeAliases = readActiveAliases();
      logger.info('已保存账号列表:');
      for (const id of accounts) {
        const api = new WXAPI(id);
        const loggedIn = await api.loadCredentials();
        const activated = activeAliases.includes(id);
        const status = loggedIn ? `✅ 有效${activated ? ' (已激活)' : ''}` : '❌ 已失效';
        logger.info(`  - ${id}: ${status}`);
      }
    }),
  );

// logout — 删除账号凭证
program
  .command('logout <accountId>')
  .description('删除指定账号别名的登录凭证，同时去激活该账号')
  .action(
    action1(async (accountId: string) => {
      const deleted = await WXAPI.deleteSavedAccount(accountId);
      if (!deleted) {
        logger.error(`❌ 未找到账号凭证: ${accountId}`);
        return;
      }

      // 同时从激活列表移除
      try {
        const aliases = readActiveAliases();
        const remaining = aliases.filter((a) => a !== accountId);
        if (remaining.length < aliases.length) {
          writeActiveAliases(remaining);
          logger.info(`✅ 已删除账号凭证并去激活: ${accountId}`);
        } else {
          logger.info(`✅ 已删除账号凭证: ${accountId}`);
        }
      } catch (err) {
        logger.warn('注销时更新激活列表失败: %s', (err as Error).message);
        logger.info(`✅ 已删除账号凭证: ${accountId}`);
      }
    }),
  );

// logs — 查看/设置日志
program
  .command('logs')
  .description('查看或修改日志级别，并可实时跟随日志文件')
  .option('-l, --level <level>', '设置日志级别：DEBUG、INFO、WARNING、ERROR')
  .option('-f, --follow', 'Follow the log in real time (like tail -f)')
  .action(async (options?: { level?: string; follow?: boolean }) => {
    let currentLevel = getLogLevel();

    if (options?.level) {
      try {
        currentLevel = setLogLevel(options.level);
        logger.info(`日志级别已设置为 ${currentLevel.toUpperCase()}`);
      } catch (err: unknown) {
        logger.error('日志级别设置失败: %s', (err as Error).message || err);
        process.exit(1);
      }
    }

    const logPath = getLogFilePath();
    if (options?.follow) {
      process.stdout.write(`正在跟随日志: ${logPath}\n`);
      process.stdout.write(`当前日志级别: ${currentLevel.toUpperCase()}\n`);
      followLogFile(logPath).catch((err) => {
        logger.error('实时跟随日志失败: %O', err);
        process.exit(1);
      });
      return;
    }

    process.stdout.write(`日志文件: ${logPath}\n`);
    process.stdout.write(`当前日志级别: ${currentLevel.toUpperCase()}\n`);
  });

/** 格式化时间戳为人类可读的相对时间（刚刚 / N 分钟前 / N 小时前 / N 天前） */
function formatTimeAgo(timestamp: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

// status — 查看状态
program
  .command('status [alias]')
  .description('查看登录账号、当前 Agent、Session 及运行状态')
  .option('-a, --alias <alias>', '指定账号别名查看状态')
  .action(
    action1(async (alias?: string, options?: { alias?: string }) => {
      const selectedAlias = options?.alias || alias;
      const agentNames = loadAgentDisplayNames();

      if (selectedAlias) {
        const api = new WXAPI(selectedAlias);
        const loggedIn = await api.loadCredentials();
        const activeAliases = readActiveAliases();
        const activated = activeAliases.includes(selectedAlias);

        if (loggedIn) {
          logger.info(`✅ ${selectedAlias} 已登录${activated ? ' (已激活)' : ''}`);
        } else {
          logger.info(`❌ ${selectedAlias} 未登录或凭证已失效`);
          return;
        }

        // 读取当前 Agent 和 Session 信息
        const state = readAccountState(selectedAlias);
        if (state?.currentAgentKey) {
          const agentKey = state.currentAgentKey;
          const agentName = agentNames[agentKey] || agentKey;
          logger.info(`   Agent: ${agentName} (${agentKey})`);

          const sessionKey = state.sessions?.[agentKey];
          if (sessionKey) {
            const session = readSessionSummary(selectedAlias, agentKey, sessionKey);
            if (session) {
              const desc = session.description || '无描述';
              logger.info(`   Session: ${sessionKey}`);
              logger.info(`   描述: ${desc}`);
              logger.info(`   最近活跃: ${formatTimeAgo(session.lastActive)}`);
            } else {
              logger.info(`   Session: ${sessionKey} (元数据已清理)`);
            }
          } else {
            logger.info('   Session: 暂无');
          }
        } else {
          logger.info('   Agent/Session: 暂无（首次消息后自动创建）');
        }
      } else {
        const accounts = await WXAPI.getSavedAccounts();
        if (accounts.length === 0) {
          logger.error('❌ 未检测到任何已登录账号');
        } else {
          const activeAliases = readActiveAliases();
          logger.info('已登录账号列表:');
          for (const id of accounts) {
            const api = new WXAPI(id);
            const loggedIn = await api.loadCredentials();
            const activated = activeAliases.includes(id);
            const state = readAccountState(id);
            const agentKey = state?.currentAgentKey;
            const agentSuffix = agentKey ? ` | Agent: ${agentNames[agentKey] || agentKey}` : '';
            logger.info(
              `  - ${id}: ${loggedIn ? `✅ 可用${activated ? ' (已激活)' : ''}${agentSuffix}` : '❌ 已失效'}`,
            );
          }
        }
      }

      // 检查进程运行状态
      let foregroundRunning = false;
      try {
        const pid = readFileSync(getPidFile(), 'utf-8');
        process.kill(parseInt(pid), 0);
        foregroundRunning = true;
      } catch {
        // 未运行
      }

      // 检查后台服务状态
      try {
        const mgr = await getServiceManager();
        const svcStatus = await mgr.status();
        if (svcStatus.backend !== 'none') {
          logger.info(`后台服务: ${svcStatus.backend}`);
          logger.info(`  已安装: ${svcStatus.installed ? '✅' : '❌'}`);
          if (svcStatus.installed) {
            logger.info(`  已启用: ${svcStatus.enabled ? '✅' : '❌'}`);
            logger.info(`  运行中: ${svcStatus.running ? '✅' : '❌'}`);
            if (svcStatus.pid) logger.info(`  PID: ${svcStatus.pid}`);
            if (svcStatus.unitPath) logger.info(`  配置: ${svcStatus.unitPath}`);
          }
        }
      } catch {
        // 非 systemd/launchd 平台，跳过
      }

      if (foregroundRunning) {
        logger.info('✅ 前台进程运行中');
      } else {
        logger.info('前台进程: 未运行');
      }
    }),
  );

/**
 * 实时跟随日志文件（类似 tail -f）。
 * 通过 fs.watch 监听文件变化，读取增量部分并写入 stdout。
 * 阻塞直到 SIGINT 终止。
 */
async function followLogFile(filePath: string): Promise<void> {
  try {
    await access(filePath, constants.R_OK);
  } catch {
    process.stdout.write(`日志文件不存在: ${filePath}\n`);
    process.exit(1);
  }

  let lastSize = (await stat(filePath)).size;

  const readNewContent = async () => {
    const fileStat = await stat(filePath);
    if (fileStat.size > lastSize) {
      const stream = createReadStream(filePath, { encoding: 'utf8', start: lastSize, end: fileStat.size });
      stream.on('data', (chunk) => process.stdout.write(chunk));
      stream.on('end', () => {
        lastSize = fileStat.size;
      });
    }
  };

  const watcher = watch(filePath, async (eventType) => {
    if (eventType === 'change') {
      await readNewContent();
    }
  });

  process.on('SIGINT', () => {
    watcher.close();
    process.exit(0);
  });

  await readNewContent();
  await new Promise(() => undefined);
}

program.parse();
