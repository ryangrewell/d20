/**
 * Local development server. Hosts the same Hono API that runs in Lambda,
 * a WebSocket hub standing in for AppSync Events, and the dev auth emulator.
 * Requires `npm run dev:infra` (DynamoDB Local + MinIO).
 */
import { serve } from '@hono/node-server';
import { loadConfig } from '@server/config';
import { createDeps } from '@server/bootstrap';
import { createVerifier } from '@server/auth/verify';
import { createApp } from '@server/http/app';
import { LocalHub } from '@server/realtime/localHub';
import { ensureLocalTable } from '@server/repo/schema';
import { registerDevAuth } from './auth';

const env: NodeJS.ProcessEnv = {
  D20_TABLE: 'd20-local',
  D20_BUCKET: 'd20-local-media',
  D20_DYNAMO_ENDPOINT: 'http://localhost:8000',
  D20_S3_ENDPOINT: 'http://localhost:9100',
  ...process.env,
};
const config = loadConfig(env);
if (config.auth.mode !== 'dev') throw new Error('The local dev server only supports dev auth.');
const port = Number(env.D20_PORT ?? 8787);

await ensureLocalTable(config.dynamoEndpoint!, config.region, config.tableName).then((created) => created && console.log(`[dev] created table ${config.tableName}`));

const deps = createDeps({ config });
const verify = createVerifier(config.auth);
const hub = new LocalHub(deps, verify);
deps.publisher = hub;
await deps.blobs.ensureLocalBucket(['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173']).catch((e) => {
  console.error('[dev] MinIO not reachable. Run `npm run dev:infra`.', (e as Error).message);
});

const secret = config.auth.secret;
const app = createApp(deps, verify, (a) => registerDevAuth(a as never, deps.db, secret));

const server = serve({ fetch: app.fetch, port }, () => console.log(`[dev] API on http://localhost:${port}/api  (realtime ws://localhost:${port}/ws)`));
server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/ws')) return socket.destroy();
  hub.wss.handleUpgrade(req, socket, head, (ws) => hub.wss.emit('connection', ws, req));
});
