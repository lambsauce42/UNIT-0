import { expect, test } from "@playwright/test";
import { extractShellWrappedCommand } from "../src/renderer/timelineDisplay";

test("extracts wrapped shell commands with old chat parity", () => {
  expect(extractShellWrappedCommand('bash -lc "npm test"')).toBe("npm test");
  expect(extractShellWrappedCommand("cmd /k npm test")).toBe("npm test");
  expect(extractShellWrappedCommand("sh -c 'npm run build'")).toBe("npm run build");
  expect(extractShellWrappedCommand('fish -c "npm test"')).toBe("npm test");
  expect(extractShellWrappedCommand("npm test")).toBe("npm test");
});
