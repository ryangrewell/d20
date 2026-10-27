import { defineFunction } from '@aws-amplify/backend';

export const eventsAuthFunction = defineFunction({
  name: 'd20-events-auth',
  entry: './handler.ts',
  runtime: 22,
  timeoutSeconds: 5,
  memoryMB: 256,
  resourceGroupName: 'd20api',
  environment: { D20_AUTH_MODE: 'cognito' },
});
