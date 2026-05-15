## General 

At the beginning after a new user prompt I need you to consisely and precisely state how you view the user instruction and what open assumptions you are going to take if the user prompt wasnt specific. But only on implementation prompts not on generic ones.

Fallbacks are unacceptable. Do not add alternate visual paths, backup behavior, duplicate implementations, or masking logic to hide a broken primary system. If something requires a fallback, the underlying architecture is wrong: identify and fix the root cause instead. Always fail loud.

There might be work done in parallel, dont randomly remove unrelated changes.

## Subagents

# Testing
When running large tests employ a GPT 5.3 Codex-Spark (extra high) subagent to execute and read the test results and only foward the relevant results (i.e. when all pass it says just that, if a specific error occurs it forwards that). This is done for context management of the main Agent.

# Log scans
For scanning large logs you can also employ one or more GPT 5.3 Codex-Spark (extra high) subagents, here they should also only forward relevant information.