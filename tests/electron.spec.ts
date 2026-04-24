import { _electron as electron, type ElectronApplication, type Page, expect, test } from "@playwright/test";
import path from "node:path";

async function launchApp(): Promise<ElectronApplication> {
  return electron.launch({
    args: [path.join(process.cwd(), ".")],
    env: {
      ...process.env,
      NODE_ENV: "test",
      UNIT0_E2E_WINDOW_MODE: process.env.UNIT0_E2E_WINDOW_MODE ?? "hidden"
    }
  });
}

async function firstWindow(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="workspace-tab-strip"]');
  return page;
}

async function tabOrder(page: Page): Promise<string[]> {
  return page.locator("[data-workspace-tab]").evaluateAll((tabs) =>
    tabs.map((tab) => tab.textContent?.trim() ?? "")
  );
}

async function waitForWindowWithTestId(app: ElectronApplication, testId: string): Promise<Page> {
  await expect(async () => {
    const matches = await Promise.all(
      app.windows().map(async (page) => {
        if (page.isClosed()) {
          return false;
        }
        return (await page.getByTestId(testId).count().catch(() => 0)) > 0;
      })
    );
    expect(matches.some(Boolean)).toBe(true);
  }).toPass({ timeout: 5000 });
  for (const page of app.windows()) {
    if (!page.isClosed() && (await page.getByTestId(testId).count().catch(() => 0)) > 0) {
      return page;
    }
  }
  throw new Error(`No window found with ${testId}`);
}

test("launches with pinned Workspace Manager and default workspace tabs", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);

  const order = await tabOrder(page);
  expect(order[0]).toContain("Workspace Manager");
  await expect(page.getByTestId("workspace-tab-atlas")).toBeVisible();
  await expect(page.getByTestId("workspace-tab-redesign")).toBeVisible();
  await expect(page.getByTestId("workspace-tab-lab")).toBeVisible();
  await expect(page.getByTestId("workspace-tab-research")).toBeVisible();

  await app.close();
});

test("renders the initial applet surfaces", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);
  await page.getByTestId("workspace-tab-atlas").click();

  await expect(page.getByTestId("applet-terminal")).toBeVisible();
  await expect(page.getByTestId("applet-fileViewer")).toBeVisible();
  await expect(page.getByTestId("applet-browser")).toBeVisible();
  await expect(page.getByTestId("applet-chat")).toBeVisible();
  await expect(page.getByTestId("applet-sandbox")).toBeVisible();

  await app.close();
});

test("does not move the pinned manager tab", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);
  const atlas = page.getByTestId("workspace-tab-atlas");
  const manager = page.getByTestId("workspace-tab-manager");
  const atlasBox = await atlas.boundingBox();
  const managerBox = await manager.boundingBox();
  expect(atlasBox).not.toBeNull();
  expect(managerBox).not.toBeNull();

  await page.mouse.move(atlasBox!.x + atlasBox!.width / 2, atlasBox!.y + atlasBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(managerBox!.x + managerBox!.width / 2, managerBox!.y + managerBox!.height / 2, { steps: 8 });
  await page.mouse.up();

  const order = await tabOrder(page);
  expect(order[0]).toContain("Workspace Manager");

  await app.close();
});

test("reorders workspace tabs within a window", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);
  const atlas = page.getByTestId("workspace-tab-atlas");
  const research = page.getByTestId("workspace-tab-research");
  const atlasBox = await atlas.boundingBox();
  const researchBox = await research.boundingBox();
  expect(atlasBox).not.toBeNull();
  expect(researchBox).not.toBeNull();

  await page.mouse.move(atlasBox!.x + atlasBox!.width / 2, atlasBox!.y + atlasBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(researchBox!.x + researchBox!.width + 10, researchBox!.y + researchBox!.height / 2, { steps: 8 });
  await page.mouse.up();

  await page.waitForFunction(() => {
    const tabs = Array.from(document.querySelectorAll("[data-workspace-tab]"));
    return tabs.at(-1)?.textContent?.includes("Project Atlas");
  });
  const order = await tabOrder(page);
  expect(order[0]).toContain("Workspace Manager");
  expect(order.at(-1)).toContain("Project Atlas");

  await app.close();
});

test("inactive dragged tab does not become active during drag", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);
  await page.getByTestId("workspace-tab-redesign").click();
  await expect(page.getByTestId("workspace-tab-redesign")).toHaveClass(/active/);

  const atlas = page.getByTestId("workspace-tab-atlas");
  const atlasBox = await atlas.boundingBox();
  expect(atlasBox).not.toBeNull();
  await page.mouse.move(atlasBox!.x + atlasBox!.width / 2, atlasBox!.y + atlasBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(atlasBox!.x + 260, atlasBox!.y + 10, { steps: 6 });

  await expect(page.getByTestId("workspace-tab-redesign")).toHaveClass(/active/);
  await page.mouse.up();

  await app.close();
});

test("drag outside enters floating preview and release creates one detached window", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);
  const tab = page.getByTestId("workspace-tab-lab");
  const box = await tab.boundingBox();
  expect(box).not.toBeNull();

  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + 280, box!.y + 260, { steps: 8 });
  await expect(page.getByTestId("floating-tab-preview")).toHaveCount(0);
  await page.mouse.up();
  const second = await waitForWindowWithTestId(app, "workspace-tab-lab");

  expect(app.windows().filter((item) => !item.isClosed()).length).toBeGreaterThanOrEqual(2);
  await expect(second.getByTestId("workspace-tab-lab")).toBeVisible();
  await expect(page.getByTestId("workspace-tab-lab")).toHaveCount(0);

  await app.close();
});

test("attaches a detached workspace back without leaving a ghost window", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);
  const lab = page.getByTestId("workspace-tab-lab");
  const labBox = await lab.boundingBox();
  expect(labBox).not.toBeNull();

  await page.mouse.move(labBox!.x + labBox!.width / 2, labBox!.y + labBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(labBox!.x + 320, labBox!.y + 280, { steps: 8 });
  await page.mouse.up();
  const second = await waitForWindowWithTestId(app, "workspace-tab-lab");

  const mainStrip = await page.getByTestId("workspace-tab-strip").boundingBox();
  const detachedTab = await second.getByTestId("workspace-tab-lab").boundingBox();
  expect(mainStrip).not.toBeNull();
  expect(detachedTab).not.toBeNull();
  const mainStripScreen = await page.getByTestId("workspace-tab-strip").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: window.screenX + rect.right - 20,
      y: window.screenY + rect.top + rect.height / 2
    };
  });

  await second.mouse.move(detachedTab!.x + detachedTab!.width / 2, detachedTab!.y + detachedTab!.height / 2);
  await second.mouse.down();
  await second.mouse.move(detachedTab!.x + detachedTab!.width / 2 + 40, detachedTab!.y + detachedTab!.height / 2 + 40, { steps: 4 });
  await second.evaluate(({ x, y }) => window.unitApi.tabs.updateDrag({ screenX: x, screenY: y }), mainStripScreen);
  await expect(async () => {
    expect(app.windows().filter((item) => !item.isClosed())).toHaveLength(1);
  }).toPass();
  await page.evaluate(({ x, y }) => window.unitApi.tabs.finishDrag({ screenX: x, screenY: y }), mainStripScreen);

  await expect(page.getByTestId("workspace-tab-lab")).toBeVisible();
  await expect(async () => {
    expect(app.windows()).toHaveLength(1);
  }).toPass();

  await app.close();
});

test("moving the last tab out of a detached window closes that window immediately", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);
  const lab = page.getByTestId("workspace-tab-lab");
  const labBox = await lab.boundingBox();
  expect(labBox).not.toBeNull();

  await page.mouse.move(labBox!.x + labBox!.width / 2, labBox!.y + labBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(labBox!.x + 320, labBox!.y + 280, { steps: 8 });
  await page.mouse.up();
  const second = await waitForWindowWithTestId(app, "workspace-tab-lab");
  const detachedTab = await second.getByTestId("workspace-tab-lab").boundingBox();
  expect(detachedTab).not.toBeNull();

  const mainStripScreen = await page.getByTestId("workspace-tab-strip").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: window.screenX + rect.right - 20,
      y: window.screenY + rect.top + rect.height / 2
    };
  });

  await second.mouse.move(detachedTab!.x + detachedTab!.width / 2, detachedTab!.y + detachedTab!.height / 2);
  await second.mouse.down();
  await second.mouse.move(detachedTab!.x + detachedTab!.width / 2 + 40, detachedTab!.y + detachedTab!.height / 2 + 40, { steps: 4 });
  await second.evaluate(({ x, y }) => window.unitApi.tabs.updateDrag({ screenX: x, screenY: y }), mainStripScreen);

  await expect(async () => {
    expect(app.windows().filter((item) => !item.isClosed())).toHaveLength(1);
  }).toPass();
  await page.evaluate(({ x, y }) => window.unitApi.tabs.finishDrag({ screenX: x, screenY: y }), mainStripScreen);
  await expect(page.getByTestId("workspace-tab-lab")).toBeVisible();

  await app.close();
});

test("last tab from detached window is projected onto target strip before release", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);
  const lab = page.getByTestId("workspace-tab-lab");
  const labBox = await lab.boundingBox();
  expect(labBox).not.toBeNull();

  await page.mouse.move(labBox!.x + labBox!.width / 2, labBox!.y + labBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(labBox!.x + 320, labBox!.y + 280, { steps: 8 });
  await page.mouse.up();
  const second = await waitForWindowWithTestId(app, "workspace-tab-lab");
  const detachedTab = await second.getByTestId("workspace-tab-lab").boundingBox();
  expect(detachedTab).not.toBeNull();

  const mainStripScreen = await page.getByTestId("workspace-tab-strip").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: window.screenX + rect.right - 20,
      y: window.screenY + rect.top + rect.height / 2
    };
  });

  await second.mouse.move(detachedTab!.x + detachedTab!.width / 2, detachedTab!.y + detachedTab!.height / 2);
  await second.mouse.down();
  await second.mouse.move(detachedTab!.x + detachedTab!.width / 2 + 40, detachedTab!.y + detachedTab!.height / 2 + 40, { steps: 4 });
  await second.evaluate(({ x, y }) => window.unitApi.tabs.updateDrag({ screenX: x, screenY: y }), mainStripScreen);

  await expect(page.getByTestId("workspace-tab-lab")).toBeVisible();
  const projectedBox = await page.getByTestId("workspace-tab-lab").boundingBox();
  const stripBox = await page.getByTestId("workspace-tab-strip").boundingBox();
  expect(projectedBox).not.toBeNull();
  expect(stripBox).not.toBeNull();
  expect(Math.abs(projectedBox!.y - stripBox!.y)).toBeLessThanOrEqual(2);
  await expect(async () => {
    expect(app.windows().filter((item) => !item.isClosed())).toHaveLength(1);
  }).toPass();
  await page.evaluate(({ x, y }) => window.unitApi.tabs.finishDrag({ screenX: x, screenY: y }), mainStripScreen);

  await app.close();
});

test("closing a detached window returns its tab to primary", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);
  const lab = page.getByTestId("workspace-tab-lab");
  const box = await lab.boundingBox();
  expect(box).not.toBeNull();

  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + 300, box!.y + 260, { steps: 8 });
  await page.mouse.up();
  const second = await waitForWindowWithTestId(app, "workspace-tab-lab");
  await second.close();

  await expect(page.getByTestId("workspace-tab-lab")).toBeVisible();
  await app.close();
});

test("Escape cancels drag and preserves original order", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);
  const before = await tabOrder(page);
  const atlas = page.getByTestId("workspace-tab-atlas");
  const box = await atlas.boundingBox();
  expect(box).not.toBeNull();

  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + 240, box!.y + 18, { steps: 6 });
  await page.keyboard.press("Escape");
  await page.mouse.up();

  await expect(page.getByTestId("floating-tab-preview")).toHaveCount(0);
  await expect(async () => {
    const payload = await page.evaluate(() => window.unitApi.tabs.bootstrap());
    expect(payload.state.dragSession).toBeNull();
    expect(await tabOrder(page)).toEqual(before);
  }).toPass();
  await app.close();
});

test("desktop layout screenshot smoke", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);
  await page.getByTestId("workspace-tab-atlas").click();
  await page.setViewportSize({ width: 1440, height: 920 });
  await expect(page).toHaveScreenshot("unit-0-shell.png", { maxDiffPixelRatio: 0.04 });
  await app.close();
});
