# Deployment (AWS Amplify Gen 2)

**Status: never deployed.** The backend synthesises (`cdk synth`, see below), but no AWS account was connected during the build. Nothing here has been run against AWS.

## Prerequisites (owner)

1. AWS account with billing alerts; install AWS CLI and run `aws configure sso` (or another credential method).
2. Push this repo to GitHub (or another Amplify-supported provider). Protect `main`; use a `dev` branch for staging.
3. Decide the budget alert email and amount.

## Personal sandbox (development)

```bash
export D20_ALLOWED_ORIGINS=http://localhost:5173
npx ampx sandbox          # deploys Cognito, DynamoDB, S3, HTTP API, AppSync Events to your account
VITE_BACKEND_MODE=amplify npx vite   # app reads amplify_outputs.json (copy it into public/ for dev)
```

Copy `amplify_outputs.json` to `public/amplify_outputs.json` when running Vite against a sandbox.

## Hosted branches

1. Amplify console → Create app → connect the repo and choose the `dev` branch. The build uses `amplify.yml`.
2. Environment variables (Amplify console → Hosting → Environment variables):
   - `D20_ALLOWED_ORIGINS` = the branch URL (e.g. `https://dev.<appid>.amplifyapp.com`) and later `https://d20.ryangrewell.com`
   - `D20_BUDGET_EMAIL`, `D20_BUDGET_USD` (optional; creates an AWS Budget)
3. Cognito sends email with its default sender (about 50/day). Before launch, configure SES in Cognito for production email volume.
4. After the first deploy, create your account in the app, then grant admin:
   ```bash
   npx tsx scripts/bootstrap-admin.ts --user-pool-id <pool id from amplify_outputs.json> --sub <your Cognito sub>
   ```
5. Smoke test: sign up, create campaign, invite, upload/calibrate map, two browsers on one table.

## Custom domain (only after owner approval)

Amplify console → Hosting → Custom domains → add `d20.ryangrewell.com`. Add the CNAME/validation records **at whichever DNS provider controls ryangrewell.com**. Do not assume Route 53. Wait for HTTPS to validate, then add the domain to `D20_ALLOWED_ORIGINS` and redeploy.

## Rollback

- Frontend: Amplify console → the branch → redeploy a previous successful build.
- Backend: revert the commit and redeploy. The DynamoDB table and S3 bucket use `RETAIN` + deletion protection, so a bad deploy can't delete data. Restore data with DynamoDB point-in-time recovery (35 days) or S3 object versioning (30 days of non-current versions).

## Offline synth check (no credentials)

```bash
CDK_DEFAULT_ACCOUNT=123456789012 CDK_DEFAULT_REGION=us-east-1 npx aws-cdk@2 synth --quiet \
  --app 'npx tsx amplify/backend.ts' -c amplify-backend-namespace=d20 \
  -c amplify-backend-name=synthcheck -c amplify-backend-type=sandbox -o /tmp/d20-cdkout
```
