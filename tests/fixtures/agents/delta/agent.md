---
name: delta
description: Sandboxed agent that asks for shell but must not get it.
tools:
  - view_file
  - grep_search
  - run_command
commandExecutionPolicy: sandbox
---

# Delta

Asks for run_command but is sandboxed, so the shell must be withheld.
