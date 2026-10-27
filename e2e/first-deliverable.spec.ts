/**
 * Spec "first deliverable" journey: sign up, create a campaign, invite and
 * join a player, upload and calibrate a map, start a live session, open GM
 * and player views in separate browsers, move a shared token, and see it sync.
 * Also checks hidden monsters never reach the player and cursors are shared.
 */
import { expect, test, type Page } from '@playwright/test';
import { deflateSync } from 'node:zlib';

function png(width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height, 0);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.fill((x + y) % 64 < 32 ? 150 : 110, y * (width * 3 + 1) + 1 + x * 3, y * (width * 3 + 1) + 4 + x * 3);
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const v of b) c = table[(c ^ v) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (t: string, d: Buffer) => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([l, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const PASSWORD = 'e2e-test-password';

async function signUp(page: Page, email: string, name: string) {
  await page.getByRole('link', { name: /create an account/i }).click();
  await page.getByLabel('Display name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const { code } = await (await page.request.get(`/api/dev/auth/last-code?email=${encodeURIComponent(email)}`)).json();
  await page.getByLabel('Verification code').fill(code);
  await page.getByRole('button', { name: 'Verify email' }).click();
}

type TableObj = { id: string; x: number; y: number; appearance: { label?: string } };
const objects = (p: Page) => p.evaluate(() => Object.values((window as any).__d20?.getTable().objects ?? {}) as TableObj[]);

test('GM and player share a live, synchronized table', async ({ browser }) => {
  const id = Date.now().toString(36);
  const gmCtx = await browser.newContext();
  const plCtx = await browser.newContext();
  const gm = await gmCtx.newPage();
  const pl = await plCtx.newPage();

  // --- GM: account and campaign
  await gm.goto('/sign-in');
  await signUp(gm, `gm-${id}@e2e.local`, `GM ${id}`);
  await expect(gm.getByRole('heading', { name: 'Your campaigns' })).toBeVisible();
  await gm.getByRole('button', { name: 'New campaign' }).click();
  await gm.getByLabel('Title').fill(`Keep ${id}`);
  await gm.getByRole('button', { name: 'Create campaign' }).click();
  await expect(gm.getByRole('heading', { name: `Keep ${id}` })).toBeVisible();
  const campaignUrl = gm.url();

  // --- GM: invite link
  await gm.getByRole('tab', { name: 'Players' }).click();
  await gm.getByRole('button', { name: 'Create invite link' }).click();
  const link = await gm.getByRole('textbox', { name: 'Invite link' }).inputValue();
  expect(link).toContain('/invite/');

  // --- Player: follow invite, sign up, join
  await pl.goto(link);
  await expect(pl).toHaveURL(/sign-in\?next=/);
  await signUp(pl, `pl-${id}@e2e.local`, `Hero ${id}`);
  await expect(pl.getByRole('heading', { name: `Keep ${id}` })).toBeVisible();
  await pl.getByRole('button', { name: 'Join campaign' }).click();
  await expect(pl.getByRole('heading', { name: `Keep ${id}` })).toBeVisible();

  // --- GM: upload and calibrate a map (800 px = 40 ft)
  await gm.getByRole('tab', { name: 'Maps & scenes' }).click();
  await gm.getByRole('button', { name: 'Upload map' }).first().click();
  await gm.getByLabel('Map image file').setInputFiles({ name: 'keep.png', mimeType: 'image/png', buffer: png(1000, 600) });
  await gm.getByLabel('Map name').fill('Keep hall');
  await gm.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(gm.getByText('1000 × 600 px')).toBeVisible();
  await gm.getByRole('button', { name: /Scale & grid/ }).click();
  const img = gm.getByRole('img', { name: 'Keep hall' });
  await expect(img).toBeVisible();
  const box = (await img.boundingBox())!;
  const y = box.y + box.height / 2;
  await gm.mouse.move(box.x + box.width * 0.1, y);
  await gm.mouse.down();
  await gm.mouse.move(box.x + box.width * 0.9, y, { steps: 8 });
  await gm.mouse.up();
  await gm.getByLabel('Real distance').fill('40');
  await gm.getByRole('button', { name: /Save scale/ }).click();
  await expect(gm.getByText('Scale and grid saved')).toBeVisible();

  // --- GM: scene + session
  await gm.goto(campaignUrl);
  await gm.getByRole('tab', { name: 'Maps & scenes' }).click();
  await expect(gm.getByText('Calibrated')).toBeVisible();
  await gm.getByRole('button', { name: 'New scene' }).click();
  await gm.getByRole('button', { name: 'Create scene' }).click();
  await gm.getByRole('tab', { name: 'Sessions' }).click();
  await gm.getByRole('button', { name: 'New session' }).click();
  await gm.getByRole('button', { name: 'Prepare table' }).click();
  await expect(gm.getByText('Choose a scene')).toBeVisible();
  await gm.getByRole('button', { name: /^Keep hall/ }).first().click();
  await gm.getByRole('button', { name: 'Start session' }).click();
  await expect(gm.getByText('live', { exact: true })).toBeVisible();
  const tableUrl = gm.url();

  // --- Player opens the same table
  await pl.goto(tableUrl);
  await expect(pl.getByText('Connected')).toBeVisible();

  // --- GM places a hidden monster and a PC token controlled by the player
  await gm.getByRole('button', { name: 'Hidden monster' }).click();
  await gm.getByLabel('Label').first().fill('Secret Wight');
  const canvas = gm.getByRole('application');
  const cb = (await canvas.boundingBox())!;
  await gm.mouse.click(cb.x + cb.width * 0.7, cb.y + cb.height * 0.5);
  await gm.getByLabel('Type').selectOption('PC');
  await gm.getByLabel('Label').first().fill('Hero token');
  await gm.getByLabel('Controlled by').selectOption({ label: `Hero ${id}` });
  await gm.getByRole('checkbox', { name: 'Place hidden from players' }).uncheck();
  await gm.mouse.click(cb.x + cb.width * 0.4, cb.y + cb.height * 0.5);

  await expect.poll(async () => (await objects(pl)).map((o) => o.appearance.label)).toContain('Hero token');
  expect((await objects(pl)).map((o) => o.appearance.label)).not.toContain('Secret Wight');
  expect((await objects(gm)).map((o) => o.appearance.label)).toContain('Secret Wight');

  // --- Player drags their token; the GM sees it move
  const hero = (await objects(pl)).find((o) => o.appearance.label === 'Hero token')!;
  const from = await pl.evaluate((p) => (window as any).__d20.mapToClient(p), { x: hero.x, y: hero.y });
  const to = await pl.evaluate((p) => (window as any).__d20.mapToClient(p), { x: hero.x - 200, y: hero.y + 100 });
  await pl.mouse.move(from.x, from.y);
  await pl.mouse.down();
  await pl.mouse.move(to.x, to.y, { steps: 10 });
  await pl.mouse.up();
  await expect.poll(async () => (await objects(gm)).find((o) => o.id === hero.id)?.x).toBeLessThan(hero.x - 150);

  // --- Shared cursors: the GM sees the player's pointer
  await pl.mouse.move(to.x + 30, to.y + 30, { steps: 3 });
  await expect.poll(() => gm.evaluate(() => Object.values((window as any).__d20.getTable().cursors).map((c: any) => c.name))).toContain(`Hero ${id}`);

  // --- Refresh preserves token position
  await gm.reload();
  await expect.poll(async () => (await objects(gm)).find((o) => o.id === hero.id)?.x).toBeLessThan(hero.x - 150);

  await gmCtx.close();
  await plCtx.close();
});
