export function unwrapShellTokenQuotes(value: string) {
  const stripped = value.trim();
  if (stripped.length >= 2 && stripped[0] === stripped[stripped.length - 1] && (stripped[0] === "\"" || stripped[0] === "'")) {
    return stripped.slice(1, -1);
  }
  return stripped;
}

export function splitShellToken(text: string): [string, string] {
  const stripped = text.trimStart();
  if (!stripped) {
    return ["", ""];
  }
  const first = stripped[0];
  if (first === "\"" || first === "'") {
    const closingIndex = stripped.indexOf(first, 1);
    if (closingIndex !== -1) {
      return [stripped.slice(0, closingIndex + 1), stripped.slice(closingIndex + 1)];
    }
  }
  const spaceIndex = stripped.search(/\s/u);
  if (spaceIndex === -1) {
    return [stripped, ""];
  }
  return [stripped.slice(0, spaceIndex), stripped.slice(spaceIndex + 1)];
}

function fileBasename(value: string) {
  const normalized = value.replace(/\\/gu, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

export function extractShellWrappedCommand(text: string) {
  const normalized = text.trim();
  if (!normalized) {
    return "";
  }
  const [launcherToken, remainder] = splitShellToken(normalized);
  const launcher = fileBasename(unwrapShellTokenQuotes(launcherToken));
  const flagSets: Record<string, Set<string>> = {
    powershell: new Set(["-command", "-c"]),
    "powershell.exe": new Set(["-command", "-c"]),
    pwsh: new Set(["-command", "-c"]),
    "pwsh.exe": new Set(["-command", "-c"]),
    cmd: new Set(["/c", "/k"]),
    "cmd.exe": new Set(["/c", "/k"]),
    sh: new Set(["-c", "-lc"]),
    bash: new Set(["-c", "-lc"]),
    zsh: new Set(["-c", "-lc"]),
    fish: new Set(["-c"])
  };
  const flags = flagSets[launcher];
  if (!flags) {
    return normalized;
  }
  let current = remainder;
  for (let index = 0; index < 3; index += 1) {
    const [token, tail] = splitShellToken(current);
    if (!token) {
      break;
    }
    if (flags.has(unwrapShellTokenQuotes(token).toLowerCase())) {
      return unwrapShellTokenQuotes(tail).trim() || normalized;
    }
    current = tail;
  }
  return normalized;
}
