import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ServiceManager, ServiceStatusResult, ServiceError } from './types.js';
import { settings } from '../util/settings.js';
import { RUN_DIR, toFsName } from '../util/paths.js';
import logger from '../util/logger.js';

const execAsync = promisify(exec);

const UNIT_NAME = `${toFsName(settings.name)}.service`;
const SYSTEMD_USER_DIR = join(homedir(), '.config', 'systemd', 'user');
const UNIT_PATH = join(SYSTEMD_USER_DIR, UNIT_NAME);

export class SystemdServiceManager implements ServiceManager {
  async install(): Promise<void> {
    await this.verifySystemd();

    if (existsSync(UNIT_PATH)) {
      logger.info('systemd user unit 已存在，正在覆盖...');
    }

    const unitContent = this.generateUnitFile();
    try {
      mkdirSync(SYSTEMD_USER_DIR, { recursive: true });
      writeFileSync(UNIT_PATH, unitContent, 'utf-8');
      logger.info(`unit 文件已写入 ${UNIT_PATH}`);
    } catch (err) {
      throw new ServiceError(`无法写入 unit 文件 ${UNIT_PATH}。详情: ${(err as Error).message}`, 'systemd');
    }

    try {
      await execAsync('systemctl --user daemon-reload');
      await execAsync(`systemctl --user enable ${UNIT_NAME}`);
      logger.info('systemd 用户服务已安装并启用');
    } catch (err) {
      throw new ServiceError(`无法启用 systemd 用户服务。详情: ${(err as Error).message}`, 'systemd');
    }
  }

  async uninstall(): Promise<void> {
    if (!existsSync(UNIT_PATH)) {
      logger.info('systemd user unit 文件不存在，无需卸载');
      return;
    }

    try {
      await this.stop().catch(() => {});
      await execAsync(`systemctl --user disable ${UNIT_NAME}`).catch(() => {});
    } catch {
      /* ignore */
    }

    try {
      unlinkSync(UNIT_PATH);
      await execAsync('systemctl --user daemon-reload');
      logger.info('systemd 用户服务已卸载');
    } catch {
      throw new ServiceError(`无法删除 unit 文件 ${UNIT_PATH}。`, 'systemd');
    }
  }

  async start(): Promise<void> {
    await this.execSystemctl('start');
  }

  async stop(): Promise<void> {
    await this.execSystemctl('stop');
  }

  async restart(): Promise<void> {
    await this.execSystemctl('restart');
  }

  async status(): Promise<ServiceStatusResult> {
    const result: ServiceStatusResult = {
      backend: 'systemd',
      installed: existsSync(UNIT_PATH),
      running: false,
      enabled: false,
      unitPath: UNIT_PATH,
    };

    if (!result.installed) return result;

    try {
      const { stdout: activeOut } = await execAsync(`systemctl --user is-active ${UNIT_NAME}`);
      result.running = activeOut.trim() === 'active';
    } catch {
      /* is-active exits non-zero when inactive */
    }

    try {
      const { stdout: enabledOut } = await execAsync(`systemctl --user is-enabled ${UNIT_NAME}`);
      result.enabled = enabledOut.trim() === 'enabled';
    } catch {
      /* is-enabled exits non-zero when disabled */
    }

    if (result.running) {
      try {
        const { stdout: pidOut } = await execAsync(`systemctl --user show ${UNIT_NAME} --property=MainPID --value`);
        const pid = parseInt(pidOut.trim(), 10);
        if (pid > 0) result.pid = pid;
      } catch {
        /* ignore */
      }
    }

    return result;
  }

  private generateUnitFile(): string {
    const nodePath = process.execPath;
    const scriptPath = process.argv[1];
    const cwd = process.cwd();
    const logDir = join(RUN_DIR, 'logs');

    return [
      '[Unit]',
      `Description=${settings.displayName}`,
      'After=network.target',
      '',
      '[Service]',
      `ExecStart=${nodePath} ${scriptPath} run`,
      'Restart=always',
      `WorkingDirectory=${cwd}`,
      `StandardOutput=append:${join(logDir, 'service.log')}`,
      `StandardError=append:${join(logDir, 'service-error.log')}`,
      'Environment=NODE_ENV=production',
      'TimeoutStopSec=30',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
  }

  private async verifySystemd(): Promise<void> {
    try {
      await execAsync('systemctl --version');
    } catch {
      throw new ServiceError('当前系统不支持 systemd', 'systemd');
    }
  }

  private async execSystemctl(action: 'start' | 'stop' | 'restart'): Promise<void> {
    if (!existsSync(UNIT_PATH)) {
      throw new ServiceError(`服务未安装，请先执行 "${settings.name} install"`, 'systemd');
    }
    try {
      await execAsync(`systemctl --user ${action} ${UNIT_NAME}`);
      logger.info(`systemd 用户服务已${action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启'}`);
    } catch (err) {
      throw new ServiceError(`systemctl --user ${action} 失败。详情: ${(err as Error).message}`, 'systemd');
    }
  }
}
