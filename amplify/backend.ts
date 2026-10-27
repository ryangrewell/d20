/**
 * d20 backend (Amplify Gen 2 + CDK).
 *
 *   Cognito user pool  -> identity (email sign-up, verification, reset, optional TOTP MFA)
 *   DynamoDB table     -> all durable state (single-table, PITR, TTL)
 *   S3 bucket          -> private map/media storage (no public access, presigned URLs)
 *   HTTP API + Lambda  -> authoritative command/query API (server/http/app.ts)
 *   AppSync Events     -> realtime fan-out; Lambda handlers authorise subscribe/publish
 *   CloudWatch/Budgets -> alarms and cost guardrails
 *
 * Deliberately NOT using Amplify Data generated CRUD: every operation goes
 * through server-side permission checks (docs/DECISIONS.md, D-002).
 */
import { defineBackend } from '@aws-amplify/backend';
import { Duration, RemovalPolicy, Stack, CfnOutput } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import { auth } from './auth/resource';
import { apiFunction } from './functions/api/resource';
import { eventsAuthFunction } from './functions/events/resource';

const backend = defineBackend({ auth, apiFunction, eventsAuthFunction });

// Amplify Hosting sets AWS_APP_ID/AWS_BRANCH during branch builds; allow that branch's default URL automatically.
const branchOrigin =
  process.env.AWS_APP_ID && process.env.AWS_BRANCH ? [`https://${process.env.AWS_BRANCH.replace(/[^A-Za-z0-9-]/g, '-')}.${process.env.AWS_APP_ID}.amplifyapp.com`] : [];
const allowedOrigins = [
  ...new Set([...(process.env.D20_ALLOWED_ORIGINS ?? 'https://d20.ryangrewell.com,http://localhost:5173').split(','), ...branchOrigin].map((o) => o.trim()).filter(Boolean)),
];

// ------------------------------------------------------------------- data
const dataStack = backend.createStack('d20data');

const table = new dynamodb.Table(dataStack, 'Table', {
  partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
  timeToLiveAttribute: 'ttl',
  encryption: dynamodb.TableEncryption.AWS_MANAGED,
  deletionProtection: true,
  removalPolicy: RemovalPolicy.RETAIN,
});
table.addGlobalSecondaryIndex({
  indexName: 'GSI1',
  partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.ALL,
});

const media = new s3.Bucket(dataStack, 'Media', {
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  encryption: s3.BucketEncryption.S3_MANAGED,
  enforceSSL: true,
  versioned: true,
  removalPolicy: RemovalPolicy.RETAIN,
  cors: [{ allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT], allowedOrigins, allowedHeaders: ['*'], maxAge: 3000 }],
  lifecycleRules: [
    { abortIncompleteMultipartUploadAfter: Duration.days(1) },
    { noncurrentVersionExpiration: Duration.days(30) },
  ],
});

// ------------------------------------------------------------ functions
const apiLambda = backend.apiFunction.resources.lambda;
const eventsLambda = backend.eventsAuthFunction.resources.lambda;
const apiStack = Stack.of(apiLambda);
const userPool = backend.auth.resources.userPool;
const userPoolClient = backend.auth.resources.userPoolClient;

for (const fn of [backend.apiFunction, backend.eventsAuthFunction]) {
  fn.addEnvironment('D20_TABLE', table.tableName);
  fn.addEnvironment('D20_BUCKET', media.bucketName);
  fn.addEnvironment('D20_USER_POOL_ID', userPool.userPoolId);
  fn.addEnvironment('D20_USER_POOL_CLIENT_ID', userPoolClient.userPoolClientId);
}
// Narrow, per-function grants.
table.grantReadWriteData(apiLambda);
table.grantReadData(eventsLambda);
media.grantReadWrite(apiLambda, 'campaigns/*');
// Admin area: live group checks, enable/disable sign-in, remove from the admin group. Scoped to this pool.
apiLambda.addToRolePolicy(
  new iam.PolicyStatement({
    actions: ['cognito-idp:AdminListGroupsForUser', 'cognito-idp:ListUsersInGroup', 'cognito-idp:AdminDisableUser', 'cognito-idp:AdminEnableUser', 'cognito-idp:AdminRemoveUserFromGroup'],
    resources: [userPool.userPoolArn],
  }),
);

// --------------------------------------------------------- AppSync Events
const eventApi = new appsync.EventApi(apiStack, 'Events', {
  apiName: 'd20-events',
  authorizationConfig: {
    authProviders: [
      { authorizationType: appsync.AppSyncAuthorizationType.USER_POOL, cognitoConfig: { userPool } },
      { authorizationType: appsync.AppSyncAuthorizationType.IAM },
    ],
    connectionAuthModeTypes: [appsync.AppSyncAuthorizationType.USER_POOL, appsync.AppSyncAuthorizationType.IAM],
    defaultSubscribeAuthModeTypes: [appsync.AppSyncAuthorizationType.USER_POOL],
    defaultPublishAuthModeTypes: [appsync.AppSyncAuthorizationType.IAM],
  },
});
const authDs = eventApi.addLambdaDataSource('ChannelAuth', eventsLambda);
const handlerCfg = { direct: true, dataSource: authDs, lambdaInvokeType: appsync.LambdaInvokeType.REQUEST_RESPONSE } as const;

// Durable game events: only the backend (IAM) publishes; users subscribe after the Lambda check.
eventApi.addChannelNamespace('game', {
  channelNamespaceName: 'game',
  authorizationConfig: { publishAuthModeTypes: [appsync.AppSyncAuthorizationType.IAM], subscribeAuthModeTypes: [appsync.AppSyncAuthorizationType.USER_POOL] },
  subscribeHandlerConfig: handlerCfg,
});
// Ephemeral presence: members publish cursors; the handler validates and re-stamps identity.
eventApi.addChannelNamespace('presence', {
  channelNamespaceName: 'presence',
  authorizationConfig: { publishAuthModeTypes: [appsync.AppSyncAuthorizationType.USER_POOL], subscribeAuthModeTypes: [appsync.AppSyncAuthorizationType.USER_POOL] },
  subscribeHandlerConfig: handlerCfg,
  publishHandlerConfig: handlerCfg,
});
eventApi.grantPublish(apiLambda);
backend.apiFunction.addEnvironment('D20_EVENTS_HTTP_ENDPOINT', `https://${eventApi.httpDns}/event`);

// ------------------------------------------------------------- HTTP API
const httpApi = new apigw.HttpApi(apiStack, 'HttpApi', {
  apiName: 'd20-api',
  corsPreflight: {
    allowOrigins: allowedOrigins,
    allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.PATCH, apigw.CorsHttpMethod.DELETE],
    allowHeaders: ['authorization', 'content-type'],
    maxAge: Duration.hours(1),
  },
});
// Explicit methods (not ANY) so API Gateway answers CORS preflight OPTIONS itself instead of forwarding them to Lambda.
httpApi.addRoutes({
  path: '/api/{proxy+}',
  methods: [apigw.HttpMethod.GET, apigw.HttpMethod.POST, apigw.HttpMethod.PATCH, apigw.HttpMethod.DELETE],
  integration: new HttpLambdaIntegration('ApiIntegration', apiLambda),
});
const stage = httpApi.defaultStage?.node.defaultChild as apigw.CfnStage | undefined;
stage?.addPropertyOverride('DefaultRouteSettings', { ThrottlingBurstLimit: 200, ThrottlingRateLimit: 100 });

// ----------------------------------------------------- alarms and budget
new cloudwatch.Alarm(apiStack, 'ApiErrors', {
  metric: apiLambda.metricErrors({ period: Duration.minutes(5) }),
  threshold: 10,
  evaluationPeriods: 1,
  alarmDescription: 'd20 API Lambda errors > 10 in 5 minutes',
});
new cloudwatch.Alarm(apiStack, 'ApiThrottles', {
  metric: apiLambda.metricThrottles({ period: Duration.minutes(5) }),
  threshold: 1,
  evaluationPeriods: 1,
  alarmDescription: 'd20 API Lambda throttled',
});
if (process.env.D20_BUDGET_EMAIL) {
  new budgets.CfnBudget(dataStack, 'MonthlyBudget', {
    budget: { budgetType: 'COST', timeUnit: 'MONTHLY', budgetLimit: { amount: Number(process.env.D20_BUDGET_USD ?? 25), unit: 'USD' } },
    notificationsWithSubscribers: [
      { notification: { comparisonOperator: 'GREATER_THAN', notificationType: 'ACTUAL', threshold: 80, thresholdType: 'PERCENTAGE' }, subscribers: [{ subscriptionType: 'EMAIL', address: process.env.D20_BUDGET_EMAIL }] },
      { notification: { comparisonOperator: 'GREATER_THAN', notificationType: 'FORECASTED', threshold: 100, thresholdType: 'PERCENTAGE' }, subscribers: [{ subscriptionType: 'EMAIL', address: process.env.D20_BUDGET_EMAIL }] },
    ],
  });
}

// Used by scripts/bootstrap-admin.ts and operational runbooks.
new CfnOutput(dataStack, 'TableName', { value: table.tableName });

// Public, non-secret values for the browser (written to amplify_outputs.json).
backend.addOutput({
  custom: {
    apiUrl: httpApi.apiEndpoint,
    events: {
      url: `https://${eventApi.httpDns}/event`,
      aws_region: apiStack.region,
      default_authorization_type: 'AMAZON_COGNITO_USER_POOLS',
    },
  },
});
