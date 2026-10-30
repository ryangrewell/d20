/**
 * Character pictures through the UI: the sprite builder (presets load into the piece-by-piece
 * builder) and the art credits page.
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

test('a player picks a sprite for their character, and the credits page lists the artists', async ({ browser }) => {
  const api = await request.newContext({ baseURL: 'http://localhost:8787' });
  const id = Date.now().toString(36);
  const gm = await account(api, `gm-p-${id}@e2e.local`, 'GM');
  const pl = await account(api, `pl-p-${id}@e2e.local`, `Nim ${id}`);
  const campaign = await gm.call('POST', '/campaigns', { title: `Pics ${id}` });
  const inv = await gm.call('POST', `/campaigns/${campaign.id}/invites`, {});
  await pl.call('POST', '/invites/accept', { token: inv.token });
  const hero = await pl.call('POST', `/campaigns/${campaign.id}/characters`, { name: 'Nim' });

  const p = await (await browser.newContext()).newPage();
  await signedInPage(p, pl.token, `/campaigns/${campaign.id}/characters/${hero.id}`);
  await p.getByRole('button', { name: 'Change picture' }).click();
  await p.getByRole('tab', { name: 'Presets' }).click();
  await p.getByRole('button', { name: 'Goblin', exact: true }).click();
  // Picking a preset loads it into the builder, ready to tweak piece by piece.
  await expect(p.getByRole('tab', { name: 'Build' })).toHaveAttribute('aria-selected', 'true');
  await expect(p.locator('#sb-head')).toHaveValue('heads_goblin');
  await p.getByRole('button', { name: 'Use this picture' }).click();
  await expect(p.getByText('Picture updated')).toBeVisible();
  const saved = await pl.call('GET', `/campaigns/${campaign.id}/characters/${hero.id}`);
  expect(saved.character.imageAssetId).toBeTruthy();
  expect(saved.character.sprite.recipe.parts[0].item).toBe('heads_goblin');
  await expect(p.getByRole('button', { name: 'Change picture' }).locator('img')).toBeVisible();

  await p.goto('/credits');
  await expect(p.getByRole('heading', { name: 'Art credits' })).toBeVisible();
  await expect(p.getByText(/Stephen Challener|Redshrike/).first()).toBeVisible();
});
