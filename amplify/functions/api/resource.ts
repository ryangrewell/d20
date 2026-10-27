import { defineFunction } from '@aws-amplify/backend';

export const apiFunction = defineFunction({
  name: 'd20-api',
  entry: './handler.ts',
  runtime: 22,
  timeoutSeconds: 15,
  memoryMB: 512,
  resourceGroupName: 'd20api',
  environment: {
    D20_AUTH_MODE: 'cognito',
    MAX_MAP_UPLOAD_BYTES: String(25 * 1024 * 1024),
    MAX_MAP_PIXEL_COUNT: String(100_000_000),
    SESSION_EVENT_RETENTION_DAYS: '30',
  },
});
