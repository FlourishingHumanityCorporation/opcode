import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const LOAD_COUNT_KEY = "codeinterfacex.hotRefresh.loadCount";

async function installLoadCounter(page: Page): Promise<void> {
  await page.addInitScript(({ key }) => {
    const previous = Number(sessionStorage.getItem(key) || "0");
    sessionStorage.setItem(key, String(previous + 1));
    localStorage.setItem("codeinterfacex.smoke.projectPath", "/tmp/codeinterfacex-smoke-project");
  }, { key: LOAD_COUNT_KEY });
}

async function getLoadCount(page: Page): Promise<number> {
  return page.evaluate((key) => Number(sessionStorage.getItem(key) || "0"), LOAD_COUNT_KEY);
}

async function openApp(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("workspace-new-project")).toBeVisible();
}

async function dispatchHotRefreshRequest(page: Page, requestId: string): Promise<void> {
  await page.evaluate((id) => {
    window.dispatchEvent(
      new CustomEvent("codeinterfacex-hot-refresh-requested", {
        detail: {
          requestId: id,
          sourceId: `playwright-${id}`,
          reason: "manual",
          payload: { source: "playwright" },
        },
      })
    );
  }, requestId);
}

test.describe("Hot refresh smoke", () => {
  test("reloads the current page when a hot-refresh request is dispatched", async ({ page }) => {
    await installLoadCounter(page);
    await openApp(page);

    const initialLoads = await getLoadCount(page);
    const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded" });
    await dispatchHotRefreshRequest(page, "single-page");
    await navigation;

    expect(await getLoadCount(page)).toBeGreaterThan(initialLoads);
  });

  test("propagates hot-refresh requests across browser tabs", async ({ browser }) => {
    const context: BrowserContext = await browser.newContext({ baseURL: "http://127.0.0.1:1420" });

    const pageA = await context.newPage();
    const pageB = await context.newPage();

    await installLoadCounter(pageA);
    await installLoadCounter(pageB);

    await openApp(pageA);
    await openApp(pageB);

    const initialPageBLoads = await getLoadCount(pageB);
    const pageBNavigation = pageB.waitForNavigation({ waitUntil: "domcontentloaded" });
    await dispatchHotRefreshRequest(pageA, "cross-tab");
    await pageBNavigation;

    expect(await getLoadCount(pageB)).toBeGreaterThan(initialPageBLoads);

    await context.close();
  });
});
