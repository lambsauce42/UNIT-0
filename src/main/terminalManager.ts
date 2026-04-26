import os from "node:os";
import { execFile } from "node:child_process";
import * as pty from "node-pty";
import type {
  TerminalAppletKind,
  TerminalDataPayload,
  TerminalInputPayload,
  TerminalResizePayload,
  TerminalStartPayload,
  TerminalStartResult
} from "../shared/types.js";

type TerminalSession = {
  id: string;
  process: pty.IPty;
  output: string;
  disposed: boolean;
};

const MAX_REPLAY_BUFFER = 200_000;

export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSession>();

  constructor(private readonly publish: (payload: TerminalDataPayload) => void) {}

  start(payload: TerminalStartPayload): TerminalStartResult {
    const existing = this.sessions.get(payload.sessionId);
    if (existing) {
      existing.process.resize(payload.cols, payload.rows);
      return { sessionId: existing.id, output: existing.output };
    }

    const process = this.spawn(payload.kind, payload.cols, payload.rows);
    const session: TerminalSession = {
      id: payload.sessionId,
      process,
      output: "",
      disposed: false
    };
    this.sessions.set(payload.sessionId, session);

    process.onData((data) => {
      if (session.disposed) {
        return;
      }
      session.output = trimReplayBuffer(session.output + data);
      this.publish({ sessionId: session.id, data });
    });
    process.onExit(({ exitCode }) => {
      if (session.disposed) {
        return;
      }
      const data = `\r\n[process exited with code ${exitCode}]\r\n`;
      session.output = trimReplayBuffer(session.output + data);
      this.publish({ sessionId: session.id, data });
      this.sessions.delete(session.id);
    });

    return { sessionId: payload.sessionId, output: "" };
  }

  input(payload: TerminalInputPayload): void {
    const session = this.sessions.get(payload.sessionId);
    if (!session) {
      throw new Error(`Terminal session ${payload.sessionId} is not running`);
    }
    session.process.write(payload.data);
  }

  resize(payload: TerminalResizePayload): void {
    const session = this.sessions.get(payload.sessionId);
    if (!session) {
      return;
    }
    session.process.resize(payload.cols, payload.rows);
  }

  dispose(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.disposed = true;
    this.sessions.delete(sessionId);
    killTerminalProcess(session.process);
  }

  disposeAll(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.dispose(sessionId);
    }
  }

  private spawn(kind: TerminalAppletKind, cols: number, rows: number): pty.IPty {
    const cwd = process.env.UNIT0_WORKSPACE_DIR ?? process.cwd();
    if (kind === "wslTerminal") {
      return pty.spawn("wsl.exe", [], {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: terminalEnv()
      });
    }

    const shell = process.platform === "win32" ? "powershell.exe" : (process.env.SHELL ?? "/bin/sh");
    return pty.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: terminalEnv()
    });
  }
}

function killTerminalProcess(process: pty.IPty): void {
  if (os.platform() !== "win32") {
    process.kill();
    return;
  }
  execFile("taskkill.exe", ["/pid", String(process.pid), "/t", "/f"], (error) => {
    if (error) {
      console.warn(`[unit0:terminal] taskkill failed for terminal pid ${process.pid}: ${error.message}`);
    }
  });
}

function terminalEnv(): Record<string, string> {
  return {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    UNIT0_HOST_PLATFORM: os.platform()
  };
}

function trimReplayBuffer(output: string): string {
  if (output.length <= MAX_REPLAY_BUFFER) {
    return output;
  }
  return output.slice(output.length - MAX_REPLAY_BUFFER);
}
