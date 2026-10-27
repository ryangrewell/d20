/**
 * Table definition shared by local bootstrap and documentation. The production
 * table is declared in amplify/backend.ts with the same keys and indexes.
 */
import { CreateTableCommand, DescribeTableCommand, DynamoDBClient, UpdateTimeToLiveCommand } from '@aws-sdk/client-dynamodb';

export const TABLE_KEYS = {
  partitionKey: 'PK',
  sortKey: 'SK',
  gsi: [{ name: 'GSI1', partitionKey: 'GSI1PK', sortKey: 'GSI1SK' }],
  ttlAttribute: 'ttl',
} as const;

export async function ensureLocalTable(endpoint: string, region: string, tableName: string) {
  const client = new DynamoDBClient({ endpoint, region, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return false;
  } catch {
    // create below
  }
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'GSI1PK', AttributeType: 'S' },
        { AttributeName: 'GSI1SK', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  );
  await client.send(new UpdateTimeToLiveCommand({ TableName: tableName, TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true } })).catch(() => undefined);
  return true;
}
