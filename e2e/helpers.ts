import { expect, type Page } from '@playwright/test';

export async function openJournal(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#journal-content')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Add an entry' })).toBeVisible();
}

export function uniqueText(prefix: string): string {
  return `${prefix} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
