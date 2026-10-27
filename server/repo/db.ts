/**
 * Single-table DynamoDB access. Key layout is documented in docs/ARCHITECTURE.md.
 * All partition keys are scoped by an owning entity, so no query ever scans
 * across campaigns.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type QueryCommandInput,
  type TransactWriteCommandInput,
  type UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { ServerConfig } from '../config';

export const keys = {
  profile: (sub: string) => ({ PK: `USER#${sub}`, SK: 'PROFILE' }),
  campaign: (id: string) => ({ PK: `CAMP#${id}`, SK: 'META' }),
  member: (campaignId: string, sub: string) => ({ PK: `CAMP#${campaignId}`, SK: `MEMBER#${sub}` }),
  invite: (campaignId: string, id: string) => ({ PK: `CAMP#${campaignId}`, SK: `INVITE#${id}` }),
  delegation: (campaignId: string, id: string) => ({ PK: `CAMP#${campaignId}`, SK: `DELEG#${id}` }),
  counter: (campaignId: string, name: string) => ({ PK: `CAMP#${campaignId}`, SK: `COUNTER#${name}` }),
  asset: (campaignId: string, id: string) => ({ PK: `CAMP#${campaignId}`, SK: `ASSET#${id}` }),
  map: (campaignId: string, id: string) => ({ PK: `CAMP#${campaignId}`, SK: `MAP#${id}` }),
  session: (id: string) => ({ PK: `SESSION#${id}`, SK: 'META' }),
  event: (sessionId: string, revision: number) => ({ PK: `SESSION#${sessionId}`, SK: `EVT#${String(revision).padStart(12, '0')}` }),
  command: (sessionId: string, commandId: string) => ({ PK: `SESSION#${sessionId}`, SK: `CMD#${commandId}` }),
  scene: (id: string) => ({ PK: `SCENE#${id}`, SK: 'META' }),
  object: (sceneId: string, id: string) => ({ PK: `SCENE#${sceneId}`, SK: `OBJ#${id}` }),
  fogOp: (sceneId: string, seq: number) => ({ PK: `SCENE#${sceneId}`, SK: `FOG#${String(seq).padStart(8, '0')}` }),
  character: (campaignId: string, id: string) => ({ PK: `CAMP#${campaignId}`, SK: `CHAR#${id}` }),
  item: (characterId: string, id: string) => ({ PK: `CHAR#${characterId}`, SK: `ITEM#${id}` }),
  characterAudit: (characterId: string, id: string) => ({ PK: `CHAR#${characterId}`, SK: `AUDIT#${id}` }),
  encounter: (campaignId: string, id: string) => ({ PK: `CAMP#${campaignId}`, SK: `ENCOUNTER#${id}` }),
  journal: (campaignId: string, id: string) => ({ PK: `CAMP#${campaignId}`, SK: `JOURNAL#${id}` }),
  creature: (campaignId: string, id: string) => ({ PK: `CAMP#${campaignId}`, SK: `CREATURE#${id}` }),
  chat: (campaignId: string, id: string) => ({ PK: `CHAT#${campaignId}`, SK: `MSG#${id}` }),
  rate: (bucket: string, window: number) => ({ PK: `RATE#${bucket}`, SK: `W#${window}` }),
  devAuth: (email: string) => ({ PK: `DEVAUTH#${email.toLowerCase()}`, SK: 'META' }),
};

type Key = { PK: string; SK: string };
type Expr = { ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> };
/** A transaction item without TableName (filled in by Db.transact). */
export type TxItem =
  | { Put: { Item: Record<string, unknown> } & Expr }
  | { Update: { Key: Key; UpdateExpression: string } & Expr }
  | { Delete: { Key: Key } & Expr }
  | { ConditionCheck: { Key: Key; ConditionExpression: string } & Expr };

export const KEY_ATTRS = ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK', 'ttl'] as const;

export function stripKeys<T>(item: Record<string, unknown> | undefined): T | null {
  if (!item) return null;
  const copy: Record<string, unknown> = { ...item };
  for (const k of KEY_ATTRS) delete copy[k];
  delete copy.entity;
  return copy as T;
}

export class Db {
  readonly doc: DynamoDBDocumentClient;
  readonly table: string;

  constructor(cfg: Pick<ServerConfig, 'tableName' | 'region' | 'dynamoEndpoint'>) {
    const client = new DynamoDBClient({
      region: cfg.region,
      ...(cfg.dynamoEndpoint ? { endpoint: cfg.dynamoEndpoint, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
    });
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
    this.table = cfg.tableName;
  }

  async get<T>(key: { PK: string; SK: string }, consistent = true): Promise<T | null> {
    const r = await this.doc.send(new GetCommand({ TableName: this.table, Key: key, ConsistentRead: consistent }));
    return stripKeys<T>(r.Item);
  }

  async put(item: Record<string, unknown>, condition?: { expr: string; names?: Record<string, string>; values?: Record<string, unknown> }) {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: item,
        ...(condition ? { ConditionExpression: condition.expr, ExpressionAttributeNames: condition.names, ExpressionAttributeValues: condition.values } : {}),
      }),
    );
  }

  async update<T>(input: Omit<UpdateCommandInput, 'TableName'>): Promise<T | null> {
    const r = await this.doc.send(new UpdateCommand({ TableName: this.table, ReturnValues: 'ALL_NEW', ...input }));
    return stripKeys<T>(r.Attributes);
  }

  async delete(key: { PK: string; SK: string }) {
    await this.doc.send(new DeleteCommand({ TableName: this.table, Key: key }));
  }

  async query<T>(input: Omit<QueryCommandInput, 'TableName'>, opts: { all?: boolean; limit?: number } = {}): Promise<T[]> {
    const out: T[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(new QueryCommand({ TableName: this.table, ...input, ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}) }));
      for (const item of r.Items ?? []) out.push(stripKeys<T>(item)!);
      ExclusiveStartKey = r.LastEvaluatedKey;
      if (opts.limit && out.length >= opts.limit) break;
    } while (ExclusiveStartKey && opts.all !== false);
    return out;
  }

  async queryPrefix<T>(pk: string, skPrefix: string, opts: { index?: 'GSI1'; forward?: boolean; limit?: number } = {}): Promise<T[]> {
    const pkName = opts.index ? `${opts.index}PK` : 'PK';
    const skName = opts.index ? `${opts.index}SK` : 'SK';
    return this.query<T>(
      {
        ...(opts.index ? { IndexName: opts.index } : {}),
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :sk)',
        ExpressionAttributeNames: { '#pk': pkName, '#sk': skName },
        ExpressionAttributeValues: { ':pk': pk, ':sk': skPrefix },
        ScanIndexForward: opts.forward ?? true,
        ...(opts.limit ? { Limit: opts.limit } : {}),
      },
      opts.limit ? { limit: opts.limit, all: false } : {},
    );
  }

  async batchGet<T>(keyList: { PK: string; SK: string }[]): Promise<T[]> {
    const out: T[] = [];
    for (let i = 0; i < keyList.length; i += 100) {
      let pending: Record<string, { Keys: Record<string, unknown>[] }> | undefined = { [this.table]: { Keys: keyList.slice(i, i + 100) } };
      while (pending && Object.keys(pending).length) {
        const r: { Responses?: Record<string, Record<string, unknown>[]>; UnprocessedKeys?: Record<string, unknown> } = await this.doc.send(new BatchGetCommand({ RequestItems: pending }));
        for (const item of r.Responses?.[this.table] ?? []) out.push(stripKeys<T>(item)!);
        pending = r.UnprocessedKeys && Object.keys(r.UnprocessedKeys).length ? (r.UnprocessedKeys as typeof pending) : undefined;
      }
    }
    return out;
  }

  async transact(items: TxItem[]) {
    const withTable = items.map((it) => {
      const [kind, body] = Object.entries(it)[0] as [string, Record<string, unknown>];
      return { [kind]: { TableName: this.table, ...body } };
    });
    await this.doc.send(new TransactWriteCommand({ TransactItems: withTable as TransactWriteCommandInput['TransactItems'] }));
  }
}

export function isConditionalFailure(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === 'ConditionalCheckFailedException' || name === 'TransactionCanceledException';
}
