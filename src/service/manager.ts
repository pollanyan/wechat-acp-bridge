import { detectServiceBackend } from '../util/platform.js';
import { ServiceManager, ServiceError } from './types.js';

let cached: ServiceManager | null = null;

export async function getServiceManager(): Promise<ServiceManager> {
  if (cached) return cached;

  const backend = detectServiceBackend();
  if (backend === 'systemd') {
    const { SystemdServiceManager } = await import('./systemd.js');
    cached = new SystemdServiceManager();
    return cached;
  }
  if (backend === 'launchd') {
    const { LaunchdServiceManager } = await import('./launchd.js');
    cached = new LaunchdServiceManager();
    return cached;
  }
  throw new ServiceError('当前平台不支持后台服务管理（需要 systemd 或 launchd）', backend);
}
