# UNIT-0 Scope

UNIT-0 is a workspace-based agentic development environment. A workspace is the top-level unit for project context, saved layout, applet state, runtime configuration, and agent activity.

## Core Stack

- Frontend: React, TypeScript, Vite
- Desktop shell: Electron first
- Backend/runtime: Node.js first, with clean service boundaries so runtime pieces can move to Rust later
- Storage: SQLite for workspaces, layouts, applet sessions, chat history, and runtime metadata

## Core Model

The central abstraction is an applet session. Workspaces contain visible applet instances, while applet sessions hold the underlying state and runtime.

This allows applets to be:

- Local to one workspace
- Shared across multiple workspaces
- Reused with different state in different layouts

## Initial Applets

- Terminal: shell sessions rendered through a web terminal surface.
- File viewer: file tree on the left with syntax-highlighted file viewing/editing on the right.
- Browser: browser sessions suitable for local development 
- Chat app: agent/chat surface supporting local model hosting, Ollama or remote model providers, and Codex CLI/app-server wrapping.
- Sandbox: future interactive sandbox session with isolated input and controlled app/process execution. Exact scope is TBD.

## Product Direction

UNIT-0 should behave like a programmable IDE dashboard rather than a fixed editor. The layout system should make terminals, files, browser views, chat sessions, and future sandbox sessions composable inside each workspace.

Shared applets are a first-class concept. For example, one chat session can be mounted in multiple workspaces while preserving separate workspace context where needed.
