import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle', timeout: 90000 });
await page.fill('input[name="email"]', 'adhyanagrawal777@gmail.com');
await page.fill('input[name="password"]', 'lumora@2007');
await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 60000 });
await page.goto('http://localhost:3100/admin/users', { waitUntil: 'networkidle', timeout: 90000 });
for (const q of ['Viewer', 'viewer', 'f42de85c']) {
  await page.fill('#users-q', q);
  await page.waitForTimeout(400);
  const n = await page.locator('table tbody tr').count();
  const first = n ? (await page.locator('table tbody tr').first().innerText()).split('\n')[0] : '(none)';
  console.log(`search "${q}" -> ${n} row(s), first: ${first}`);
}
await browser.close();
