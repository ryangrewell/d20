/** Backend configuration. Read once from the environment; never exposed to the browser. */
export type ServerConfig = {
  tableName: string;
  bucketName: string;
  region: string;
  dynamoEndpoint?: string;
  s3Endpoint?: string;
  s3PublicEndpoint?: string;
  s3ForcePathStyle: boolean;
  maxMapUploadBytes: number;
  maxMapPixelCount: number;
  eventRetentionDays: number;
  auth:
    | { mode: 'cognito'; userPoolId: string; clientId: string; region: string }
    | { mode: 'dev'; secret: string };
  realtime:
    | { mode: 'appsync'; httpEndpoint: string; region: string }
    | { mode: 'local' };
};

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const region = env.AWS_REGION ?? env.D20_REGION ?? 'us-east-1';
  const authMode = env.D20_AUTH_MODE ?? (env.D20_USER_POOL_ID ? 'cognito' : 'dev');
  return {
    tableName: env.D20_TABLE ?? 'd20-local',
    bucketName: env.D20_BUCKET ?? 'd20-local-media',
    region,
    ...(env.D20_DYNAMO_ENDPOINT ? { dynamoEndpoint: env.D20_DYNAMO_ENDPOINT } : {}),
    ...(env.D20_S3_ENDPOINT ? { s3Endpoint: env.D20_S3_ENDPOINT } : {}),
    ...(env.D20_S3_PUBLIC_ENDPOINT ? { s3PublicEndpoint: env.D20_S3_PUBLIC_ENDPOINT } : {}),
    s3ForcePathStyle: !!env.D20_S3_ENDPOINT,
    maxMapUploadBytes: num(env.MAX_MAP_UPLOAD_BYTES, 25 * 1024 * 1024),
    maxMapPixelCount: num(env.MAX_MAP_PIXEL_COUNT, 100_000_000),
    eventRetentionDays: num(env.SESSION_EVENT_RETENTION_DAYS, 30),
    auth:
      authMode === 'cognito'
        ? { mode: 'cognito', userPoolId: required(env, 'D20_USER_POOL_ID'), clientId: required(env, 'D20_USER_POOL_CLIENT_ID'), region }
        : { mode: 'dev', secret: devSecret(env) },
    realtime: env.D20_EVENTS_HTTP_ENDPOINT ? { mode: 'appsync', httpEndpoint: env.D20_EVENTS_HTTP_ENDPOINT, region } : { mode: 'local' },
  };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required environment variable ${key}`);
  return v;
}

function devSecret(env: NodeJS.ProcessEnv): string {
  if (env.NODE_ENV === 'production' || env.AWS_LAMBDA_FUNCTION_NAME) {
    throw new Error('Dev auth is not allowed in production. Configure Cognito.');
  }
  return env.D20_DEV_JWT_SECRET ?? 'd20-local-dev-secret-not-for-production';
}
