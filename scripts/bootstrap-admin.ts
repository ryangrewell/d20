/**
 * One-time privileged bootstrap: grants the `platform-admin` Cognito group to
 * an explicitly selected, verified user. Run with deployment/admin AWS
 * credentials. Refuses to add an admin silently if one already exists.
 *
 *   npx tsx scripts/bootstrap-admin.ts --user-pool-id us-east-1_XXXX --sub <cognito-sub> [--allow-additional]
 *
 * The script prints the target identity and requires typing it back to confirm.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  AdminAddUserToGroupCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUsersInGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const GROUP = 'platform-admin';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const userPoolId = arg('user-pool-id');
  const sub = arg('sub');
  const allowAdditional = process.argv.includes('--allow-additional');
  if (!userPoolId || !sub) throw new Error('Usage: --user-pool-id <id> --sub <cognito-sub> [--allow-additional]');
  const region = userPoolId.split('_')[0];
  const cognito = new CognitoIdentityProviderClient({ region });

  const found = await cognito.send(new ListUsersCommand({ UserPoolId: userPoolId, Filter: `sub = "${sub.replace(/"/g, '')}"`, Limit: 1 }));
  const user = found.Users?.[0];
  if (!user?.Username) throw new Error('No user with that sub exists in this pool.');
  const attr = (n: string) => user.Attributes?.find((a) => a.Name === n)?.Value;
  if (attr('email_verified') !== 'true') throw new Error('Target user has not verified their email.');
  if (!user.Enabled || user.UserStatus !== 'CONFIRMED') throw new Error('Target user is not an enabled, confirmed account.');

  const existing = await cognito.send(new ListUsersInGroupCommand({ UserPoolId: userPoolId, GroupName: GROUP }));
  const admins = existing.Users ?? [];
  if (admins.some((u) => u.Username === user.Username)) {
    console.log('That user is already a platform admin. No change made.');
    return;
  }
  if (admins.length > 0 && !allowAdditional) {
    throw new Error(`${admins.length} platform admin(s) already exist. Re-run with --allow-additional to add another deliberately.`);
  }

  console.log(`\nAbout to grant ${GROUP} to:\n  sub:   ${sub}\n  email: ${attr('email')}\n  pool:  ${userPoolId}\n`);
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question('Type the email address to confirm: ');
  rl.close();
  if (answer.trim().toLowerCase() !== (attr('email') ?? '').toLowerCase()) throw new Error('Confirmation did not match. Aborted.');

  await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: user.Username, GroupName: GROUP }));
  console.log(JSON.stringify({ level: 'info', msg: 'platform-admin granted', sub, pool: userPoolId, at: new Date().toISOString(), by: process.env.USER ?? 'unknown' }));
  console.log('Done. The user must sign out and in again to receive the new group claim.');
}

main().catch((e) => {
  console.error(`bootstrap-admin: ${(e as Error).message}`);
  process.exit(1);
});
