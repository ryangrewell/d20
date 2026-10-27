/**
 * Lambda entry for the HTTP command/query API (behind API Gateway HTTP API).
 * Same Hono app as local development; Cognito tokens verified in-app.
 */
import { handle } from 'hono/aws-lambda';
import { loadConfig } from '../../../server/config';
import { createDeps } from '../../../server/bootstrap';
import { createVerifier } from '../../../server/auth/verify';
import { createApp } from '../../../server/http/app';

const config = loadConfig();
const deps = createDeps({ config });
const app = createApp(deps, createVerifier(config.auth));

export const handler = handle(app);
