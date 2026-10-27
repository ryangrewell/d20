import { AppError } from '@shared/errors';
import { isConditionalFailure, keys } from '../repo/db';
import type { Deps } from '../context';

/** Fixed-window counter in DynamoDB; items expire via TTL. */
export async function rateLimit(deps: Deps, bucket: string, limit: number, windowSeconds: number) {
  const nowSec = Math.floor(deps.now().getTime() / 1000);
  const window = Math.floor(nowSec / windowSeconds);
  try {
    await deps.db.update({
      Key: keys.rate(bucket, window),
      UpdateExpression: 'ADD #c :one SET #ttl = if_not_exists(#ttl, :ttl)',
      ConditionExpression: 'attribute_not_exists(#c) OR #c < :limit',
      ExpressionAttributeNames: { '#c': 'count', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':one': 1, ':limit': limit, ':ttl': (window + 2) * windowSeconds },
    });
  } catch (err) {
    if (isConditionalFailure(err)) throw new AppError('RATE_LIMITED', 'Too many requests. Please wait a moment and try again.');
    throw err;
  }
}
