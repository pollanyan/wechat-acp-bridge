import type { ServiceStatusResult } from '../schemas/service.js';
export type { ServiceStatusResult };

export interface ServiceManager {
  install(): Promise<void>;
  uninstall(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<ServiceStatusResult>;
}

export class ServiceError extends Error {
  constructor(
    message: string,
    public readonly backend: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}
