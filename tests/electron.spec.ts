import { _electron as electron, type ElectronApplication, type Page, expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function makeDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "unit-0-e2e-"));
}

async function launchApp(dataDir = makeDataDir()): Promise<ElectronApplication> {
  return electron.launch({
    args: [path.join(process.cwd(), ".")],
    env: {
      ...process.env,
      NODE_ENV: "test",
      UNIT0_DATA_DIR: dataDir,
      UNIT0_TAB_DEBUG: "0",
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

async function layoutLeafOrder(page: Page): Promise<string[]> {
  return page
    .locator("[data-testid^='layout-leaf-']")
    .evaluateAll((leaves) => leaves.map((leaf) => leaf.getAttribute("data-testid")?.replace("layout-leaf-", "") ?? ""));
}

async function workspaceByTitle(page: Page, title: string): Promise<{ id: string; title: string }> {
  const workspace = await page.evaluate((workspaceTitle) => {
    return window.unitApi.tabs.bootstrap().then((payload) =>
      Object.values(payload.state.workspaces).find((item) => item.title === workspaceTitle)
    );
  }, title);
  expect(workspace).toBeTruthy();
  return workspace!;
}

async function appState(page: Page) {
  return page.evaluate(() => window.unitApi.tabs.bootstrap().then((payload) => payload.state));
}

async function closeTabByTestId(page: Page, testId: string): Promise<void> {
  const tab = page.getByTestId(testId);
  const box = await tab.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width - 14, box!.y + box!.height / 2);
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

test("renders workspace applets from the persisted layout tree", async () => {
  const dataDir = makeDataDir();
  let app = await launchApp(dataDir);
  let page = await firstWindow(app);
  await page.getByTestId("workspace-tab-atlas").click();
  await expect(page.getByTestId("workspace-layout")).toBeVisible();
  await app.close();

  const db = new DatabaseSync(path.join(dataDir, "unit0.sqlite"));
  const layout = {
    id: "atlas-test-root",
    type: "split",
    direction: "row",
    ratio: 0.31,
    first: { id: "leaf-atlas-chat", type: "leaf", appletInstanceId: "atlas-chat" },
    second: {
      id: "atlas-test-rest",
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: {
        id: "atlas-test-left",
        type: "split",
        direction: "column",
        ratio: 0.5,
        first: { id: "leaf-atlas-terminal", type: "leaf", appletInstanceId: "atlas-terminal" },
        second: { id: "leaf-atlas-file-viewer", type: "leaf", appletInstanceId: "atlas-file-viewer" }
      },
      second: {
        id: "atlas-test-right",
        type: "split",
        direction: "column",
        ratio: 0.5,
        first: { id: "leaf-atlas-browser", type: "leaf", appletInstanceId: "atlas-browser" },
        second: { id: "leaf-atlas-sandbox", type: "leaf", appletInstanceId: "atlas-sandbox" }
      }
    }
  };
  db.prepare("UPDATE workspace_layouts SET layout_json = ? WHERE workspace_id = 'atlas'").run(JSON.stringify(layout));
  db.close();

  app = await launchApp(dataDir);
  page = await firstWindow(app);
  await page.getByTestId("workspace-tab-atlas").click();
  await expect(page.getByTestId("workspace-layout")).toBeVisible();
  expect(await layoutLeafOrder(page)).toEqual([
    "atlas-chat",
    "atlas-terminal",
    "atlas-file-viewer",
    "atlas-browser",
    "atlas-sandbox"
  ]);

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

test("persists primary tab order and active workspace across restart", async () => {
  const dataDir = makeDataDir();
  let app = await launchApp(dataDir);
  let page = await firstWindow(app);
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
  await page.getByTestId("workspace-tab-research").click();
  await expect(page.getByTestId("workspace-tab-research")).toHaveClass(/active/);
  await app.close();

  app = await launchApp(dataDir);
  page = await firstWindow(app);
  const order = await tabOrder(page);
  expect(order[0]).toContain("Workspace Manager");
  expect(order.at(-1)).toContain("Project Atlas");
  await expect(page.getByTestId("workspace-tab-research")).toHaveClass(/active/);

  await app.close();
});

test("creates a named workspace tab, renames it from tab context menu, closes it, and reopens it", async () => {
  const dataDir = makeDataDir();
  let app = await launchApp(dataDir);
  let page = await firstWindow(app);

  await page.getByLabel("New workspace").click();
  await expect(page.getByTestId("workspace-name-dialog")).toBeVisible();
  await page.getByLabel("Workspace name").fill("Client Portal");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByText("Client Portal")).toBeVisible();
  const created = await page.evaluate(() => {
    return window.unitApi.tabs.bootstrap().then((payload) =>
      Object.values(payload.state.workspaces).find((workspace) => workspace.title === "Client Portal")
    );
  });
  expect(created).toBeTruthy();
  const workspaceId = created!.id;
  await expect(page.getByTestId(`workspace-tab-${workspaceId}`)).toHaveClass(/active/);

  await page.getByTestId(`workspace-tab-${workspaceId}`).click({ button: "right" });
  await expect(page.getByTestId("workspace-context-menu")).toBeVisible();
  await page.getByTestId("workspace-context-rename").click();
  await page.getByLabel("Workspace name").fill("Renamed Workspace");
  await page.getByRole("button", { name: "Rename" }).click();
  await expect(page.getByTestId(`workspace-tab-${workspaceId}`)).toContainText("Renamed Workspace");

  await app.close();
  app = await launchApp(dataDir);
  page = await firstWindow(app);
  await expect(page.getByTestId(`workspace-tab-${workspaceId}`)).toBeVisible();
  await expect(page.getByTestId(`workspace-tab-${workspaceId}`)).toHaveClass(/active/);

  await closeTabByTestId(page, `workspace-tab-${workspaceId}`);
  await expect(page.getByTestId(`workspace-tab-${workspaceId}`)).toHaveCount(0);
  await page.getByTestId("workspace-tab-manager").click();
  await expect(page.getByTestId("workspace-manager")).toBeVisible();
  await page.getByTestId(`workspace-manager-row-${workspaceId}`).click();
  await expect(page.getByTestId(`workspace-tab-${workspaceId}`)).toBeVisible();
  await expect(page.getByTestId(`workspace-tab-${workspaceId}`)).toHaveClass(/active/);

  await app.close();
});

test("spawns a terminal in an empty workspace and persists it across restart", async () => {
  const dataDir = makeDataDir();
  let app = await launchApp(dataDir);
  let page = await firstWindow(app);

  await page.getByLabel("New workspace").click();
  await page.getByLabel("Workspace name").fill("Terminal Workspace");
  await page.getByRole("button", { name: "Create" }).click();
  const workspace = await workspaceByTitle(page, "Terminal Workspace");
  await expect(page.getByTestId("workspace-empty")).toBeVisible();
  await page.getByRole("button", { name: "New terminal" }).last().click();
  await expect(page.getByTestId("applet-terminal")).toHaveCount(1);
  const surfaceBox = await page.getByTestId("workspace-surface").boundingBox();
  const leafBox = await page.locator("[data-testid^='layout-leaf-']").boundingBox();
  expect(surfaceBox).not.toBeNull();
  expect(leafBox).not.toBeNull();
  expect(leafBox!.height).toBeGreaterThan(surfaceBox!.height - 24);
  const stateBeforeRestart = await appState(page);
  expect(stateBeforeRestart.workspaces[workspace.id].applets).toHaveLength(1);
  const instanceId = stateBeforeRestart.workspaces[workspace.id].applets[0].id;
  const sessionId = stateBeforeRestart.workspaces[workspace.id].applets[0].sessionId;
  expect(stateBeforeRestart.appletSessions[sessionId]?.kind).toBe("terminal");
  await app.close();

  app = await launchApp(dataDir);
  page = await firstWindow(app);
  await expect(page.getByTestId(`workspace-tab-${workspace.id}`)).toBeVisible();
  await expect(page.getByTestId(`layout-leaf-${instanceId}`)).toBeVisible();
  await expect(page.getByTestId("applet-terminal")).toHaveCount(1);

  await app.close();
});

test("applet picker spawns a selected applet kind", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);
  await page.getByTestId("workspace-tab-atlas").click();
  const beforeBrowserCount = await page.getByTestId("applet-browser").count();

  await page.locator('[data-applet-instance-id="atlas-terminal"]').getByLabel("Terminal add applet").click();
  await page.getByRole("menuitem", { name: "Browser" }).click();

  await expect(page.getByTestId("applet-browser")).toHaveCount(beforeBrowserCount + 1);
  const state = await appState(page);
  const browserInstances = state.workspaces.atlas.applets.filter(
    (instance) => state.appletSessions[instance.sessionId]?.kind === "browser"
  );
  expect(browserInstances.length).toBeGreaterThanOrEqual(2);

  await app.close();
});

test("drags an applet to a root edge with preview and persists placement", async () => {
  const dataDir = makeDataDir();
  let app = await launchApp(dataDir);
  let page = await firstWindow(app);
  await page.getByTestId("workspace-tab-atlas").click();
  const title = page.locator('[data-applet-instance-id="atlas-chat"] .applet-title');
  const titleBox = await title.boundingBox();
  const surfaceBox = await page.getByTestId("workspace-surface").boundingBox();
  expect(titleBox).not.toBeNull();
  expect(surfaceBox).not.toBeNull();

  await page.mouse.move(titleBox!.x + 42, titleBox!.y + titleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(surfaceBox!.x + 28, surfaceBox!.y + surfaceBox!.height / 2, { steps: 10 });
  await expect(page.getByTestId("applet-drag-ghost")).toBeVisible();
  await expect(page.getByTestId("applet-drop-indicator")).toBeVisible();
  await page.mouse.up();

  await expect(async () => {
    const state = await appState(page);
    const layout = state.workspaces.atlas.layout;
    expect(layout?.type).toBe("split");
    if (layout?.type === "split") {
      expect(layout.direction).toBe("row");
      expect(layout.first.type).toBe("leaf");
      if (layout.first.type === "leaf") {
        expect(layout.first.appletInstanceId).toBe("atlas-chat");
      }
    }
  }).toPass();
  await app.close();

  app = await launchApp(dataDir);
  page = await firstWindow(app);
  await page.getByTestId("workspace-tab-atlas").click();
  const stateAfterRestart = await appState(page);
  const layout = stateAfterRestart.workspaces.atlas.layout;
  expect(layout?.type).toBe("split");
  if (layout?.type === "split") {
    expect(layout.first.type).toBe("leaf");
    if (layout.first.type === "leaf") {
      expect(layout.first.appletInstanceId).toBe("atlas-chat");
    }
  }

  await app.close();
});

test("drags an applet into another applet split target", async () => {
  const dataDir = makeDataDir();
  const app = await launchApp(dataDir);
  const page = await firstWindow(app);
  await page.getByTestId("workspace-tab-atlas").click();
  const chatTitle = page.locator('[data-applet-instance-id="atlas-chat"] .applet-title');
  const chatTitleBox = await chatTitle.boundingBox();
  const browserBox = await page.getByTestId("layout-leaf-atlas-browser").boundingBox();
  expect(chatTitleBox).not.toBeNull();
  expect(browserBox).not.toBeNull();

  await page.mouse.move(chatTitleBox!.x + 42, chatTitleBox!.y + chatTitleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(browserBox!.x + browserBox!.width - 18, browserBox!.y + browserBox!.height / 2, { steps: 10 });
  await expect(page.getByTestId("applet-drop-indicator")).toBeVisible();
  await page.mouse.up();

  await expect(async () => {
    const movedIntoBrowserSplit = await page.evaluate(() =>
      window.unitApi.tabs.bootstrap().then((payload) => {
        const layout = payload.state.workspaces.atlas.layout;
        const includes = (node: typeof layout, instanceId: string): boolean => {
          if (!node) {
            return false;
          }
          if (node.type === "leaf") {
            return node.appletInstanceId === instanceId;
          }
          return includes(node.first, instanceId) || includes(node.second, instanceId);
        };
        const hasBrowserChatSplit = (node: typeof layout): boolean => {
          if (!node || node.type === "leaf") {
            return false;
          }
          return (
            (includes(node.first, "atlas-browser") && includes(node.second, "atlas-chat")) ||
            (includes(node.first, "atlas-chat") && includes(node.second, "atlas-browser")) ||
            hasBrowserChatSplit(node.first) ||
            hasBrowserChatSplit(node.second)
          );
        };
        return hasBrowserChatSplit(layout);
      })
    );
    expect(movedIntoBrowserSplit).toBe(true);
  }).toPass();

  await app.close();
});

test("splits a pane right, persists the new terminal, then closes and collapses it", async () => {
  const dataDir = makeDataDir();
  let app = await launchApp(dataDir);
  let page = await firstWindow(app);
  await page.getByTestId("workspace-tab-atlas").click();
  const beforeLeaves = await layoutLeafOrder(page);

  await page.locator('[data-applet-instance-id="atlas-terminal"]').getByLabel("Terminal split right").click();
  await expect(async () => {
    expect(await layoutLeafOrder(page)).toHaveLength(beforeLeaves.length + 1);
  }).toPass();
  const afterSplitLeaves = await layoutLeafOrder(page);
  const spawnedId = afterSplitLeaves.find((leafId) => !beforeLeaves.includes(leafId));
  expect(spawnedId).toBeTruthy();
  const stateAfterSplit = await appState(page);
  const spawnedInstance = stateAfterSplit.workspaces.atlas.applets.find((instance) => instance.id === spawnedId);
  expect(spawnedInstance).toBeTruthy();
  expect(stateAfterSplit.appletSessions[spawnedInstance!.sessionId]?.kind).toBe("terminal");
  await app.close();

  app = await launchApp(dataDir);
  page = await firstWindow(app);
  await page.getByTestId("workspace-tab-atlas").click();
  await expect(page.getByTestId(`layout-leaf-${spawnedId}`)).toBeVisible();
  await page.locator(`[data-applet-instance-id="${spawnedId}"]`).getByLabel("Terminal close").click();
  await expect(page.getByTestId(`layout-leaf-${spawnedId}`)).toHaveCount(0);
  expect(await layoutLeafOrder(page)).toEqual(beforeLeaves);
  const stateAfterClose = await appState(page);
  expect(stateAfterClose.appletSessions[spawnedInstance!.sessionId]).toBeUndefined();
  await app.close();

  app = await launchApp(dataDir);
  page = await firstWindow(app);
  await page.getByTestId("workspace-tab-atlas").click();
  await expect(page.getByTestId(`layout-leaf-${spawnedId}`)).toHaveCount(0);
  expect(await layoutLeafOrder(page)).toEqual(beforeLeaves);

  await app.close();
});

test("splits a pane down with stacked geometry", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);
  await page.getByTestId("workspace-tab-atlas").click();
  const beforeLeaves = await layoutLeafOrder(page);

  await page.locator('[data-applet-instance-id="atlas-browser"]').getByLabel("Browser split down").click();
  await expect(async () => {
    expect(await layoutLeafOrder(page)).toHaveLength(beforeLeaves.length + 1);
  }).toPass();
  const afterLeaves = await layoutLeafOrder(page);
  const spawnedId = afterLeaves.find((leafId) => !beforeLeaves.includes(leafId));
  expect(spawnedId).toBeTruthy();
  const browserBox = await page.getByTestId("layout-leaf-atlas-browser").boundingBox();
  const spawnedBox = await page.getByTestId(`layout-leaf-${spawnedId}`).boundingBox();
  expect(browserBox).not.toBeNull();
  expect(spawnedBox).not.toBeNull();
  expect(spawnedBox!.y).toBeGreaterThan(browserBox!.y + browserBox!.height / 2);
  expect(Math.abs(spawnedBox!.x - browserBox!.x)).toBeLessThanOrEqual(4);

  await app.close();
});

test("closing the only applet leaves an empty workspace and deletes its session", async () => {
  const dataDir = makeDataDir();
  let app = await launchApp(dataDir);
  let page = await firstWindow(app);

  await page.getByLabel("New workspace").click();
  await page.getByLabel("Workspace name").fill("Closable Workspace");
  await page.getByRole("button", { name: "Create" }).click();
  const workspace = await workspaceByTitle(page, "Closable Workspace");
  await page.getByRole("button", { name: "New terminal" }).last().click();
  const stateWithTerminal = await appState(page);
  const instance = stateWithTerminal.workspaces[workspace.id].applets[0];
  await page.locator(`[data-applet-instance-id="${instance.id}"]`).getByLabel("Terminal close").click();
  await expect(page.getByTestId("workspace-empty")).toBeVisible();
  const stateAfterClose = await appState(page);
  expect(stateAfterClose.workspaces[workspace.id].applets).toHaveLength(0);
  expect(stateAfterClose.workspaces[workspace.id].layout).toBeNull();
  expect(stateAfterClose.appletSessions[instance.sessionId]).toBeUndefined();
  await app.close();

  app = await launchApp(dataDir);
  page = await firstWindow(app);
  await expect(page.getByTestId(`workspace-tab-${workspace.id}`)).toBeVisible();
  await expect(page.getByTestId("workspace-empty")).toBeVisible();

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
