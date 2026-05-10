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
  await page.waitForSelector("main.app-shell");
  return page;
}

async function configureMockCodexThread(page: Page, autoExpandCodexDisclosures = true): Promise<void> {
  await page.evaluate(async ({ autoExpand }) => {
    const state = await window.unitApi.chat.bootstrap();
    await window.unitApi.chat.updateAppSettings({ settings: { autoExpandCodexDisclosures: autoExpand } });
    await window.unitApi.chat.updateProjectSettings({
      projectId: state.selectedProjectId,
      title: state.projects.find((project) => project.id === state.selectedProjectId)?.title ?? "Project 1",
      directory: "C:\\Workspace"
    });
    await window.unitApi.chat.updateThreadSettings({
      threadId: state.selectedThreadId,
      providerMode: "codex",
      codexModelId: "gpt-5.3-codex",
      codexReasoningEffort: "medium",
      permissionMode: "default_permissions",
      planModeEnabled: true
    });
  }, { autoExpand: autoExpandCodexDisclosures });
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

async function layoutRatio(page: Page, workspaceId: string, splitId: string): Promise<number | null> {
  return page.evaluate(
    ({ workspaceId: targetWorkspaceId, splitId: targetSplitId }) =>
      window.unitApi.tabs.bootstrap().then((payload) => {
        const visit = (node: unknown): number | null => {
          if (!node || typeof node !== "object") {
            return null;
          }
          const layoutNode = node as NonNullable<(typeof payload.state.workspaces)[string]["layout"]>;
          if (layoutNode.type === "leaf") {
            return null;
          }
          if (layoutNode.id === targetSplitId) {
            return layoutNode.ratio;
          }
          return visit(layoutNode.first) ?? visit(layoutNode.second);
        };
        return visit(payload.state.workspaces[targetWorkspaceId]?.layout ?? null);
      }),
    { workspaceId, splitId }
  );
}

function expectPixelAligned(actual: number, expected: number, tolerance = 1): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
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

  const state = await appState(page);
  const host = Object.values(state.hosts)[0];
  const order = host.tabIds.map((tabId) => state.tabs[tabId]?.title ?? "");
  expect(order[0]).toContain("Workspace Manager");
  expect(order).toContain("Project Atlas");
  expect(order).toContain("Website Redesign");
  expect(order).toContain("VM Lab");
  expect(order).toContain("Research");

  await app.close();
});

test("renders the initial applet surfaces", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);

  const state = await appState(page);
  const atlas = Object.values(state.workspaces).find((workspace) => workspace.title === "Project Atlas");
  expect(atlas).toBeTruthy();
  const kinds = atlas!.applets.map((applet) => state.appletSessions[applet.sessionId]?.kind);
  expect(kinds).toEqual(expect.arrayContaining(["terminal", "fileViewer", "browser", "chat", "sandbox"]));
  await expect(page.getByTestId("chat-surface")).toBeVisible();

  await app.close();
});

test("chat sidebar and dropup controls align to rendered trigger bounds", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);
  await expect(page.getByTestId("chat-surface")).toBeVisible();

  const sidebarMetrics = await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) {
        throw new Error(`Missing selector: ${selector}`);
      }
      const bounds = element.getBoundingClientRect();
      return {
        left: bounds.left,
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        width: bounds.width,
        height: bounds.height
      };
    };
    const centerX = (selector: string) => {
      const bounds = rect(selector);
      return bounds.left + bounds.width / 2;
    };
    const visibleSvgCenterX = (selector: string) => {
      const svg = document.querySelector(selector);
      if (!(svg instanceof SVGGraphicsElement)) {
        throw new Error(`Missing SVG selector: ${selector}`);
      }
      const matrix = svg.getScreenCTM();
      if (!matrix) {
        throw new Error(`Missing SVG matrix: ${selector}`);
      }
      const shapeBounds = Array.from(svg.querySelectorAll<SVGGraphicsElement>("path, line, polyline, circle, rect")).map((shape) => {
        const box = shape.getBBox();
        const points = [
          new DOMPoint(box.x, box.y).matrixTransform(matrix),
          new DOMPoint(box.x + box.width, box.y).matrixTransform(matrix),
          new DOMPoint(box.x, box.y + box.height).matrixTransform(matrix),
          new DOMPoint(box.x + box.width, box.y + box.height).matrixTransform(matrix)
        ];
        return {
          left: Math.min(...points.map((point) => point.x)),
          right: Math.max(...points.map((point) => point.x))
        };
      });
      return (Math.min(...shapeBounds.map((bounds) => bounds.left)) + Math.max(...shapeBounds.map((bounds) => bounds.right))) / 2;
    };
    const threadsLabel = document.querySelector("[data-testid='chat-section-threads-label']");
    if (!threadsLabel) {
      throw new Error("Missing Threads label");
    }
    const threadsStyle = window.getComputedStyle(threadsLabel);
    return {
      newThreadLabel: rect("[data-testid='chat-new-thread-label']"),
      firstProjectLabel: rect(".chat-project-title"),
      settingsLabel: rect("[data-testid='chat-settings-label']"),
      newThreadIconCenterX: centerX("[data-testid='chat-new-thread-icon']"),
      projectCaretCenterX: centerX(".chat-project-toggle [data-testid^='chat-project-caret-']"),
      settingsIconCenterX: centerX("[data-testid='chat-settings-icon']"),
      newThreadSvgCenterX: centerX("[data-testid='chat-new-thread-icon'] svg"),
      projectCaretSvgCenterX: centerX(".chat-project-toggle [data-testid^='chat-project-caret-'] svg"),
      settingsSvgCenterX: centerX("[data-testid='chat-settings-icon'] svg"),
      newThreadVisibleCenterX: visibleSvgCenterX("[data-testid='chat-new-thread-icon'] svg"),
      projectCaretVisibleCenterX: visibleSvgCenterX(".chat-project-toggle [data-testid^='chat-project-caret-'] svg"),
      settingsVisibleCenterX: visibleSvgCenterX("[data-testid='chat-settings-icon'] svg"),
      newThreadButton: rect(".chat-new-thread-button"),
      threadsLabel: rect("[data-testid='chat-section-threads-label']"),
      firstProject: rect(".chat-project-card"),
      threadsFontSize: threadsStyle.fontSize,
      threadsColor: threadsStyle.color
    };
  });

  expectPixelAligned(sidebarMetrics.firstProjectLabel.left, sidebarMetrics.newThreadLabel.left);
  expectPixelAligned(sidebarMetrics.settingsLabel.left, sidebarMetrics.newThreadLabel.left);
  expectPixelAligned(sidebarMetrics.projectCaretCenterX, sidebarMetrics.newThreadIconCenterX);
  expectPixelAligned(sidebarMetrics.settingsIconCenterX, sidebarMetrics.newThreadIconCenterX);
  expectPixelAligned(sidebarMetrics.newThreadSvgCenterX, sidebarMetrics.newThreadIconCenterX);
  expectPixelAligned(sidebarMetrics.projectCaretSvgCenterX, sidebarMetrics.newThreadIconCenterX);
  expectPixelAligned(sidebarMetrics.settingsSvgCenterX, sidebarMetrics.newThreadIconCenterX);
  expectPixelAligned(sidebarMetrics.newThreadVisibleCenterX, sidebarMetrics.newThreadIconCenterX);
  expectPixelAligned(sidebarMetrics.projectCaretVisibleCenterX, sidebarMetrics.newThreadIconCenterX);
  expectPixelAligned(sidebarMetrics.settingsVisibleCenterX, sidebarMetrics.newThreadIconCenterX);
  expect(sidebarMetrics.threadsFontSize).toBe("14px");
  expect(sidebarMetrics.threadsColor).toBe("rgb(143, 154, 166)");
  expect(sidebarMetrics.threadsLabel.top - sidebarMetrics.newThreadButton.bottom).toBeGreaterThanOrEqual(12);
  expect(sidebarMetrics.firstProject.top - sidebarMetrics.threadsLabel.bottom).toBeLessThanOrEqual(10);

  const trigger = page.locator(".chat-composer-control-row .chat-ghost-button").first();
  const triggerBox = await trigger.boundingBox();
  expect(triggerBox).not.toBeNull();
  await trigger.click();
  const dropup = page.locator(".chat-dropup");
  await expect(dropup).toBeVisible();
  const dropupBox = await dropup.boundingBox();
  expect(dropupBox).not.toBeNull();
  expectPixelAligned(dropupBox!.x + dropupBox!.width, triggerBox!.x + triggerBox!.width);
  expectPixelAligned(dropupBox!.y + dropupBox!.height, triggerBox!.y - 8, 1.5);

  await app.close();
});

test("renders global chat state and persists local model selection", async () => {
  const dataDir = makeDataDir();
  const modelPath = path.join(dataDir, "local-test-model.gguf");
  fs.writeFileSync(modelPath, "not a real model");
  let app = await launchApp(dataDir);
  let page = await firstWindow(app);

  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect(page.getByTestId("chat-status")).toHaveCount(0);
  const firstState = await page.evaluate(() => window.unitApi.chat.bootstrap());
  expect(firstState.projects).toHaveLength(1);
  expect(firstState.threads).toHaveLength(1);

  const modelState = await page.evaluate((pathToModel) => window.unitApi.chat.addLocalModel({ path: pathToModel }), modelPath);
  expect(modelState.models).toHaveLength(1);
  expect(modelState.selectedModelId).toBe(modelState.models[0].id);
  await expect(page.getByLabel("Local chat model")).toHaveValue(modelState.models[0].id);
  await app.close();

  app = await launchApp(dataDir);
  page = await firstWindow(app);
  await expect(page.getByLabel("Local chat model")).toHaveValue(modelState.models[0].id);
  await app.close();
});

test("chat creates and selects threads through the applet API", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);

  const created = await page.evaluate(() => window.unitApi.chat.createThread());
  expect(created.threads).toHaveLength(2);
  const newThread = created.threads.at(-1)!;
  await expect(page.getByTestId(`chat-thread-${newThread.id}`)).toBeVisible();
  await page.evaluate((threadId) => window.unitApi.chat.selectThread({ threadId }), created.threads[0].id);
  const selected = await page.evaluate(() => window.unitApi.chat.bootstrap());
  expect(selected.selectedThreadId).toBe(created.threads[0].id);

  await app.close();
});

test("chat project actions and composer menus are backed by persistent state", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);
  await expect(page.getByTestId("chat-surface")).toBeVisible();

  await page.getByLabel("New project").click();
  await page.locator("input[name='project-title']").fill("Visual Parity");
  await page.locator("input[name='project-directory']").fill("C:\\Workspace");
  await page.getByRole("dialog", { name: "New project" }).getByRole("button", { name: "Save" }).click();
  let state = await page.evaluate(() => window.unitApi.chat.bootstrap());
  const project = state.projects.at(-1)!;
  expect(state.selectedProjectId).toBe(project.id);
  expect(state.projects.find((item) => item.id === project.id)?.title).toBe("Visual Parity");
  expect(state.projects.find((item) => item.id === project.id)?.directory).toBe("C:\\Workspace");

  await page.getByRole("button", { name: "Medium" }).click();
  await page.getByRole("menuitemradio", { name: "High" }).click();
  state = await page.evaluate(() => window.unitApi.chat.bootstrap());
  expect(state.runtimeSettings.reasoningEffort).toBe("high");

  await page.getByLabel("Model settings").click();
  const settingsDropup = page.locator(".chat-dropup");
  await expect(settingsDropup).toBeVisible();
  const hoveredDropupButton = settingsDropup.locator("button:not([disabled])").first();
  await hoveredDropupButton.hover();
  const dropupButtonStyle = await hoveredDropupButton.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderWidth: style.borderWidth
    };
  });
  expect(dropupButtonStyle.backgroundColor).toBe("rgb(31, 45, 72)");
  expect(dropupButtonStyle.borderWidth).toBe("0px");
  await page.getByRole("menuitem", { name: "New preset..." }).click();
  const presetDialog = page.getByRole("dialog", { name: "Settings preset" });
  await expect(presetDialog).toBeVisible();
  await presetDialog.getByLabel("Name").fill("Parity Preset");
  await presetDialog.getByRole("button", { name: "Save" }).click();
  state = await page.evaluate(() => window.unitApi.chat.bootstrap());
  expect(state.settingsPresets.some((preset) => preset.label === "Parity Preset")).toBe(true);

  await page.getByLabel("Model settings").click();
  const editPresetButton = page.getByLabel("Edit Parity Preset");
  await expect(editPresetButton).toBeVisible();
  await editPresetButton.hover();
  const inlineButtonStyle = await editPresetButton.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderWidth: style.borderWidth
    };
  });
  expect(inlineButtonStyle.backgroundColor).toBe("rgb(43, 58, 86)");
  expect(inlineButtonStyle.borderWidth).toBe("0px");

  await app.close();
});

test("chat settings dialogs fit inside applets and use app-styled dropdowns", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);
  await expect(page.getByTestId("chat-surface")).toBeVisible();

  await page.getByTestId("chat-surface").getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "App settings" });
  await expect(dialog).toBeVisible();

  const bounds = await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) {
        throw new Error(`Missing selector: ${selector}`);
      }
      const box = element.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    };
    return {
      backdrop: rect(".chat-dialog-backdrop"),
      dialog: rect(".chat-settings-dialog")
    };
  });
  expect(bounds.dialog.left).toBeGreaterThanOrEqual(bounds.backdrop.left);
  expect(bounds.dialog.top).toBeGreaterThanOrEqual(bounds.backdrop.top);
  expect(bounds.dialog.right).toBeLessThanOrEqual(bounds.backdrop.right);
  expect(bounds.dialog.bottom).toBeLessThanOrEqual(bounds.backdrop.bottom);

  await page.getByRole("button", { name: "Document indexing" }).click();
  const menu = page.locator(".chat-setting-select-menu");
  await expect(menu).toBeVisible();
  const menuStyle = await menu.evaluate((element) => {
    const style = window.getComputedStyle(element);
    const selected = element.querySelector("[aria-selected='true']");
    const selectedStyle = selected ? window.getComputedStyle(selected) : null;
    return {
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      selectedBackgroundColor: selectedStyle?.backgroundColor,
      selectedBorderWidth: selectedStyle?.borderWidth
    };
  });
  expect(menuStyle.backgroundColor).toBe("rgb(17, 24, 33)");
  expect(menuStyle.borderColor).toBe("rgb(52, 66, 84)");
  expect(menuStyle.selectedBackgroundColor).toBe("rgb(31, 45, 72)");
  expect(menuStyle.selectedBorderWidth).toBe("0px");

  await app.close();
});

test("chat Codex mode uses mocked events and provider-aware menus", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect(page.getByTestId("workspace-tab-strip")).toBeVisible();

  await page.evaluate(async () => {
    const state = await window.unitApi.chat.bootstrap();
    await window.unitApi.chat.updateProjectSettings({
      projectId: state.selectedProjectId,
      title: state.projects.find((project) => project.id === state.selectedProjectId)?.title ?? "Project 1",
      directory: "C:\\Workspace"
    });
    await window.unitApi.chat.updateThreadSettings({
      threadId: state.selectedThreadId,
      providerMode: "codex",
      codexModelId: "gpt-5.3-codex",
      codexReasoningEffort: "medium",
      permissionMode: "default_permissions",
      planModeEnabled: true
    });
  });

  await expect(page.getByRole("button", { name: "Open model menu" })).toContainText("GPT-5.3 Codex");
  await page.getByTestId("chat-surface").getByRole("button", { name: "More actions", exact: true }).click();
  await expect(page.getByRole("menuitemcheckbox", { name: "Plan mode" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Upload image..." })).toBeVisible();
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.locator(".chat-surface").click({ position: { x: 10, y: 10 } });

  await page.getByRole("textbox", { name: "Chat message" }).fill("mock codex turn");
  await page.getByLabel("Send chat message").click();
  await expect(page.getByTestId("chat-message-assistant")).toContainText("Mocked Codex response: mock codex turn");
  const state = await page.evaluate(() => window.unitApi.chat.bootstrap());
  const assistant = state.messages.find((message) => message.role === "assistant");
  expect(assistant?.sourceLabel).toBe("Codex");
  expect(assistant?.timelineBlocks?.some((block) => block.kind === "tool")).toBe(true);
  const assistantRenderOrder = await page.evaluate(() => {
    const assistantMessage = document.querySelector<HTMLElement>("[data-testid='chat-message-assistant']");
    const plan = assistantMessage?.querySelector<HTMLElement>(".codex-plan-card");
    const reasoning = assistantMessage?.querySelector<HTMLElement>(".codex-reasoning-block");
    const tool = assistantMessage?.querySelector<HTMLElement>(".codex-tool-card");
    const body = assistantMessage?.querySelector<HTMLElement>(".codex-assistant-message-block");
    const duplicateStandaloneBody = assistantMessage?.querySelector<HTMLElement>(":scope > .assistant-content-block");
    const reasoningDetails = assistantMessage?.querySelector<HTMLDetailsElement>(".codex-reasoning-block details.reasoning-shell");
    const toolDetails = assistantMessage?.querySelector<HTMLDetailsElement>("details.codex-tool-card");
    const badge = assistantMessage?.querySelector<HTMLElement>(".codex-event-badge[data-status='completed']");
    if (!assistantMessage || !plan || !reasoning || !tool || !body || !reasoningDetails || !toolDetails || !badge) {
      throw new Error("Missing Codex assistant render elements");
    }
    return {
      planTop: Math.round(plan.getBoundingClientRect().top),
      reasoningTop: Math.round(reasoning.getBoundingClientRect().top),
      toolTop: Math.round(tool.getBoundingClientRect().top),
      bodyTop: Math.round(body.getBoundingClientRect().top),
      hasDuplicateStandaloneBody: Boolean(duplicateStandaloneBody),
      reasoningOpen: reasoningDetails.open,
      toolOpen: toolDetails.open,
      badgeColor: getComputedStyle(badge).color
    };
  });
  expect(assistantRenderOrder.planTop).toBeLessThanOrEqual(assistantRenderOrder.reasoningTop);
  expect(assistantRenderOrder.reasoningTop).toBeLessThanOrEqual(assistantRenderOrder.toolTop);
  expect(assistantRenderOrder.toolTop).toBeLessThanOrEqual(assistantRenderOrder.bodyTop);
  expect(assistantRenderOrder.hasDuplicateStandaloneBody).toBe(false);
  expect(assistantRenderOrder.reasoningOpen).toBe(false);
  expect(assistantRenderOrder.toolOpen).toBe(false);
  expect(assistantRenderOrder.badgeColor).toBe("rgb(168, 213, 182)");

  await app.close();
});

test("chat fenced code blocks can be copied", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await configureMockCodexThread(page);

  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as typeof window & { __unitCopiedCode?: string }).__unitCopiedCode = text;
        }
      }
    });
  });

  await page.evaluate((text) => window.unitApi.chat.submit({ text }), "show this block\n```ts\nconst value = 42;\n```\n");
  await expect(page.locator(".chat-code-copy-button").first()).toBeVisible();
  const widthBeforeCopy = await page.locator(".chat-code-copy-button").first().evaluate((button) => Math.round(button.getBoundingClientRect().width));
  await page.locator(".chat-code-copy-button").first().click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __unitCopiedCode?: string }).__unitCopiedCode)).toBe("const value = 42;\n");
  await expect(page.locator(".chat-code-copy-button").first()).toHaveText("Copied");
  const widthAfterCopy = await page.locator(".chat-code-copy-button").first().evaluate((button) => Math.round(button.getBoundingClientRect().width));
  expect(widthAfterCopy).toBe(widthBeforeCopy);
  await page.evaluate(async () => {
    const state = await window.unitApi.chat.bootstrap();
    await window.unitApi.chat.updateAppSettings({ settings: { autoExpandCodexDisclosures: !state.appSettings.autoExpandCodexDisclosures } });
  });
  await expect(page.locator(".chat-code-copy-button").first()).toHaveText("Copied");
  await page.waitForTimeout(1500);
  await expect(page.locator(".chat-code-copy-button").first()).toHaveText("Copied");

  await app.close();
});

test("chat sidebar renders Codex limit usage and remaining hover text", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);
  await expect(page.getByTestId("chat-surface")).toBeVisible();

  await expect(page.locator(".chat-sidebar-limit-row")).toHaveCount(2);
  const rows = await page.locator(".chat-sidebar-limit-row").evaluateAll((elements) => elements.map((row) => {
    const fill = row.querySelector<HTMLElement>(".chat-sidebar-limit-fill");
    return {
      label: row.querySelector(".chat-sidebar-limit-label")?.textContent?.trim(),
      title: row.getAttribute("title"),
      ariaLabel: row.getAttribute("aria-label"),
      fillWidth: fill?.style.width,
      backgroundSize: fill?.style.backgroundSize
    };
  }));

  expect(rows.map(({ backgroundSize: _backgroundSize, ...row }) => row)).toEqual([
    { label: "Weekly:", title: "Weekly limit: 88% left, 12% used", ariaLabel: "Weekly limit: 88% left, 12% used", fillWidth: "88%" },
    { label: "5h:", title: "5h limit: 66% left, 34% used", ariaLabel: "5h limit: 66% left, 34% used", fillWidth: "66%" }
  ]);
  expect(parseFloat(rows[0].backgroundSize ?? "")).toBeCloseTo(10000 / 88, 3);
  expect(parseFloat(rows[1].backgroundSize ?? "")).toBeCloseTo(10000 / 66, 3);

  await app.close();
});

test("chat reasoning fenced code copy state survives rerender", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await configureMockCodexThread(page);

  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as typeof window & { __unitCopiedCode?: string }).__unitCopiedCode = text;
        }
      }
    });
  });

  await page.evaluate(() => window.unitApi.chat.submit({ text: "[reasoning-code-fixture]" }));
  await expect(page.getByTestId("chat-message-assistant")).toContainText("Mocked Codex response");
  await page.locator("details.reasoning-shell summary.reasoning-toggle").first().click();

  await expect(page.locator("details.reasoning-shell .chat-code-copy-button").first()).toBeVisible();
  const widthBeforeCopy = await page.locator("details.reasoning-shell .chat-code-copy-button").first().evaluate((button) => Math.round(button.getBoundingClientRect().width));
  await page.locator("details.reasoning-shell .chat-code-copy-button").first().click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __unitCopiedCode?: string }).__unitCopiedCode)).toBe("const reason = 7;\n");
  await expect(page.locator("details.reasoning-shell .chat-code-copy-button").first()).toHaveText("Copied");
  const widthAfterCopy = await page.locator("details.reasoning-shell .chat-code-copy-button").first().evaluate((button) => Math.round(button.getBoundingClientRect().width));
  expect(widthAfterCopy).toBe(widthBeforeCopy);
  await page.evaluate(async () => {
    const state = await window.unitApi.chat.bootstrap();
    await window.unitApi.chat.updateAppSettings({ settings: { autoExpandCodexDisclosures: !state.appSettings.autoExpandCodexDisclosures } });
  });
  await expect(page.locator("details.reasoning-shell .chat-code-copy-button").first()).toHaveText("Copied");

  await app.close();
});

test("chat context bar partially fills each strip left to right", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await configureMockCodexThread(page);

  await page.evaluate(async () => {
    const state = await window.unitApi.chat.bootstrap();
    await window.unitApi.chat.updateThreadSettings({
      threadId: state.selectedThreadId,
      runtimeSettings: { nCtx: 4000 }
    });
  });
  await page.evaluate((text) => window.unitApi.chat.submit({ text }), "x".repeat(100));

  await expect.poll(() => page.locator(".chat-context-tile-bar span").first().evaluate((strip) =>
    getComputedStyle(strip).getPropertyValue("--chat-context-strip-fill").trim()
  )).not.toBe("0%");

  const stripState = await page.evaluate(() => {
    const strips = Array.from(document.querySelectorAll<HTMLElement>(".chat-context-tile-bar span"));
    const firstStyle = getComputedStyle(strips[0]);
    const secondStyle = getComputedStyle(strips[1]);
    return {
      firstFill: parseFloat(firstStyle.getPropertyValue("--chat-context-strip-fill")),
      firstBackgroundPosition: firstStyle.backgroundPosition,
      firstBackgroundFillSize: parseFloat(firstStyle.backgroundSize),
      secondFill: parseFloat(secondStyle.getPropertyValue("--chat-context-strip-fill"))
    };
  });
  expect(stripState.firstFill).toBeGreaterThan(0);
  expect(stripState.firstFill).toBeLessThan(100);
  expect(stripState.secondFill).toBe(0);
  expect(stripState.firstBackgroundPosition).toContain("0px 0px");
  expect(stripState.firstBackgroundFillSize).toBeCloseTo(stripState.firstFill, 1);

  await app.close();
});

test("chat applet recomputes compact transcript geometry from its own width", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);
  await page.setViewportSize({ width: 640, height: 760 });
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect(page.locator(".chat-surface")).toHaveClass(/chat-surface-compact/);

  const metrics = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>(".chat-main");
    const column = document.querySelector<HTMLElement>(".chat-content-column");
    const composer = document.querySelector<HTMLElement>(".chat-composer");
    const overlay = document.querySelector<HTMLElement>(".chat-composer-section");
    if (!main || !column || !composer || !overlay) {
      throw new Error("Chat geometry elements missing");
    }
    return {
      mainWidth: Math.round(main.getBoundingClientRect().width),
      columnWidth: Math.round(column.getBoundingClientRect().width),
      composerWidth: Math.round(composer.getBoundingClientRect().width),
      cssContentWidth: Math.round(parseFloat(getComputedStyle(main).getPropertyValue("--chat-content-width"))),
      overlayBackground: getComputedStyle(overlay).backgroundColor,
      overlayZIndex: getComputedStyle(overlay).zIndex
    };
  });

  expect(metrics.cssContentWidth).toBeLessThan(metrics.mainWidth);
  expect(metrics.columnWidth).toBe(metrics.cssContentWidth);
  expect(metrics.composerWidth).toBe(metrics.cssContentWidth);
  expect(metrics.overlayBackground).toBe("rgb(12, 16, 20)");
  expect(metrics.overlayZIndex).toBe("2");

  await app.close();
});

test("chat transcript scrollbar and latest-message control drive the scroll host", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);
  await page.setViewportSize({ width: 900, height: 560 });
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await configureMockCodexThread(page);

  const longPrompt = Array.from({ length: 120 }, (_, index) => `scrollbar line ${index + 1}`).join("\n");
  await page.evaluate((text) => window.unitApi.chat.submit({ text }), longPrompt);
  await expect(page.getByTestId("chat-message-assistant")).toContainText("Mocked Codex response");

  const scrollMetrics = await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const thread = document.querySelector<HTMLElement>(".chat-thread");
    const track = document.querySelector<HTMLElement>(".chat-overlay-scrollbar-thread");
    const thumb = document.querySelector<HTMLElement>(".chat-overlay-scrollbar-thread span");
    const overlay = document.querySelector<HTMLElement>(".chat-composer-section");
    const spacer = document.querySelector<HTMLElement>(".chat-manual-end-spacer");
    const lastMessage = Array.from(document.querySelectorAll<HTMLElement>(".chat-message")).at(-1);
    if (!thread || !track || !thumb || !overlay || !spacer || !lastMessage) {
      throw new Error("Missing transcript scrollbar elements");
    }
    const hostRect = thread.getBoundingClientRect();
    const spacerRect = spacer.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();
    const hostPaddingBottom = Math.max(0, Math.round(parseFloat(getComputedStyle(thread).paddingBottom) || 0));
    const effectiveClientHeight = Math.max(1, thread.clientHeight - Math.ceil(overlayRect.height));
    const spacerTop = thread.scrollTop + spacerRect.top - hostRect.top;
    const contentMaxScroll = Math.max(0, Math.min(thread.scrollHeight, spacerTop + hostPaddingBottom) - effectiveClientHeight);
    const physicalMaxScroll = Math.max(0, thread.scrollHeight - thread.clientHeight);
    const lastRect = lastMessage.getBoundingClientRect();
    return {
      scrollable: track.classList.contains("scrollable"),
      scrollHeight: thread.scrollHeight,
      clientHeight: thread.clientHeight,
      contentMaxScroll,
      physicalMaxScroll,
      manualSlack: Math.round(spacerRect.height),
      thumbHeight: Math.round(thumb.getBoundingClientRect().height),
      lastMessageAboveOverlay: lastRect.bottom <= overlayRect.top + 2
    };
  });
  expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
  expect(scrollMetrics.physicalMaxScroll).toBeGreaterThan(scrollMetrics.contentMaxScroll + 80);
  expect(scrollMetrics.manualSlack).toBeGreaterThanOrEqual(120);
  expect(scrollMetrics.scrollable).toBe(true);
  expect(scrollMetrics.thumbHeight).toBeGreaterThanOrEqual(42);
  expect(scrollMetrics.lastMessageAboveOverlay).toBe(true);

  await page.evaluate(() => {
    const thread = document.querySelector<HTMLElement>(".chat-thread");
    if (!thread) {
      throw new Error("Missing transcript");
    }
    thread.scrollTop = 0;
    thread.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(page.locator(".chat-scroll-bottom-button.visible").first()).toBeVisible();
  const buttonAlignment = await page.evaluate(() => {
    const button = Array.from(document.querySelectorAll<HTMLElement>(".chat-scroll-bottom-button.visible"))
      .find((element) => element.getBoundingClientRect().width > 0);
    const main = button?.closest<HTMLElement>(".chat-main");
    const content = main?.querySelector<HTMLElement>(".chat-content-column");
    if (!button || !main || !content) {
      throw new Error("Missing scroll button alignment elements");
    }
    const buttonRect = button.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const contentCenterX = contentRect.width > 0 ? contentRect.left + contentRect.width / 2 : mainRect.left + mainRect.width / 2;
    return {
      buttonCenterX: buttonRect.left + buttonRect.width / 2,
      contentCenterX,
      mainCenterX: mainRect.left + mainRect.width / 2
    };
  });
  expectPixelAligned(buttonAlignment.buttonCenterX, buttonAlignment.mainCenterX, 1.5);
  expectPixelAligned(buttonAlignment.buttonCenterX, buttonAlignment.contentCenterX, 1.5);
  await expect.poll(() => page.evaluate(() => {
    const track = document.querySelector<HTMLElement>(".chat-overlay-scrollbar-thread");
    const thumb = document.querySelector<HTMLElement>(".chat-overlay-scrollbar-thread span");
    if (!track || !thumb) {
      throw new Error("Missing transcript scrollbar");
    }
    return Math.round(thumb.getBoundingClientRect().top - track.getBoundingClientRect().top);
  })).toBeLessThanOrEqual(2);
  const thumbBefore = await page.locator(".chat-overlay-scrollbar-thread span").evaluate((thumb) => thumb.getBoundingClientRect().top);
  const trackBox = await page.locator(".chat-overlay-scrollbar-thread").boundingBox();
  expect(trackBox).not.toBeNull();
  await page.mouse.click(trackBox!.x + trackBox!.width / 2, trackBox!.y + trackBox!.height - 6);
  await expect.poll(() => page.evaluate(() => document.querySelector<HTMLElement>(".chat-thread")?.scrollTop ?? 0)).toBeGreaterThan(20);
  const trackClickBottomDistance = await page.evaluate(() => {
    const thread = document.querySelector<HTMLElement>(".chat-thread");
    const spacer = document.querySelector<HTMLElement>(".chat-manual-end-spacer");
    const overlay = document.querySelector<HTMLElement>(".chat-composer-section");
    if (!thread || !spacer || !overlay) {
      throw new Error("Missing overscroll elements");
    }
    const hostRect = thread.getBoundingClientRect();
    const spacerRect = spacer.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();
    const hostPaddingBottom = Math.max(0, Math.round(parseFloat(getComputedStyle(thread).paddingBottom) || 0));
    const effectiveClientHeight = Math.max(1, thread.clientHeight - Math.ceil(overlayRect.height));
    const spacerTop = thread.scrollTop + spacerRect.top - hostRect.top;
    const contentMaxScroll = Math.max(0, Math.min(thread.scrollHeight, spacerTop + hostPaddingBottom) - effectiveClientHeight);
    return Math.round(Math.abs(thread.scrollTop - contentMaxScroll));
  });
  expect(trackClickBottomDistance).toBeLessThanOrEqual(24);
  const thumbAfter = await page.locator(".chat-overlay-scrollbar-thread span").evaluate((thumb) => thumb.getBoundingClientRect().top);
  expect(thumbAfter).toBeGreaterThan(thumbBefore);

  await page.evaluate(() => {
    const thread = document.querySelector<HTMLElement>(".chat-thread");
    if (!thread) {
      throw new Error("Missing transcript");
    }
    thread.scrollTop = 0;
    thread.dispatchEvent(new Event("scroll", { bubbles: true }));
    const originalScrollTo = thread.scrollTo.bind(thread);
    (window as unknown as { __chatScrollToBehaviors: Array<ScrollBehavior | undefined> }).__chatScrollToBehaviors = [];
    thread.scrollTo = ((options?: ScrollToOptions | number, y?: number) => {
      if (typeof options === "object") {
        (window as unknown as { __chatScrollToBehaviors: Array<ScrollBehavior | undefined> }).__chatScrollToBehaviors.push(options.behavior);
        return originalScrollTo(options);
      }
      return originalScrollTo(options ?? 0, y ?? 0);
    }) as typeof thread.scrollTo;
  });
  await page.getByLabel("Scroll to latest message").click();
  expect(await page.evaluate(() => (window as unknown as { __chatScrollToBehaviors?: Array<ScrollBehavior | undefined> }).__chatScrollToBehaviors ?? [])).toContain("smooth");
  await expect.poll(() => page.evaluate(() => {
    const thread = document.querySelector<HTMLElement>(".chat-thread");
    const spacer = document.querySelector<HTMLElement>(".chat-manual-end-spacer");
    const overlay = document.querySelector<HTMLElement>(".chat-composer-section");
    if (!thread || !spacer || !overlay) {
      throw new Error("Missing transcript");
    }
    const hostRect = thread.getBoundingClientRect();
    const spacerRect = spacer.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();
    const hostPaddingBottom = Math.max(0, Math.round(parseFloat(getComputedStyle(thread).paddingBottom) || 0));
    const effectiveClientHeight = Math.max(1, thread.clientHeight - Math.ceil(overlayRect.height));
    const spacerTop = thread.scrollTop + spacerRect.top - hostRect.top;
    const contentMaxScroll = Math.max(0, Math.min(thread.scrollHeight, spacerTop + hostPaddingBottom) - effectiveClientHeight);
    return Math.round(Math.abs(contentMaxScroll - thread.scrollTop));
  })).toBeLessThanOrEqual(24);

  await app.close();
});

test("chat overscroll waits for content bottom before resuming latest follow", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);
  await page.setViewportSize({ width: 900, height: 560 });
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await configureMockCodexThread(page);

  const longPrompt = Array.from({ length: 120 }, (_, index) => `overscroll line ${index + 1}`).join("\n");
  await page.evaluate((text) => window.unitApi.chat.submit({ text }), longPrompt);
  await expect(page.getByTestId("chat-message-assistant")).toContainText("Mocked Codex response");
  await expect.poll(() => page.evaluate(async () => (await window.unitApi.chat.bootstrap()).generation.status)).toBe("idle");

  await page.evaluate(async () => {
    const readMetrics = () => {
      const thread = document.querySelector<HTMLElement>(".chat-thread");
      const spacer = document.querySelector<HTMLElement>(".chat-manual-end-spacer");
      const overlay = document.querySelector<HTMLElement>(".chat-composer-section");
      if (!thread || !spacer || !overlay) {
        throw new Error("Missing overscroll elements");
      }
      const hostRect = thread.getBoundingClientRect();
      const spacerRect = spacer.getBoundingClientRect();
      const overlayRect = overlay.getBoundingClientRect();
      const hostPaddingBottom = Math.max(0, Math.round(parseFloat(getComputedStyle(thread).paddingBottom) || 0));
      const effectiveClientHeight = Math.max(1, thread.clientHeight - Math.ceil(overlayRect.height));
      const spacerTop = thread.scrollTop + spacerRect.top - hostRect.top;
      const contentMaxScroll = Math.max(0, Math.min(thread.scrollHeight, spacerTop + hostPaddingBottom) - effectiveClientHeight);
      return {
        thread,
        contentMaxScroll,
        maxScroll: Math.max(0, thread.scrollHeight - thread.clientHeight),
        scrollTop: thread.scrollTop
      };
    };
    const metrics = readMetrics();
    metrics.thread.scrollTop = metrics.contentMaxScroll;
    metrics.thread.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  await page.evaluate(async () => {
    const thread = document.querySelector<HTMLElement>(".chat-thread");
    const spacer = document.querySelector<HTMLElement>(".chat-manual-end-spacer");
    if (!thread || !spacer) {
      throw new Error("Missing overscroll elements");
    }
    spacer.style.height = `${Math.round(spacer.getBoundingClientRect().height + 900)}px`;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await expect.poll(() => page.evaluate(() => {
    const thread = document.querySelector<HTMLElement>(".chat-thread");
    const spacer = document.querySelector<HTMLElement>(".chat-manual-end-spacer");
    const overlay = document.querySelector<HTMLElement>(".chat-composer-section");
    if (!thread || !spacer || !overlay) {
      throw new Error("Missing overscroll elements");
    }
    const hostRect = thread.getBoundingClientRect();
    const spacerRect = spacer.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();
    const hostPaddingBottom = Math.max(0, Math.round(parseFloat(getComputedStyle(thread).paddingBottom) || 0));
    const effectiveClientHeight = Math.max(1, thread.clientHeight - Math.ceil(overlayRect.height));
    const spacerTop = thread.scrollTop + spacerRect.top - hostRect.top;
    const contentMaxScroll = Math.max(0, Math.min(thread.scrollHeight, spacerTop + hostPaddingBottom) - effectiveClientHeight);
    const maxScroll = Math.max(0, thread.scrollHeight - thread.clientHeight);
    return Math.round(maxScroll - contentMaxScroll);
  })).toBeGreaterThan(500);

  const before = await page.evaluate(async () => {
    const readMetrics = () => {
      const thread = document.querySelector<HTMLElement>(".chat-thread");
      const spacer = document.querySelector<HTMLElement>(".chat-manual-end-spacer");
      const overlay = document.querySelector<HTMLElement>(".chat-composer-section");
      if (!thread || !spacer || !overlay) {
        throw new Error("Missing overscroll elements");
      }
      const hostRect = thread.getBoundingClientRect();
      const spacerRect = spacer.getBoundingClientRect();
      const overlayRect = overlay.getBoundingClientRect();
      const hostPaddingBottom = Math.max(0, Math.round(parseFloat(getComputedStyle(thread).paddingBottom) || 0));
      const effectiveClientHeight = Math.max(1, thread.clientHeight - Math.ceil(overlayRect.height));
      const spacerTop = thread.scrollTop + spacerRect.top - hostRect.top;
      const contentMaxScroll = Math.max(0, Math.min(thread.scrollHeight, spacerTop + hostPaddingBottom) - effectiveClientHeight);
      return {
        thread,
        contentMaxScroll,
        maxScroll: Math.max(0, thread.scrollHeight - thread.clientHeight),
        scrollTop: thread.scrollTop
      };
    };
    let metrics = readMetrics();
    metrics = readMetrics();
    const overscrollTop = Math.min(metrics.contentMaxScroll + 720, metrics.maxScroll - 8);
    if (overscrollTop <= metrics.contentMaxScroll + 500) {
      throw new Error(`Manual end slack did not allow enough overscroll: ${overscrollTop - metrics.contentMaxScroll}`);
    }
    metrics.thread.scrollTop = overscrollTop;
    metrics.thread.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    metrics = readMetrics();
    return {
      scrollTop: Math.round(metrics.scrollTop),
      contentMaxScroll: Math.round(metrics.contentMaxScroll),
      overscrollOffset: Math.round(metrics.scrollTop - metrics.contentMaxScroll),
      maxScroll: Math.round(metrics.maxScroll)
    };
  });
  expect(before.overscrollOffset).toBeGreaterThan(500);

  await page.evaluate(() => window.unitApi.chat.submit({ text: "short overscroll probe" }));
  await expect(page.getByTestId("chat-message-assistant").nth(1)).toContainText("Mocked Codex response: short overscroll probe");
  await expect.poll(() => page.evaluate(async () => (await window.unitApi.chat.bootstrap()).generation.status)).toBe("idle");

  const after = await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const thread = document.querySelector<HTMLElement>(".chat-thread");
    const spacer = document.querySelector<HTMLElement>(".chat-manual-end-spacer");
    const overlay = document.querySelector<HTMLElement>(".chat-composer-section");
    const latestButtonVisible = Boolean(document.querySelector<HTMLElement>(".chat-scroll-bottom-button.visible"));
    if (!thread || !spacer || !overlay) {
      throw new Error("Missing overscroll elements");
    }
    const hostRect = thread.getBoundingClientRect();
    const spacerRect = spacer.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();
    const hostPaddingBottom = Math.max(0, Math.round(parseFloat(getComputedStyle(thread).paddingBottom) || 0));
    const effectiveClientHeight = Math.max(1, thread.clientHeight - Math.ceil(overlayRect.height));
    const spacerTop = thread.scrollTop + spacerRect.top - hostRect.top;
    const contentMaxScroll = Math.max(0, Math.min(thread.scrollHeight, spacerTop + hostPaddingBottom) - effectiveClientHeight);
    return {
      scrollTop: Math.round(thread.scrollTop),
      contentMaxScroll: Math.round(contentMaxScroll),
      overscrollOffset: Math.round(thread.scrollTop - contentMaxScroll),
      latestButtonVisible
    };
  });
  expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(12);
  expect(after.contentMaxScroll).toBeGreaterThan(before.contentMaxScroll);
  expect(after.overscrollOffset).toBeLessThan(before.overscrollOffset);
  expect(after.overscrollOffset).toBeGreaterThan(24);
  expect(after.latestButtonVisible).toBe(false);

  await app.close();
});

test("chat disclosure changes preserve the transcript reading position", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);
  await page.setViewportSize({ width: 900, height: 620 });
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await configureMockCodexThread(page, false);

  await page.evaluate(() => window.unitApi.chat.submit({ text: "first disclosure turn" }));
  await expect(page.getByTestId("chat-message-assistant")).toContainText("Mocked Codex response");
  await expect.poll(() => page.evaluate(async () => (await window.unitApi.chat.bootstrap()).generation.status)).toBe("idle");
  const longPrompt = Array.from({ length: 100 }, (_, index) => `second turn line ${index + 1}`).join("\n");
  await page.evaluate((text) => window.unitApi.chat.submit({ text }), longPrompt);
  await expect(page.getByTestId("chat-message-assistant").nth(1)).toContainText("Mocked Codex response");

  await expect.poll(() => page.evaluate(() => {
    const firstDisclosure = document.querySelector<HTMLDetailsElement>("details.codex-event-disclosure");
    const firstReasoning = document.querySelector<HTMLDetailsElement>("details.reasoning-shell");
    return {
      toolOpen: firstDisclosure?.open ?? null,
      reasoningOpen: firstReasoning?.open ?? null
    };
  })).toEqual({ toolOpen: false, reasoningOpen: false });

  await page.evaluate(async () => {
    const firstDisclosure = document.querySelector<HTMLDetailsElement>("details.codex-event-disclosure");
    const firstSummary = firstDisclosure?.querySelector<HTMLElement>("summary");
    const firstDisclosureBody = firstDisclosure?.querySelector<HTMLElement>(".codex-event-disclosure-body-shell");
    const secondUserMessage = document.querySelectorAll<HTMLElement>("[data-testid='chat-message-user']").item(1);
    const thread = document.querySelector<HTMLElement>(".chat-thread");
    if (!firstDisclosure || !firstSummary || !firstDisclosureBody || !secondUserMessage || !thread) {
      throw new Error("Missing disclosure preservation elements");
    }
    if (firstDisclosure.open) {
      throw new Error("Timeline disclosure should not auto-expand when auto-expand is disabled");
    }
    firstDisclosureBody.style.minHeight = "720px";
    secondUserMessage.scrollIntoView({ block: "start" });
    thread.scrollTop += 18;
    thread.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });

  const before = await page.evaluate(() => {
    const secondUserMessage = document.querySelectorAll<HTMLElement>("[data-testid='chat-message-user']").item(1);
    const thread = document.querySelector<HTMLElement>(".chat-thread");
    if (!secondUserMessage || !thread) {
      throw new Error("Missing second user message");
    }
    return {
      top: Math.round(secondUserMessage.getBoundingClientRect().top),
      scrollTop: Math.round(thread.scrollTop)
    };
  });

  await page.evaluate(async () => {
    const firstSummary = document.querySelector<HTMLElement>("details.codex-event-disclosure summary");
    if (!firstSummary) {
      throw new Error("Missing disclosure summary");
    }
    firstSummary.click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const after = await page.evaluate(() => {
    const secondUserMessage = document.querySelectorAll<HTMLElement>("[data-testid='chat-message-user']").item(1);
    const thread = document.querySelector<HTMLElement>(".chat-thread");
    if (!secondUserMessage || !thread) {
      throw new Error("Missing second user message");
    }
    return {
      top: Math.round(secondUserMessage.getBoundingClientRect().top),
      scrollTop: Math.round(thread.scrollTop)
    };
  });
  expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(3);
  expect(after.scrollTop).toBeGreaterThan(before.scrollTop + 600);

  await app.close();
});

test("chat reasoning collapse preserves manual overscroll position", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);
  await page.setViewportSize({ width: 900, height: 620 });
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await configureMockCodexThread(page, false);

  const longPrompt = Array.from({ length: 120 }, (_, index) => `reasoning overscroll line ${index + 1}`).join("\n");
  await page.evaluate((text) => window.unitApi.chat.submit({ text }), longPrompt);
  await expect(page.getByTestId("chat-message-assistant")).toContainText("Mocked Codex response");
  await expect.poll(() => page.evaluate(async () => (await window.unitApi.chat.bootstrap()).generation.status)).toBe("idle");

  await page.evaluate(async () => {
    const reasoning = document.querySelector<HTMLDetailsElement>("details.reasoning-shell");
    const summary = reasoning?.querySelector<HTMLElement>("summary.reasoning-toggle");
    const panel = reasoning?.querySelector<HTMLElement>(".reasoning-panel");
    const spacer = document.querySelector<HTMLElement>(".chat-manual-end-spacer");
    const thread = document.querySelector<HTMLElement>(".chat-thread");
    const overlay = document.querySelector<HTMLElement>(".chat-composer-section");
    if (!reasoning || !summary || !panel || !spacer || !thread || !overlay) {
      throw new Error("Missing reasoning overscroll elements");
    }
    if (!reasoning.open) {
      summary.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }
    panel.style.minHeight = "760px";
    spacer.style.height = `${Math.round(spacer.getBoundingClientRect().height + 900)}px`;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const hostRect = thread.getBoundingClientRect();
    const spacerRect = spacer.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();
    const hostPaddingBottom = Math.max(0, Math.round(parseFloat(getComputedStyle(thread).paddingBottom) || 0));
    const effectiveClientHeight = Math.max(1, thread.clientHeight - Math.ceil(overlayRect.height));
    const spacerTop = thread.scrollTop + spacerRect.top - hostRect.top;
    const contentMaxScroll = Math.max(0, Math.min(thread.scrollHeight, spacerTop + hostPaddingBottom) - effectiveClientHeight);
    thread.scrollTop = Math.min(contentMaxScroll + 260, Math.max(0, thread.scrollHeight - thread.clientHeight - 8));
    thread.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const before = await page.evaluate(() => {
    const thread = document.querySelector<HTMLElement>(".chat-thread");
    const reasoning = document.querySelector<HTMLDetailsElement>("details.reasoning-shell");
    if (!thread || !reasoning) {
      throw new Error("Missing reasoning overscroll state");
    }
    return {
      open: reasoning.open,
      scrollTop: Math.round(thread.scrollTop)
    };
  });
  expect(before.open).toBe(true);

  await page.evaluate(async () => {
    const summary = document.querySelector<HTMLElement>("details.reasoning-shell summary.reasoning-toggle");
    if (!summary) {
      throw new Error("Missing reasoning summary");
    }
    summary.click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const after = await page.evaluate(() => {
    const thread = document.querySelector<HTMLElement>(".chat-thread");
    const reasoning = document.querySelector<HTMLDetailsElement>("details.reasoning-shell");
    if (!thread || !reasoning) {
      throw new Error("Missing reasoning overscroll state");
    }
    return {
      open: reasoning.open,
      scrollTop: Math.round(thread.scrollTop)
    };
  });
  expect(after.open).toBe(false);
  expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(3);

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

test("creates, renames, reopens, and closes a workspace from the manager", async () => {
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

  await page.evaluate(async (targetWorkspaceId) => {
    const payload = await window.unitApi.tabs.bootstrap();
    const tab = Object.values(payload.state.tabs).find((item) => item.workspaceId === targetWorkspaceId);
    if (!tab) {
      throw new Error(`Missing tab for workspace ${targetWorkspaceId}`);
    }
    await window.unitApi.tabs.closeTab({ windowId: payload.windowId, tabId: tab.id });
  }, workspaceId);
  await expect(page.getByTestId(`workspace-tab-${workspaceId}`)).toHaveCount(0);
  await page.getByTestId("workspace-tab-manager").click();
  await expect(page.getByTestId("workspace-manager")).toBeVisible();
  await page.getByTestId(`workspace-manager-row-${workspaceId}`).click();
  await expect(page.getByTestId(`workspace-tab-${workspaceId}`)).toBeVisible();
  await expect(page.getByTestId(`workspace-tab-${workspaceId}`)).toHaveClass(/active/);

  await page.getByTestId("workspace-tab-manager").click();
  await page.getByTestId(`workspace-manager-close-${workspaceId}`).click();
  await expect(page.getByTestId(`workspace-manager-row-${workspaceId}`)).toHaveCount(0);
  await expect(page.getByTestId(`workspace-tab-${workspaceId}`)).toHaveCount(0);
  let state = await appState(page);
  expect(state.workspaces[workspaceId]).toBeUndefined();
  expect(Object.values(state.tabs).some((tab) => tab.workspaceId === workspaceId)).toBe(false);

  await app.close();
  app = await launchApp(dataDir);
  page = await firstWindow(app);
  state = await appState(page);
  expect(state.workspaces[workspaceId]).toBeUndefined();
  await expect(page.getByTestId(`workspace-manager-row-${workspaceId}`)).toHaveCount(0);

  await app.close();
});

test("applies a template to a blank workspace and persists created applets", async () => {
  const dataDir = makeDataDir();
  let app = await launchApp(dataDir);
  let page = await firstWindow(app);

  await page.getByLabel("New workspace").click();
  await page.getByLabel("Workspace name").fill("Template Blank");
  await page.getByRole("button", { name: "Create" }).click();
  const workspace = await workspaceByTitle(page, "Template Blank");

  await page.getByLabel("Templates").click();
  await expect(page.getByTestId("template-drawer")).toBeVisible();
  await expect(page.getByTestId("template-option-grid-2x2")).toContainText("2 x 2 Grid");
  await expect(page.getByText("Web App Debugging")).toHaveCount(0);
  const drawerBox = await page.locator(".template-drawer").boundingBox();
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  expect(drawerBox).not.toBeNull();
  expect(drawerBox!.height / viewportHeight).toBeGreaterThan(0.64);
  await page.getByTestId("template-option-grid-2x2").click();
  await page.getByTestId("template-apply").click();

  await expect(page.getByTestId("applet-terminal")).toHaveCount(4);
  let state = await appState(page);
  expect(state.workspaces[workspace.id].shelfAppletIds).toEqual([]);

  await app.close();
  app = await launchApp(dataDir);
  page = await firstWindow(app);
  await page.getByTestId(`workspace-tab-${workspace.id}`).click();
  await expect(page.getByTestId("applet-terminal")).toHaveCount(4);

  state = await appState(page);
  expect(state.workspaces[workspace.id].shelfAppletIds).toEqual([]);
  await app.close();
});

test("applies a template to an existing workspace, supports reassignment, and persists shelf", async () => {
  const dataDir = makeDataDir();
  let app = await launchApp(dataDir);
  let page = await firstWindow(app);
  await page.getByTestId("workspace-tab-atlas").click();

  await page.getByLabel("Templates").click();
  await page.getByTestId("template-option-grid-2x2").click();
  await page.getByTestId("template-cell-grid-2x2-4").locator("select").selectOption("create:wslTerminal");
  await page.getByTestId("template-apply").click();

  await expect(page.getByTestId("applet-wslTerminal")).toBeVisible();
  await expect(page.getByTestId("layout-leaf-atlas-chat")).toHaveCount(0);
  await expect(page.getByTestId("workspace-shelf")).toBeVisible();
  let state = await appState(page);
  expect(state.workspaces.atlas.shelfAppletIds.sort()).toEqual(["atlas-chat", "atlas-sandbox"]);

  await app.close();
  app = await launchApp(dataDir);
  page = await firstWindow(app);
  await page.getByTestId("workspace-tab-atlas").click();
  await expect(page.getByTestId("applet-wslTerminal")).toBeVisible();
  await expect(page.getByTestId("workspace-shelf")).toBeVisible();
  state = await appState(page);
  expect(state.workspaces.atlas.shelfAppletIds.sort()).toEqual(["atlas-chat", "atlas-sandbox"]);
  await app.close();
});

test("rejects duplicate template reuse assignments atomically", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);

  await expect(
    page.evaluate(() =>
      window.unitApi.workspaces.applyTemplate({
        workspaceId: "atlas",
        templateId: "grid-2x2",
        assignments: {
          "grid-2x2-1": { mode: "reuse", appletInstanceId: "atlas-file-viewer" },
          "grid-2x2-2": { mode: "reuse", appletInstanceId: "atlas-browser" },
          "grid-2x2-3": { mode: "reuse", appletInstanceId: "atlas-terminal" },
          "grid-2x2-4": { mode: "reuse", appletInstanceId: "atlas-terminal" }
        }
      })
    )
  ).rejects.toThrow(/more than one template cell/);
  const state = await appState(page);
  expect(state.workspaces.atlas.shelfAppletIds).toEqual([]);
  expect(state.workspaces.atlas.applets.map((instance) => instance.id).sort()).toEqual([
    "atlas-browser",
    "atlas-chat",
    "atlas-file-viewer",
    "atlas-sandbox",
    "atlas-terminal"
  ]);

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
  await expect(page.locator(".terminal-surface .xterm")).toBeVisible();
  await expect(async () => {
    const overflow = await page.locator(".terminal-surface").evaluate((element) => ({
      horizontal: element.scrollWidth - element.clientWidth,
      vertical: element.scrollHeight - element.clientHeight
    }));
    expect(overflow.horizontal).toBeLessThanOrEqual(1);
    expect(overflow.vertical).toBeLessThanOrEqual(1);
  }).toPass();
  await expect(async () => {
    const scrollbarWidth = await page.locator(".terminal-surface .xterm-viewport").evaluate(
      (element) => element.getBoundingClientRect().width - element.clientWidth
    );
    expect(scrollbarWidth).toBeLessThanOrEqual(1);
  }).toPass();
  await expect(async () => {
    const customScrollbarWidth = await page
      .locator(".terminal-surface .xterm-scrollable-element > .scrollbar.vertical")
      .evaluate((element) => element.getBoundingClientRect().width);
    expect(customScrollbarWidth).toBeLessThanOrEqual(8);
  }).toPass();
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
  await page.getByRole("menuitem", { name: "Add Browser split right" }).click();

  await expect(page.getByTestId("applet-browser")).toHaveCount(beforeBrowserCount + 1);
  const state = await appState(page);
  const browserInstances = state.workspaces.atlas.applets.filter(
    (instance) => state.appletSessions[instance.sessionId]?.kind === "browser"
  );
  expect(browserInstances.length).toBeGreaterThanOrEqual(2);

  await page.locator('[data-applet-instance-id="atlas-terminal"]').getByLabel("Terminal add applet").click();
  await page.getByRole("menuitem", { name: "Add WSL Terminal split down" }).click();

  await expect(page.getByTestId("applet-wslTerminal")).toHaveCount(1);
  const stateWithWsl = await appState(page);
  const wslInstances = stateWithWsl.workspaces.atlas.applets.filter(
    (instance) => stateWithWsl.appletSessions[instance.sessionId]?.kind === "wslTerminal"
  );
  expect(wslInstances).toHaveLength(1);

  await app.close();
});

test("applet change type button updates the mounted applet kind", async () => {
  const dataDir = makeDataDir();
  let app = await launchApp(dataDir);
  let page = await firstWindow(app);
  await page.getByTestId("workspace-tab-atlas").click();

  await page.locator('[data-applet-instance-id="atlas-terminal"]').getByLabel("Terminal change applet type").click();
  await page.getByRole("menuitemradio", { name: "Chat" }).click();

  await expect(page.locator('section[data-applet-instance-id="atlas-terminal"]')).toHaveAttribute(
    "data-testid",
    "applet-chat"
  );
  const state = await appState(page);
  const instance = state.workspaces.atlas.applets.find((item) => item.id === "atlas-terminal");
  expect(instance).toBeTruthy();
  expect(state.appletSessions[instance!.sessionId]?.kind).toBe("chat");
  await app.close();

  app = await launchApp(dataDir);
  page = await firstWindow(app);
  await page.getByTestId("workspace-tab-atlas").click();
  await expect(page.locator('section[data-applet-instance-id="atlas-terminal"]')).toHaveAttribute(
    "data-testid",
    "applet-chat"
  );
  await app.close();
});

test("applet switch places button swaps two mounted applets and persists layout", async () => {
  const dataDir = makeDataDir();
  let app = await launchApp(dataDir);
  let page = await firstWindow(app);
  await page.getByTestId("workspace-tab-atlas").click();

  const terminalBefore = await page.getByTestId("layout-leaf-atlas-terminal").boundingBox();
  const browserBefore = await page.getByTestId("layout-leaf-atlas-browser").boundingBox();
  expect(terminalBefore).not.toBeNull();
  expect(browserBefore).not.toBeNull();

  await page.locator('[data-applet-instance-id="atlas-terminal"]').getByLabel("Terminal switch places").click();
  await expect(page.locator('section[data-applet-instance-id="atlas-terminal"]')).toHaveClass(/applet-frame-switch-source/);
  await page.locator('section[data-applet-instance-id="atlas-browser"]').click();

  await expect(async () => {
    const terminalAfter = await page.getByTestId("layout-leaf-atlas-terminal").boundingBox();
    const browserAfter = await page.getByTestId("layout-leaf-atlas-browser").boundingBox();
    expect(terminalAfter).not.toBeNull();
    expect(browserAfter).not.toBeNull();
    expect(Math.abs(terminalAfter!.x - browserBefore!.x)).toBeLessThan(2);
    expect(Math.abs(terminalAfter!.y - browserBefore!.y)).toBeLessThan(2);
    expect(Math.abs(browserAfter!.x - terminalBefore!.x)).toBeLessThan(2);
    expect(Math.abs(browserAfter!.y - terminalBefore!.y)).toBeLessThan(2);
  }).toPass();
  await app.close();

  app = await launchApp(dataDir);
  page = await firstWindow(app);
  await page.getByTestId("workspace-tab-atlas").click();
  const terminalRestarted = await page.getByTestId("layout-leaf-atlas-terminal").boundingBox();
  const browserRestarted = await page.getByTestId("layout-leaf-atlas-browser").boundingBox();
  expect(terminalRestarted).not.toBeNull();
  expect(browserRestarted).not.toBeNull();
  expect(Math.abs(terminalRestarted!.x - browserBefore!.x)).toBeLessThan(2);
  expect(Math.abs(terminalRestarted!.y - browserBefore!.y)).toBeLessThan(2);
  expect(Math.abs(browserRestarted!.x - terminalBefore!.x)).toBeLessThan(2);
  expect(Math.abs(browserRestarted!.y - terminalBefore!.y)).toBeLessThan(2);
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
  await page.getByLabel("New workspace").click();
  await page.getByLabel("Workspace name").fill("Stacked Split Workspace");
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByRole("button", { name: "New terminal" }).last().click();
  await expect(page.getByTestId("applet-terminal")).toHaveCount(1);
  const beforeLeaves = await layoutLeafOrder(page);

  const instanceId = beforeLeaves[0];
  const splitDown = page.locator(`[data-applet-instance-id="${instanceId}"]`).getByLabel("Terminal split down");
  await expect(splitDown).toBeEnabled();
  await splitDown.click();
  await expect(async () => {
    expect(await layoutLeafOrder(page)).toHaveLength(beforeLeaves.length + 1);
  }).toPass();
  const afterLeaves = await layoutLeafOrder(page);
  const spawnedId = afterLeaves.find((leafId) => !beforeLeaves.includes(leafId));
  expect(spawnedId).toBeTruthy();
  const browserBox = await page.getByTestId(`layout-leaf-${instanceId}`).boundingBox();
  const spawnedBox = await page.getByTestId(`layout-leaf-${spawnedId}`).boundingBox();
  expect(browserBox).not.toBeNull();
  expect(spawnedBox).not.toBeNull();
  expect(spawnedBox!.y).toBeGreaterThan(browserBox!.y + browserBox!.height / 2);
  expect(Math.abs(spawnedBox!.x - browserBox!.x)).toBeLessThanOrEqual(4);

  await app.close();
});

test("disables split controls when the pane cannot fit two minimum applets", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);
  await page.getByTestId("workspace-tab-atlas").click();

  const splitter = page.locator('[data-testid="layout-splitter-vertical"]').first();
  const splitterBox = await splitter.boundingBox();
  expect(splitterBox).not.toBeNull();

  await page.mouse.move(splitterBox!.x + splitterBox!.width / 2, splitterBox!.y + splitterBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(splitterBox!.x - 1000, splitterBox!.y + splitterBox!.height / 2, { steps: 12 });
  await page.mouse.up();

  await expect(page.locator('[data-applet-instance-id="atlas-terminal"]').getByLabel("Terminal split right")).toBeDisabled();
  await expect(page.locator('[data-applet-instance-id="atlas-terminal"]').getByLabel("Terminal split down")).toBeEnabled();

  await app.close();
});

test("highlights the completed splitter group on hover", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);
  await page.getByTestId("workspace-tab-atlas").click();
  const splitter = page.locator('[data-testid="layout-splitter-vertical"]').first();
  const box = await splitter.boundingBox();
  expect(box).not.toBeNull();

  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect(page.locator('[data-testid="layout-splitter-highlight-vertical"]').first()).toBeVisible();

  await app.close();
});

test("snaps splitter drags to independent aligned splitter targets unless Alt is held", async () => {
  const dataDir = makeDataDir();
  let app = await launchApp(dataDir);
  let page = await firstWindow(app);
  await page.getByTestId("workspace-tab-atlas").click();
  await expect(page.getByTestId("workspace-layout")).toBeVisible();
  await app.close();

  const db = new DatabaseSync(path.join(dataDir, "unit0.sqlite"));
  const layout = {
    id: "atlas-snap-root",
    type: "split",
    direction: "column",
    ratio: 0.5,
    first: {
      id: "atlas-snap-top",
      type: "split",
      direction: "row",
      ratio: 0.34,
      first: { id: "leaf-atlas-terminal", type: "leaf", appletInstanceId: "atlas-terminal" },
      second: { id: "leaf-atlas-file-viewer", type: "leaf", appletInstanceId: "atlas-file-viewer" }
    },
    second: {
      id: "atlas-snap-bottom",
      type: "split",
      direction: "row",
      ratio: 0.66,
      first: { id: "leaf-atlas-browser", type: "leaf", appletInstanceId: "atlas-browser" },
      second: {
        id: "atlas-snap-bottom-right",
        type: "split",
        direction: "column",
        ratio: 0.5,
        first: { id: "leaf-atlas-chat", type: "leaf", appletInstanceId: "atlas-chat" },
        second: { id: "leaf-atlas-sandbox", type: "leaf", appletInstanceId: "atlas-sandbox" }
      }
    }
  };
  db.prepare("UPDATE workspace_layouts SET layout_json = ? WHERE workspace_id = 'atlas'").run(JSON.stringify(layout));
  db.close();

  app = await launchApp(dataDir);
  page = await firstWindow(app);
  await page.getByTestId("workspace-tab-atlas").click();
  const verticalSplitters = page.locator('[data-testid="layout-splitter-vertical"]');
  await expect(verticalSplitters).toHaveCount(2);
  const topSplitter = await verticalSplitters.nth(0).boundingBox();
  const bottomSplitter = await verticalSplitters.nth(1).boundingBox();
  expect(topSplitter).not.toBeNull();
  expect(bottomSplitter).not.toBeNull();
  const topCenterX = topSplitter!.x + topSplitter!.width / 2;
  const bottomCenterX = bottomSplitter!.x + bottomSplitter!.width / 2;
  const bottomCenterY = bottomSplitter!.y + bottomSplitter!.height / 2;

  await page.mouse.move(bottomCenterX, bottomCenterY);
  await page.mouse.down();
  await page.keyboard.down("Alt");
  await page.mouse.move(topCenterX + 5, bottomCenterY, { steps: 6 });
  await expect(page.locator('[data-testid="layout-splitter-snap-vertical"]')).toHaveCount(0);
  await page.mouse.move(bottomCenterX, bottomCenterY, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up("Alt");

  const resetBottomSplitter = await verticalSplitters.nth(1).boundingBox();
  expect(resetBottomSplitter).not.toBeNull();
  const resetBottomCenterX = resetBottomSplitter!.x + resetBottomSplitter!.width / 2;
  const resetBottomCenterY = resetBottomSplitter!.y + resetBottomSplitter!.height / 2;
  await page.mouse.move(resetBottomCenterX, resetBottomCenterY);
  await page.mouse.down();
  await page.mouse.move(topCenterX + 5, resetBottomCenterY, { steps: 6 });
  await expect(page.locator('[data-testid="layout-splitter-snap-vertical"]').first()).toBeVisible();
  await page.mouse.up();

  await expect(async () => {
    const alignedTop = await verticalSplitters.nth(0).boundingBox();
    const alignedBottom = await verticalSplitters.nth(1).boundingBox();
    expect(alignedTop).not.toBeNull();
    expect(alignedBottom).not.toBeNull();
    expect(Math.abs(alignedTop!.x - alignedBottom!.x)).toBeLessThanOrEqual(1);
  }).toPass();

  await app.close();
});

test("drags a splitter edge and persists the updated ratio", async () => {
  const dataDir = makeDataDir();
  let app = await launchApp(dataDir);
  let page = await firstWindow(app);
  await page.getByTestId("workspace-tab-atlas").click();
  const beforeBox = await page.getByTestId("layout-leaf-atlas-terminal").boundingBox();
  const splitter = page.locator('[data-testid="layout-splitter-vertical"]').first();
  const splitterBox = await splitter.boundingBox();
  expect(beforeBox).not.toBeNull();
  expect(splitterBox).not.toBeNull();

  await page.mouse.move(splitterBox!.x + splitterBox!.width / 2, splitterBox!.y + splitterBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(splitterBox!.x + splitterBox!.width / 2 + 48, splitterBox!.y + splitterBox!.height / 2, { steps: 8 });
  await page.mouse.up();

  await expect(async () => {
    const afterBox = await page.getByTestId("layout-leaf-atlas-terminal").boundingBox();
    expect(afterBox).not.toBeNull();
    expect(afterBox!.width).toBeGreaterThan(beforeBox!.width);
  }).toPass();
  const afterBox = await page.getByTestId("layout-leaf-atlas-terminal").boundingBox();
  expect(afterBox).not.toBeNull();
  expect(afterBox!.width).toBeGreaterThan(beforeBox!.width);
  await app.close();

  app = await launchApp(dataDir);
  page = await firstWindow(app);
  await page.getByTestId("workspace-tab-atlas").click();
  const restartedBox = await page.getByTestId("layout-leaf-atlas-terminal").boundingBox();
  expect(restartedBox).not.toBeNull();
  expect(restartedBox!.width).toBeGreaterThan(beforeBox!.width);

  await app.close();
});

test("drags a splitter junction on both axes", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);
  await page.getByTestId("workspace-tab-atlas").click();
  const beforeRoot = await layoutRatio(page, "atlas", "atlas-layout-root");
  const beforeLeft = await layoutRatio(page, "atlas", "atlas-layout-left");
  const junction = page.locator('[data-testid="layout-splitter-junction"]').first();
  const junctionBox = await junction.boundingBox();
  expect(beforeRoot).not.toBeNull();
  expect(beforeLeft).not.toBeNull();
  expect(junctionBox).not.toBeNull();

  await page.mouse.move(junctionBox!.x + junctionBox!.width / 2, junctionBox!.y + junctionBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(junctionBox!.x + junctionBox!.width / 2 + 36, junctionBox!.y + junctionBox!.height / 2 + 36, { steps: 8 });
  await page.mouse.up();

  await expect(async () => {
    const afterRoot = await layoutRatio(page, "atlas", "atlas-layout-root");
    const afterLeft = await layoutRatio(page, "atlas", "atlas-layout-left");
    expect(afterRoot).not.toBeNull();
    expect(afterLeft).not.toBeNull();
    expect(afterRoot!).toBeGreaterThan(beforeRoot!);
    expect(afterLeft!).toBeGreaterThan(beforeLeft!);
  }).toPass();

  await app.close();
});

test("clamps splitter resize at the minimum applet size", async () => {
  const app = await launchApp();
  const page = await firstWindow(app);
  await page.getByTestId("workspace-tab-atlas").click();
  const splitter = page.locator('[data-testid="layout-splitter-vertical"]').first();
  const splitterBox = await splitter.boundingBox();
  expect(splitterBox).not.toBeNull();

  await page.mouse.move(splitterBox!.x + splitterBox!.width / 2, splitterBox!.y + splitterBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(splitterBox!.x - 1000, splitterBox!.y + splitterBox!.height / 2, { steps: 12 });
  await page.mouse.up();

  const terminalBox = await page.getByTestId("layout-leaf-atlas-terminal").boundingBox();
  const fileBox = await page.getByTestId("layout-leaf-atlas-file-viewer").boundingBox();
  expect(terminalBox).not.toBeNull();
  expect(fileBox).not.toBeNull();
  expect(terminalBox!.width).toBeGreaterThanOrEqual(49);
  expect(fileBox!.width).toBeGreaterThanOrEqual(49);

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
