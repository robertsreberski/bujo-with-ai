import { expect, type Page } from '@playwright/test';

const e2eOrigin = `http://localhost:${process.env.JOURNAL_E2E_PORT ?? '41778'}`;

async function installWebKitLocalhostPair(page: Page): Promise<void> {
  if (page.context().browser()?.browserType().name() !== 'webkit') return;

  const paired = await page.context().request.post('/api/pair', {
    data: {},
    headers: { Origin: e2eOrigin },
  });
  expect(paired.status()).toBe(201);
  const secret = /journal_device=([^;]+)/u.exec(paired.headers()['set-cookie'] ?? '')?.[1];
  expect(secret).toBeTruthy();

  // Production correctly emits a Secure pairing cookie. WebKit refuses to
  // attach that cookie to this HTTP-only localhost harness, so install the
  // same just-issued secret as a localhost-only test cookie for this engine.
  await page.context().addCookies([
    {
      name: 'journal_device',
      value: secret ?? '',
      url: e2eOrigin,
      httpOnly: true,
      sameSite: 'Strict',
      secure: false,
    },
  ]);
}

export async function openJournal(page: Page): Promise<void> {
  await installWebKitLocalhostPair(page);
  await page.goto('/');
  await expect(page.locator('#journal-content')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Add an entry' })).toBeVisible();
}

export function uniqueText(prefix: string): string {
  return `${prefix} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
