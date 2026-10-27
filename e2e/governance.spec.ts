/**
 * Phase 6: the owner delegates GM control through the UI and revokes it
 * (the player loses GM tools live), then a platform admin blocks the player
 * and the player sees the blocked screen.
 */
import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';

const PASSWORD = 'e2e-test-password';

async function account(api: APIRequestContext, email: string, name: string) {
  await api.post('/api/dev/auth/sign-up', { data: { email, password: PASSWORD, displayName: name } });
  const { code } = await (await api.get(`/api/dev/auth/last-code?email=${encodeURIComponent(email)}`)).json();
  await api.post('/api/dev/auth/confirm', { data: { email, code } });
  const r = await (await api.post('/api/dev/auth/sign-in', { data: { email, password: PASSWORD } })).json();
  const token = r.idToken as string;
  const call = async (method: string, path: string, data?: unknown) => {
    const res = await api.fetch(`/api${path}`, { method, headers: { authorization: `Bearer ${token}` }, ...(data !== undefined ? { data } : {}) });
    const json = await res.json();
    if (!res.ok()) throw new Error(`${path}: ${JSON.stringify(json)}`);
    return json;
  };
  return { token, sub: r.user.sub as string, call, cmd: (sessionId: string, type: string, payload: unknown) => call('POST', '/commands', { commandId: crypto.randomUUID(), sessionId, type, payload }) };
}

async function signedInPage(page: Page, token: string, path: string) {
  await page.goto('/');
  await page.evaluate((t) => localStorage.setItem('d20.dev.session', t), token);
  await page.goto(path);
}

const table = (p: Page) => p.evaluate(() => (window as any).__d20?.getTable());

test('delegate, revoke, and block through the UI', async ({ browser }) => {
  const api = await request.newContext({ baseURL: 'http://localhost:8787' });
  const id = Date.now().toString(36);
  const owner = await account(api, `own-${id}@e2e.local`, 'Owner');
  const pl = await account(api, `del-${id}@e2e.local`, `Deputy ${id}`);
  const campaign = await owner.call('POST', '/campaigns', { title: `Gov ${id}` });
  const inv = await owner.call('POST', `/campaigns/${campaign.id}/invites`, {});
  await pl.call('POST', '/invites/accept', { token: inv.token });
  const session = await owner.call('POST', `/campaigns/${campaign.id}/sessions`, {});
  await owner.call('POST', `/sessions/${session.id}/transition`, { action: 'start' });

  const oCtx = await browser.newContext();
  const pCtx = await browser.newContext();
  const o = await oCtx.newPage();
  const p = await pCtx.newPage();

  // Owner delegates "the current / next session" from the Players tab.
  await signedInPage(o, owner.token, `/campaigns/${campaign.id}`);
  await o.getByRole('tab', { name: 'Players' }).click();
  await o.getByRole('button', { name: 'Delegate GM control' }).click();
  await o.getByRole('button', { name: 'Delegate', exact: true }).click();
  await expect(o.getByText('active', { exact: true })).toBeVisible();

  await signedInPage(p, pl.token, `/campaigns/${campaign.id}/sessions/${session.id}`);
  await expect(p.getByRole('tab', { name: 'GM tools' })).toBeVisible();
  expect((await table(p)).snapshot.viewMode).toBe('gm');

  // Revoke: the player's open table drops back to the player view without a reload.
  o.once('dialog', (d) => void d.accept());
  await o.getByRole('button', { name: /Revoke GM control for Deputy/ }).click();
  await expect.poll(async () => (await table(p)).snapshot.viewMode, { timeout: 15000 }).toBe('player');
  await expect(p.getByRole('tab', { name: 'GM tools' })).toHaveCount(0);

  // An admin blocks the player; their next request shows the blocked screen.
  const adm = await account(api, `adm-${id}@e2e.local`, 'Admin');
  await api.post('/api/dev/auth/grant-admin', { data: { email: `adm-${id}@e2e.local` } });
  const aCtx = await browser.newContext();
  const a = await aCtx.newPage();
  await signedInPage(a, adm.token, '/admin');
  await expect(a.getByRole('heading', { name: 'Platform admin' })).toBeVisible();
  await a.getByRole('tab', { name: 'Users' }).click();
  await a.getByRole('textbox', { name: 'Search users' }).fill(`Deputy ${id}`);
  await a.getByRole('button', { name: 'Search' }).click();
  await a.getByRole('cell', { name: new RegExp(`Deputy ${id}`) }).click();
  await a.getByRole('button', { name: 'Block…' }).click();
  await a.getByLabel('Reason (recorded in the audit log)').fill('E2E moderation check');
  await a.getByRole('button', { name: 'Block and sign out' }).click();
  await expect(a.getByText('Done. Recorded in the audit log.')).toBeVisible();

  await p.goto(`/campaigns/${campaign.id}`);
  await expect(p.getByRole('heading', { name: 'Account blocked' })).toBeVisible();

  await Promise.all([oCtx.close(), pCtx.close(), aCtx.close()]);
  await api.dispose();
});
