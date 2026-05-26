import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ServiceManager, ServiceStatusResult, ServiceError } from './types.js';
import { settings } from '../util/settings.js';
import { RUN_DIR } from '../util/paths.js';
import logger from '../util/logger.js';

const execAsync = promisify(exec);

const LABEL = settings.name;
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

export class LaunchdServiceManager implements ServiceManager {
  async install(): Promise<void> {
    const dir = join(homedir(), 'Library', 'LaunchAgents');
    mkdirSync(dir, { recursive: true });

    if (existsSync(PLIST_PATH)) {
      logger.info('launchd plist 已存在，正在覆盖...');
    }

    const plistContent = this.generatePlist();
    writeFileSync(PLIST_PATH, plistContent, 'utf-8');
    logger.info(`plist 已写入 ${PLIST_PATH}`);

    try {
      await execAsync(`launchctl bootstrap gui/$(id -u) ${PLIST_PATH}`);
      logger.info('launchd 服务已安装并启动');
    } catch (err) {
      throw new ServiceError(`无法 bootstrap launchd 服务。详情: ${(err as Error).message}`, 'launchd');
    }
  }

  async uninstall(): Promise<void> {
    if (!existsSync(PLIST_PATH)) {
      logger.info('launchd plist 不存在，无需卸载');
      return;
    }

    try {
      await execAsync(`launchctl bootout gui/$(id -u)/${LABEL}`).catch(() => {});
    } catch {
      /* ignore */
    }

    unlinkSync(PLIST_PATH);
    logger.info('launchd 服务已卸载');
  }

  async start(): Promise<void> {
    if (!existsSync(PLIST_PATH)) {
      throw new ServiceError(`服务未安装，请先执行 "${settings.name} install"`, 'launchd');
    }
    try {
      await execAsync(`launchctl kickstart gui/$(id -u)/${LABEL}`);
      logger.info('launchd 服务已启动');
    } catch (err) {
      throw new ServiceError(`launchctl kickstart 失败。详情: ${(err as Error).message}`, 'launchd');
    }
  }

  async stop(): Promise<void> {
    if (!existsSync(PLIST_PATH)) {
      throw new ServiceError(`服务未安装，请先执行 "${settings.name} install"`, 'launchd');
    }
    try {
      await execAsync(`launchctl kill SIGTERM gui/$(id -u)/${LABEL}`).catch(() => {});
      logger.info('launchd 服务已停止');
    } catch (err) {
      throw new ServiceError(`launchctl kill 失败。详情: ${(err as Error).message}`, 'launchd');
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async status(): Promise<ServiceStatusResult> {
    const result: ServiceStatusResult = {
      backend: 'launchd',
      installed: existsSync(PLIST_PATH),
      running: false,
      enabled: false,
      unitPath: PLIST_PATH,
    };

    if (result.installed) {
      result.enabled = true;

      try {
        const { stdout } = await execAsync(`launchctl list ${LABEL}`);
        const pidMatch = stdout.match(/"PID"\s*=\s*(\d+)/);
        if (pidMatch) {
          result.pid = parseInt(pidMatch[1], 10);
          result.running = result.pid > 0;
        }
      } catch (err) {
        result.error = `launchctl list 失败: ${(err as Error).message}`;
      }
    }

    return result;
  }

  private generatePlist(): string {
    const nodePath = process.execPath;
    const scriptPath = process.argv[1];
    const cwd = process.cwd();
    const logDir = join(RUN_DIR, 'logs');

    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '    <key>Label</key>',
      `    <string>${LABEL}</string>`,
      '    <key>ProgramArguments</key>',
      '    <array>',
      `        <string>${nodePath}</string>`,
      `        <string>${scriptPath}</string>`,
      '        <string>run</string>',
      '    </array>',
      '    <key>RunAtLoad</key>',
      '    <true/>',
      '    <key>KeepAlive</key>',
      '    <true/>',
      '    <key>WorkingDirectory</key>',
      `    <string>${cwd}</string>`,
      '    <key>StandardOutPath</key>',
      `    <string>${join(logDir, 'service.log')}</string>`,
      '    <key>StandardErrorPath</key>',
      `    <string>${join(logDir, 'service-error.log')}</string>`,
      '    <key>EnvironmentVariables</key>',
      '    <dict>',
      '        <key>NODE_ENV</key>',
      '        <string>production</string>',
      '    </dict>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n');
  }
}
