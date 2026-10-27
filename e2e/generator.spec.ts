/**
 * J8: generate a 60x40 ft tavern in the UI, add it to the campaign, and check
 * the live scene measures exactly 60 ft across; stairs portals switch floors.
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

test('generated tavern is exactly 60x40 ft and its stairs link the floors', async ({ browser }) => {
  const api = await request.newContext({ baseURL: 'http://localhost:8787' });
  const id = Date.now().toString(36);
  const gm = await account(api, `gm-gen-${id}@e2e.local`, 'GM');
  const campaign = await gm.call('POST', '/campaigns', { title: `Gen ${id}` });
  const ctx = await browser.newContext();
  const g = await ctx.newPage();
  await signedInPage(g, gm.token, `/campaigns/${campaign.id}/generator`);

  await g.getByRole('textbox', { name: 'Seed' }).fill('e2e-crown');
  await expect(g.getByText('Valid · every room reachable')).toBeVisible();
  await g.getByRole('tab', { name: 'First floor' }).click();
  await g.getByRole('button', { name: 'Add to campaign' }).click();
  await expect(g).toHaveURL(new RegExp(`/campaigns/${campaign.id}$`), { timeout: 30000 });

  const plans = await gm.call('GET', `/campaigns/${campaign.id}/floorplans`);
  const [ground, first] = plans[0].floors;
  const session = await gm.call('POST', `/campaigns/${campaign.id}/sessions`, {});
  await gm.cmd(session.id, 'switchActiveScene', { sceneId: ground.sceneId });
  await gm.call('POST', `/sessions/${session.id}/transition`, { action: 'start' });

  await g.goto(`/campaigns/${campaign.id}/sessions/${session.id}`);
  await expect(g.getByText('Connected')).toBeVisible();
  const map = (await table(g)).snapshot.scene.map;
  expect(map.widthPx / map.calibration.pixelsPerMeter / 0.3048).toBeCloseTo(60, 6);
  expect(map.heightPx / map.calibration.pixelsPerMeter / 0.3048).toBeCloseTo(40, 0);
  expect(map.grid).toMatchObject({ type: 'square', displayInterval: 5, displayUnit: 'ft' });

  // Follow the stairs pin up, then use "Back to" to return.
  const pin = Object.values((await table(g)).objects).find((o: any) => o.portal?.targetSceneId === first.sceneId) as { id: string };
  await g.evaluate((pid) => (window as any).__d20.setTable({ selectedId: pid }), pin.id);
  await g.getByRole('tab', { name: 'GM tools' }).click();
  await g.getByRole('button', { name: 'Go there with everyone' }).click();
  await expect.poll(async () => (await table(g)).snapshot.scene?.scene.id).toBe(first.sceneId);
  await g.getByRole('button', { name: /Back to .*Ground floor/ }).click();
  await expect.poll(async () => (await table(g)).snapshot.scene?.scene.id).toBe(ground.sceneId);

  await ctx.close();
  await api.dispose();
});
