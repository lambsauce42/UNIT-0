# Chat Applet KV Cache, Tool Context, and Performance Plan

## Scope

Analyze and improve local built-in chat, Document Analysis, and Open Code with focus on KV cache correctness, tool-call/reasoning context, streaming behavior, and local model performance. Avoid dangerous local-agent tools in validation; use fake llama servers, synthetic tool calls, safe document-search fixtures, and read-only or allowlisted OpenCode tool scenarios.

## Issues Found

### 1. Open Code native GPT-OSS disables llama prompt caching

- Evidence: normal local chat sends `cache_prompt: true` and `id_slot: 0` through `LocalLlamaRuntime.streamChat`; native Open Code proxy calls raw `/completion` with `cache_prompt: false` in `src/main/openCodeRuntime.ts`.
- Why it matters: Open Code repeatedly sends mostly identical prefixes during tool loops and forced final continuations. Disabling cache forces unnecessary full prefill and likely explains the unusual slowness.
- Harnesses affected: Open Code, especially native GPT-OSS. Normal chat and Document Analysis already set `cache_prompt: true`.
- Expected impact: high TTFT and total-latency improvement on repeated Open Code calls; lower prefill time in tool loops and final-continuation passes.
- Proposed fix: set `cache_prompt: true` for native Open Code raw `/completion` calls on the normal local slot (`id_slot: 0`). Do not increase `-np` or total context for Open Code, because doubling KV allocation can make real first turns appear hung on constrained hardware. Mark the managed local slot dirty when the raw Open Code endpoint is handed out so later normal chat/document turns restore or restart instead of assuming their saved slot is still active.
- Risk: medium. The proxy makes multiple sequential calls in one turn; cache reuse must rely on llama prefix reconciliation and must not reuse stale partial state after errors. The raw Open Code path must not break normal chat's explicit save/restore assumptions.
- Test coverage: fake raw completion server captures `cache_prompt` and `id_slot`; local endpoint test asserts Open Code does not increase parallel slots; perf test simulates lower prefill cost when cache is enabled; Open Code streaming tests verify incremental assistant/reasoning deltas are unchanged.

### 2. Local llama slot state can remain dirty after cancellation or failed generation

- Evidence: `restoreSlotIfNeeded` returns early when `server.activeSlotCacheKey === normalizedKey`; slots are only saved after successful completion. If a stream aborts or parser error happens after restore, the active slot can contain partial state, but the next same-key request may skip restore.
- Why it matters: stale partial KV state can cause incorrect behavior if llama does not fully reconcile the prompt from scratch. This is a correctness issue rather than just performance.
- Harnesses affected: normal chat, Document Analysis, and any direct local runtime use. Open Code uses raw completion on the same local slot and is handled by marking the slot dirty, plus closing the local llama runtime after failed or cancelled Open Code turns.
- Expected impact: correctness hardening with small overhead only after failures/cancellations.
- Proposed fix: track dirty active slot state. Mark the active slot dirty when a generation starts after restore. Clear dirty only after a successful slot save. If the next request has the same cache key but the active slot is dirty, force restore from the saved slot instead of returning early. If no saved slot exists, fail loud or clear/restart slot rather than silently reusing partial state.
- Risk: medium. Restart/restore behavior must not break first-turn requests with no prior saved cache.
- Test coverage: fake llama server records slot save/restore after normal completion, aborted stream, and parser failure. Next same-key request must not skip restoration after dirty failure.

### 3. Open Code warmup does not warm the actual generation path

- Evidence: `warmSelectedLocalRuntime` calls `warmChatSession` with an Open Code cache key, but Open Code generation later only calls `openAiEndpoint`, which ensures the server but does not restore/save slot context. Native Open Code also previously disabled `cache_prompt`.
- Why it matters: users can pay startup/prefill cost on the first Open Code turn even after warmup.
- Harnesses affected: Open Code.
- Expected impact: moderate first-token improvement after selecting/warming an Open Code thread.
- Proposed fix: after enabling proxy `cache_prompt`, make Open Code warmup prepare the actual endpoint path without increasing parallel slots. Defer persistent transcript slot-save/restore for Open Code until there is an explicit raw-slot lifecycle API; rely on llama-server prefix caching within the live Open Code endpoint and fail loud by marking dirty/restarting before normal chat or after failed/cancelled Open Code turns.
- Risk: medium. Must not expose slot operations to concurrent calls without the existing slot lock.
- Test coverage: unit test showing Open Code warmup/turn path restores the same key and avoids a cold slot where observable.

### 4. Open Code starts a new OpenCode server every turn

- Evidence: `RealOpenCodeRuntime.runTurn` starts `opencode serve` at the beginning and stops it in `finally`.
- Why it matters: repeated process startup and event-stream setup add fixed overhead independent of model generation.
- Harnesses affected: Open Code.
- Expected impact: moderate total latency improvement on multi-turn Open Code sessions.
- Proposed fix: reuse an OpenCode server and native GPT-OSS provider proxy for compatible turns keyed by cwd, endpoint, raw slot, permission mode, model/settings, native mode, and system prompt. Reset proxy tool/event state per turn, allow only `/v1/models` while idle, close the proxy if OpenCode startup fails, and serialize warm/turn entry to prevent overlapping turns from clobbering the single active proxy state.
- Risk: medium. OpenCode server lifecycle, permissions, and session state need strict cleanup.
- Test coverage: real OpenCode runtime tests assert compatible follow-up turns reuse the same cached server, overlapping turns serialize before the second provider request reaches the fake llama server, and question/tool streaming behavior remains intact.

### 5. Open Code GPT-OSS prompt budget treats `maxTokens == nCtx` as no prompt space

- Evidence: the real `OpenCode Test` preset uses `nCtx: 32768` and `maxTokens: 32768`. The native GPT-OSS prompt budget subtracted the full configured output cap from context before prompt rendering, leaving only a few prompt characters. In the real app, OpenCode retried provider requests and Unit-0 emitted `OpenCode did not emit any turn events before the idle timeout` before the proxy ever called llama `/completion`.
- Why it matters: a normal local model preset can hang on the first message even though the model/server are healthy. This also made earlier E2E coverage misleading because it used small `maxTokens`.
- Harnesses affected: Open Code native GPT-OSS, especially high-output presets.
- Expected impact: correctness fix for first-turn OpenCode hangs; also prevents invisible provider retry loops before model invocation.
- Proposed fix: reserve a small first-response budget plus forced-final continuation budget while rendering the prompt, then clamp `n_predict` to the remaining context at request time. Add real Electron OpenCode coverage that can run with `UNIT0_E2E_OPENCODE_MAX_TOKENS=32768`.
- Risk: low-medium. It changes only the prompt-fit estimate and output cap calculation for OpenCode GPT-OSS; actual llama context still enforces the hard limit.
- Test coverage: real Electron OpenCode greeting test parameterized with high `maxTokens`; unit prompt-render test for maxTokens equal to context; raw completion test asserts a positive `n_predict` and model invocation; large safe webfetch fixture asserts tool output is truncated while both post-tool analysis and final continuation retain positive token budgets.

### 6. Open Code debug logging can distort real-app diagnostics

- Evidence: debug mode wrote the full OpenCode request body, including large tool schemas and system prompts, synchronously on every provider retry.
- Why it matters: the diagnostic path can make a stuck/hung path harder to reason about and creates huge logs.
- Harnesses affected: Open Code debug/test runs.
- Expected impact: more reliable real E2E diagnosis and smaller logs.
- Proposed fix: log compact request summaries and phase timings instead of full request bodies.
- Risk: low. This only affects opt-in debug logging.
- Test coverage: real Electron debug run verifies summary labels include prompt render and raw completion phases.

### 7. Open Code first turn uses only the latest Unit-0 user message

- Evidence: `runOpenCodeGeneration` finds the last user message and passes only `lastUserMessage.content` to OpenCode. Normal chat passes the full active-context message list.
- Why it matters: switching an existing thread into Open Code, or losing an OpenCode session id, can drop prior visible conversation context.
- Harnesses affected: Open Code.
- Expected impact: correctness fix for multi-round conversations and mode switches.
- Proposed fix: not first implementation pass unless tests show a simple safe transcript seeding path. Need to avoid duplicating OpenCode's own session history.
- Risk: medium-high. Naive seeding can duplicate prior OpenCode history.
- Test coverage: ChatService test for an OpenCode first turn with prior messages; expected behavior must be explicit.

### 8. Host tool results are detected by plain text prefix

- Evidence: user messages starting with `Tool result:\n` are rendered as host/developer tool results in GPT-OSS Document Analysis/OpenCode prompt reconstruction.
- Why it matters: user-authored text can be promoted into privileged host context. Real tool results also have no explicit metadata, so correctness depends on a fragile string prefix.
- Harnesses affected: Document Analysis, local GPT-OSS OpenCode prompt rendering, remote GPT-OSS prompt rendering.
- Expected impact: correctness and safety improvement.
- Proposed fix: introduce explicit internal host-tool-result metadata or a synthetic role marker and render host/developer tool results only when that metadata is present. Escape or keep user-authored `Tool result:` as normal user text.
- Risk: high because shared message types, persistence, remote protocol, and existing tests assume plain messages. Defer to a dedicated patch unless a minimal safe marker already exists.
- Test coverage: user message with `Tool result:` remains user content; actual host search/shell result still renders as host context.

### 9. Document Analysis evidence budget is approximate

- Evidence: `documentEvidenceBudget` estimates message tokens and a small wrapper, while actual GPT-OSS prompts add large framework/system/developer text. First tool pass can be sent before any budget check.
- Why it matters: large histories or system prompts can overrun context or reduce answer budget unpredictably.
- Harnesses affected: Document Analysis.
- Expected impact: correctness and reliability improvement for large documents/histories.
- Proposed fix: derive evidence budget from the same rendered prompt/token-estimation path used for the request, preserving a fixed completion budget before adding evidence.
- Risk: medium. Requires exposing or sharing prompt rendering/estimation without adding duplicate prompt implementations.
- Test coverage: long history/system prompt fails loud before llama request; large evidence truncates/limits while leaving completion budget.

### 10. Remote prepared context can replay stale messages if enabled

- Evidence: client context key omits transcript content/count; remote server uses prepared context messages whenever the key matches the model.
- Why it matters: `context_prepare` could reuse an old transcript after new turns, causing wrong model behavior.
- Harnesses affected: remote inference; locally compatible behavior comparison.
- Expected impact: correctness hardening.
- Proposed fix: include transcript/rendered-prompt hash in prepared context keys or make prepare verify current payload compatibility and fail loud on mismatch.
- Risk: medium.
- Test coverage: prepare one transcript, then stream a changed transcript with same coarse key; server must not silently use stale messages.

### 11. Document-analysis remote model warmup skips embedding warmup

- Evidence: warmup returns after remote generation prewarm, before the document embedding warm path.
- Why it matters: first document search pays embedding startup cost even after selecting/warming a remote document-analysis thread.
- Harnesses affected: Document Analysis with remote generation model and local embedding model.
- Expected impact: moderate first-search latency improvement.
- Proposed fix: do not return immediately after remote prewarm; continue to document-analysis embedding warmup when applicable.
- Risk: low.
- Test coverage: ChatService warmup test asserting both remote prewarm and embedding warm are called.

### 12. Open Code warmup starts llama but not OpenCode/proxy

- Evidence: real UI timing after earlier cache fixes showed warmed first turns still paid about 0.8 seconds before raw `/completion` was invoked, even though llama was already running. Debug spans showed this came from OpenCode/proxy startup and session setup.
- Why it matters: selecting an OpenCode thread should not leave the first visible turn paying app/harness startup overhead.
- Harnesses affected: Open Code.
- Expected impact: first-turn app overhead after warmup drops from hundreds of milliseconds to low tens of milliseconds before llama prefill.
- Proposed fix: add `OpenCodeRuntime.warm()` and call it from `ChatService.warmSelectedLocalRuntimeNow` after the local endpoint is prepared. Warmup starts/reuses the compatible OpenCode server/provider proxy but does not create a session, send a prompt, execute tools, or dirty conversation state.
- Risk: medium. Warmup must not leave an active turn state, must respect cancellation, and must not intercept generation requests outside an active turn.
- Test coverage: ChatService test asserts selected local OpenCode threads call `openCodeRuntime.warm`; real UI timing with the actual textarea and OpenCode Test preset verifies server startup happens before submit and the first submit reuses the warmed server.

## Real UI Timing After OpenCode Reuse/Warmup

Measured with a visible Electron app, real textarea submission, `OpenCode Test` preset, `gpt-oss-20b-mxfp4.gguf`, `nCtx=32768`, `maxTokens=128`, and `UNIT0_OPENCODE_DEBUG_LOG`.

- Before persistent OpenCode reuse, warmed follow-up submit-to-first-visible text was about `995 ms`; raw `/completion` to first upstream payload was about `101 ms`, proving most remaining follow-up latency was before llama.
- After persistent OpenCode reuse and OpenCode warmup, first warmed submit reused the OpenCode server. Submit-to-first-visible text was `2564 ms`; debug spans showed raw `/completion` prefill took `2205 ms`, so the remaining first-turn delay is model prefill of a roughly `50k` character OpenCode prompt.
- After the first turn seeded llama prefix cache, follow-up submit-to-first-visible text was `169 ms` and total completion was `253 ms`. Raw `/completion` response headers took `77 ms`; OpenCode event connect was `2 ms`, `prompt_async` was `8 ms`, and prompt rendering was `1 ms`.
- Streaming remained incremental: the real UI recorded empty assistant frames while running, then reasoning appeared before final content on both turns.

## Baseline and Regression Test Design

Add a reusable perf harness with a timed fake llama server. It should record:

- Time to first token.
- First reasoning-token time and first final-token time when distinguishable.
- Tokens per second during generation.
- Total latency.
- Simulated prefill and decode time.
- Prompt character count and estimated prompt tokens.
- `cache_prompt`, `id_slot`, request count, slot save/restore count.
- Harness overhead from runtime event to persisted ChatService state where practical.
- Memory before/after using `process.memoryUsage()` for repeated-run tests.

The fake server must fail loud when a test claims real prefill/decode/cache metrics that were not exposed by the upstream. For before/after comparison, run the same `@perf` tests once before fixes and once after fixes with multiple repeats and compare medians.

Planned test files:

- `tests/perfHarness.ts`: timed fake llama/open-code helpers and JSONL result writer.
- `tests/localLlamaRuntime.perf.spec.ts`: normal chat cache behavior, GPT-OSS prompt/cache behavior, dirty-slot restore, repeated prompt/model invocation count.
- `tests/openCodeRuntime.perf.spec.ts`: native GPT-OSS cache flag, TTFT/total latency under simulated prefill, tool-loop request count, streaming preservation.
- `tests/chatService.perf.spec.ts`: normal multi-turn correctness, Document Analysis safe search-then-answer, Open Code safe mock tool event order, service overhead.
- `scripts/compare-perf-baselines.mjs`: compare `test-results/perf-before.jsonl` and `test-results/perf-after.jsonl`.

Baseline commands after perf tests are added:

```powershell
$env:UNIT0_PERF_LABEL="before"; $env:UNIT0_PERF_OUT="test-results/perf-before.jsonl"; npm test -- --grep "@perf" --repeat-each=5
$env:UNIT0_PERF_LABEL="after";  $env:UNIT0_PERF_OUT="test-results/perf-after.jsonl";  npm test -- --grep "@perf" --repeat-each=5
node scripts/compare-perf-baselines.mjs test-results/perf-before.jsonl test-results/perf-after.jsonl
```

Focused correctness sweep:

```powershell
npm test -- tests/localLlamaRuntime.spec.ts tests/remoteInferenceServer.spec.ts tests/chatService.spec.ts tests/openCodeRuntime.spec.ts
```

## Implementation Order

1. Add perf harness and focused before/after tests for current high-confidence fixes.
2. Run baseline `@perf` tests and record `test-results/perf-before.jsonl`.
3. Fix dirty local slot handling after failed/cancelled generations.
4. Enable native Open Code GPT-OSS proxy `cache_prompt: true` on the normal raw-completion slot.
5. Fix OpenCode GPT-OSS prompt budget/output-cap handling for high `maxTokens` presets.
6. Adjust Open Code endpoint preparation so it starts the real generation path without increasing llama parallel slots or changing token streaming.
7. Fix remote document-analysis warmup so embedding warmup still runs after remote generation prewarm.
8. Run post-change `@perf` tests, focused correctness sweep, and real Electron OpenCode high-`maxTokens` E2E.
9. Compare perf JSONL files and report concrete before/after numbers.
10. Defer higher-risk architectural changes, including persistent OpenCode server reuse and explicit host-tool-result metadata, unless the first-pass tests reveal a small safe implementation path.

## Bugs Discovered During Analysis

- Native Open Code bypasses cache with `cache_prompt: false`.
- Native Open Code prompt budget can reject or hang high-output presets (`maxTokens >= nCtx`) before llama is invoked.
- Local slot state can be stale/partial after cancellation or generation/parser failure.
- Remote document-analysis warmup skips embedding warmup.
- Plain-text `Tool result:\n` prefix is a privileged host-result marker.
- Remote prepared contexts can become stale if `context_prepare` is used with the current coarse key.
