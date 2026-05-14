import { expect, test } from "@playwright/test";
import { TerminalManager, terminalStartFailureMessage } from "../src/main/terminalManager";

test("reports unavailable WSL terminal without creating a broken terminal session", () => {
  const manager = new TerminalManager(
    () => undefined,
    () => {
      throw new Error("spawn wsl.exe ENOENT");
    }
  );

  const result = manager.start({
    sessionId: "missing-wsl",
    kind: "wslTerminal",
    cols: 80,
    rows: 24
  });

  expect(result.output).toContain("WSL terminal could not start.");
  expect(result.output).toContain("spawn wsl.exe ENOENT");
  expect(() => manager.input({ sessionId: "missing-wsl", data: "pwd\r" })).not.toThrow();
  expect(() => manager.resize({ sessionId: "missing-wsl", cols: 120, rows: 30 })).not.toThrow();
});

test("formats terminal startup failures by terminal kind", () => {
  expect(terminalStartFailureMessage("terminal", new Error("spawn powershell.exe ENOENT"))).toContain("Terminal could not start.");
  expect(terminalStartFailureMessage("wslTerminal", new Error("No installed distributions"))).toContain("WSL terminal could not start.");
});
