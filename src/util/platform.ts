export type Platform = 'linux' | 'darwin' | 'win32' | 'unknown';
export type ServiceBackend = 'systemd' | 'launchd' | 'none';

export function detectPlatform(): Platform {
  if (process.platform === 'linux') return 'linux';
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'win32';
  return 'unknown';
}

export function detectServiceBackend(): ServiceBackend {
  if (process.platform === 'linux') return 'systemd';
  if (process.platform === 'darwin') return 'launchd';
  return 'none';
}
