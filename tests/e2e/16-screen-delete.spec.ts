/**
 * Deleting a screen (CMS-41) in the real portal, as the seeded Owner: from the Screens list's
 * row menu, which also cuts off the screen's paired player at once, from the "More actions"
 * menu of the screen's page, which then opens the Screens list, and two at once from the list's
 * selection bar. The screens are set up through the API; a Viewer seeing no Delete is in 14.
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { operatorSession, type OperatorSession } from './support/contexts.ts';
import { expectListedWithout } from './support/operator.ts';
import {
  expectPhase,
  openPlayer,
  pairingCode,
  playerFetch,
  readRecord,
  type Registration,
} from './support/player.ts';
import {
  cspViolations,
  expectNoWebStorage,
  notifications,
  openScreenPage,
  watchCspViolations,
} from './support/portal.ts';
import { PORTAL_URL } from './support/stack.ts';

test.describe.configure({ mode: 'serial' });

const runId = randomUUID().slice(0, 8);
const listName = `ZZ delete list ${runId}`;
const pageName = `ZZ delete page ${runId}`;
const bulkSearch = `ZZ delete bulk ${runId}`;
const bulkNames = [`ZZ delete bulk one ${runId}`, `ZZ delete bulk two ${runId}`];

let operator: OperatorSession;
let playerContext: BrowserContext;
let player: Page;
let listId = '';
let pageId = '';

async function expectGone(id: string): Promise<void> {
  const response = await operator.api.get(`/api/displays/${id}`);
  expect(response.status(), await response.text()).toBe(404);
  for (const path of ['/api/displays', '/api/displays/status', '/api/push']) {
    await expectListedWithout(operator.api, path, [id]);
  }
}

test.beforeAll(async ({ browser }) => {
  operator = await operatorSession(browser, 'operator');
  await watchCspViolations(operator.page);
  playerContext = await browser.newContext();
  player = await playerContext.newPage();
  listId = (
    await operator.api.createDisplay({ name: listName, canvas: { width: 1920, height: 1080 } })
  ).id;
  pageId = (
    await operator.api.createDisplay({ name: pageName, canvas: { width: 1280, height: 720 } })
  ).id;
  await openPlayer(player);
  expect((await operator.api.claim(listId, await pairingCode(player))).status()).toBe(200);
  await expectPhase(player, 'idle');
});

test.afterAll(async () => {
  await playerContext.close();
  await operator.context.close();
});

test('a screen is deleted from the Screens list, and its paired player is cut off at once', async () => {
  const page = operator.page;
  const registration = await readRecord<Registration>(player, 'registration');
  const token = registration?.deviceToken ?? '';
  // Accepted before the delete: nothing is published to it yet, so 204 (not 401).
  expect((await playerFetch('/player/manifest', token)).status).toBe(204);

  await page.goto(`${PORTAL_URL}/screens`);
  await page.getByTestId('screens-search').fill(listName);
  const row = page.getByTestId(`screens-row-${listId}`);
  await expect(row).toContainText(listName);
  await page.getByRole('button', { name: `Actions for ${listName}` }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const dialog = page.getByRole('dialog', { name: `Delete ${listName}?` });
  await expect(dialog).toBeVisible();
  await page.getByTestId('screens-delete-dialog-confirm').click();
  await expect(dialog).toBeHidden();
  await expect(notifications(page).getByText(`${listName} deleted`)).toBeVisible();
  await expect(row).toHaveCount(0);
  await expectGone(listId);

  // One audit row names the registration it revoked; the credential is dead server side.
  const audit = (await (
    await operator.api.get('/api/audit?category=display&limit=200')
  ).json()) as {
    items: { action: string; objectId: string | null; result: string; detail: unknown }[];
  };
  expect(
    audit.items.filter((event) => event.action === 'display.delete' && event.objectId === listId),
  ).toEqual([
    expect.objectContaining({
      result: 'success',
      detail: expect.objectContaining({ revokedRegistrationId: registration?.registrationId }),
    }),
  ]);
  expect((await playerFetch('/player/manifest', token)).status).toBe(401);

  // Player side, at its next contact.
  await expect(player.getByTestId('revoked-title')).toBeVisible({ timeout: 60_000 });
  await expectPhase(player, 'revoked');
});

test('a screen is deleted from its own page, which then opens the Screens list', async () => {
  const page = operator.page;
  await openScreenPage(page, pageId);
  const dialog = page.getByRole('dialog', { name: `Delete ${pageName}?` });

  // Cancel keeps it.
  await page.getByTestId('screen-detail-menu').click();
  await page.getByRole('menuitem', { name: 'Delete screen' }).click();
  await expect(dialog).toBeVisible();
  await page.getByTestId('screens-delete-dialog-cancel').click();
  await expect(dialog).toBeHidden();
  expect((await operator.api.get(`/api/displays/${pageId}`)).status()).toBe(200);

  await page.getByTestId('screen-detail-menu').click();
  await page.getByRole('menuitem', { name: 'Delete screen' }).click();
  await page.getByTestId('screens-delete-dialog-confirm').click();
  await page.waitForURL(/\/screens$/);
  await expect(notifications(page).getByText(`${pageName} deleted`)).toBeVisible();
  await expect(page.getByTestId(`screens-row-${pageId}`)).toHaveCount(0);
  await expectGone(pageId);

  // Its address now answers as an unknown screen's does.
  await page.goto(`${PORTAL_URL}/screens/${pageId}`);
  await expect(page.getByTestId('screen-detail-missing')).toBeVisible();
});

test('two screens are deleted at once from the Screens list selection bar', async () => {
  const page = operator.page;
  const screens: { id: string; name: string }[] = [];
  for (const name of bulkNames) {
    const { id } = await operator.api.createDisplay({
      name,
      canvas: { width: 1920, height: 1080 },
    });
    screens.push({ id, name });
  }
  const ids = screens.map((screen) => screen.id);

  await page.goto(`${PORTAL_URL}/screens`);
  await page.getByTestId('screens-search').fill(bulkSearch);
  for (const { id, name } of screens) {
    await expect(page.getByTestId(`screens-row-${id}`)).toContainText(name);
    await page.getByRole('checkbox', { name: `Select ${name}`, exact: true }).check();
  }
  await page.getByTestId('screens-bulk-delete').click();
  const dialog = page.getByRole('dialog', { name: 'Delete 2 screens?' });
  await expect(dialog).toBeVisible();
  const listed = dialog.getByRole('list', { name: 'Screens to delete' });
  for (const name of bulkNames) await expect(listed).toContainText(name);
  await page.getByTestId('screens-bulk-delete-confirm').click();
  await expect(dialog).toBeHidden();
  await expect(notifications(page).getByText('2 screens deleted')).toBeVisible();
  for (const id of ids) {
    await expect(page.getByTestId(`screens-row-${id}`)).toHaveCount(0);
    await expectGone(id);
  }

  // One DELETE per screen, so one audit row each.
  const audit = (await (
    await operator.api.get('/api/audit?category=display&limit=200')
  ).json()) as { items: { action: string; objectId: string | null; result: string }[] };
  for (const id of ids) {
    expect(
      audit.items.filter((event) => event.action === 'display.delete' && event.objectId === id),
    ).toEqual([expect.objectContaining({ result: 'success' })]);
  }
});

test('no CSP violation and no web storage on the screens pages', async () => {
  await expectNoWebStorage(operator.page);
  expect(await cspViolations(operator.page)).toEqual([]);
});
