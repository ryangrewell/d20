import { loadConfig, type ServerConfig } from './config';
import { Db } from './repo/db';
import { Blobs } from './storage/blobs';
import { createPublisher, type Publisher } from './realtime/publisher';
import type { Deps } from './context';
import { CognitoDirectory, DevDirectory } from './auth/directory';

/** Structured JSON logs. Never pass tokens, presigned URLs, or message bodies here. */
export function jsonLogger(level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) {
  const line = JSON.stringify({ level, msg, time: new Date().toISOString(), ...meta });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function createDeps(opts: { config?: ServerConfig; publisher?: Publisher; now?: () => Date } = {}): Deps {
  const config = opts.config ?? loadConfig();
  // Publisher may be wired later (local hub needs deps first); see setPublisher.
  const placeholder: Publisher = { publish: async () => undefined };
  const db = new Db(config);
  return {
    config,
    db,
    directory: config.auth.mode === 'cognito' ? new CognitoDirectory(config.auth.userPoolId, config.auth.region) : new DevDirectory(db),
    blobs: new Blobs(config),
    publisher: opts.publisher ?? (config.realtime.mode === 'appsync' ? createPublisher(config.realtime) : placeholder),
    now: opts.now ?? (() => new Date()),
    log: jsonLogger,
  };
}
