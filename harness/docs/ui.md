# Harness UI

Two renderers, one run. The TUI is for a human at a terminal; the plaintext
renderer is for a log file, a CI job, or a machine without bun. Both are fed the
same `RunEnvironment` (`harness/ui/environment.ts`), so a run cannot describe
itself one way on screen and another way in a file.

```
harness/
  theme.ts              palette + ANSI painter (NO_COLOR / FORCE_COLOR aware)
  format.ts             pure text helpers: clipping, counts, durations, arg summaries
  render.ts             the plaintext renderer
  ui/
    environment.ts      the run's identity, resolved once
    transcript.ts       the run as data (blocks, outcomes, timing)
    blocks.ts           transcript blocks -> OpenTUI renderables
  tui.ts                the interactive view: layout, keys, event loop
```

## Running it

```bash
npm link                              # once, so `mhh` exists on PATH
mhh                                   # the interface comes up and waits for a task
mhh "fix the failing test"            # run that task, then exit
mhh --tui                             # force the interface (same as a bare `mhh` in a terminal)
mh --version                          # the main CLI
```

`mhh` and `mh` are aliases for the harness and the main CLI. They only exist
after `npm link` (or `npm i -g .`) — adding an entry to `package.json`'s `bin`
does not regenerate shims for an existing link, so re-run `npm link` after
changing it.

### The hand-over to bun

The TUI needs `@opentui/core`, which loads a native library through bun's FFI.
The installed command is a node shim, so `cli.ts` spawns the same entry point
under bun when the TUI is wanted:

```
mhh               → stdout is a TTY  → re-exec under bun → the interface
mhh "task"        → stdout is a TTY  → re-exec under bun → runs, then exits
mhh               → stdout is a pipe → usage, exit 1
mhh "task"        → stdout is a pipe → plaintext, no re-exec
mhh --tui         → re-exec under bun, or a clear error if bun is absent
mhh --plain "t"   → plaintext, never re-execs
```

`HARNESS_NO_REEXEC=1` is the loop guard, and `HARNESS_BUN` points at a bun that
PATH does not reach. `--tui` requires a real terminal: a renderer handed a pipe
has nowhere to draw and nothing to read keys from, so it refuses in a second
rather than waiting for a human who is not there.

### Session mode

With no task given, the interface is the prompt. You type the task into it:

```
 ›  describe the task, then press enter
 › Waiting for a task  type it above and press enter  · esc returns to the transcript
```

A `Task:` line never appears: borrowing readline would draw a plain prompt over
the terminal, take a line, and only then hand over to a full-screen renderer.

After a run the session stays open, and the next task **continues** the
conversation — the run's own message history seeds the next one, exactly as
`--resume` seeds a saved session.

| Key | In the task input | In the transcript |
| --- | --- | --- |
| type / paste | goes into the input | — |
| `Enter` | submit the task | — |
| `Esc` | back to the transcript | — |
| `i` | — | go back to the task input |
| `q` | types `q` | quit |
| `Ctrl+C` | quit | cancel the running task |
| `[` `]` `t` `E` `C` `o` | typed literally | fold and print tool cards |
| `Ctrl+P` `Ctrl+B` `F1` | work in both modes | work in both modes |

The fold and quit shortcuts are deliberately inert while the input has focus —
otherwise `q` would exit mid-word and `t` would fold a card instead of being
typed. That is why `Esc` exists: it hands the keyboard back so the transcript
keys work again.


## The TUI

```
 ▌ MODELHITCH                            harness · playbook feature
                                          deepseek/deepseek-v4-flash
 C:/work/project · session 20260601-… · ask before writes
 task: fix the failing test
 ╭─ Transcript ─────────────────────────╮ ╭─ Session ──────────────╮
 │ ▌ You                                │ │ model    deepseek-v4-… │
 │   fix the failing test               │ │ writes   ask before …  │
 │ ▌ ⏺ Read  tests/app.test.ts    9ms   │ ╰────────────────────────╯
 │   export const x = 1;                │ ╭─ Tools ────────────────╮
 │ ▌ ✖ Edit  src/app.ts         1.2s    │ │ edit   ▇▇▇▇▇▇ 3        │
 │   --- a/src/app.ts                   │ ╰────────────────────────╯
 │   +++ b/src/app.ts                   │ ╭─ Activity ─────────────╮
 │   @@ -1,4 +1,5 @@                    │ │ 0:04 read ok · 9ms     │
 ╰──────────────────────────────────────╯ ╰────────────────────────╯
 ⠹ Running  turn 2/8  0:04  1.2k tokens  calling edit
 session 2026-… · 2 tools · +12 -3
 ? help  ^P commands  ↑↓ scroll  u undo  y copy  ^O output  q quit
```

### Keys

| Key | Action |
| --- | --- |
| `↑` `↓` / `k` `j` | scroll one line (pauses follow) |
| `PgUp` `PgDn` | scroll one screen |
| `Home` / `End` | jump to the start / resume following |
| `Tab` | scroll back to the newest output |
| `[` `]` | move the card cursor between tool cards |
| `t` | fold or unfold the focused card |
| `Shift+E` / `Shift+C` | unfold / fold every card |
| `o` | print the focused card's whole body to stdout |
| `u` | undo the file changes this run made |
| `y` | copy the transcript (OSC 52) |
| `Ctrl+S` | save the transcript as markdown |
| `Ctrl+O` | force every tool body open |
| `Ctrl+R` | show or hide streamed reasoning |
| `Ctrl+B` | show or hide the sidebar |
| `Ctrl+P` or `:` | command palette |
| `?` / `F1` | keyboard help |
| `y` / `n` | approve / decline a pending change |
| `q` `Esc` `Ctrl+C` | quit (a pending approval is declined on the way out) |

The fold keys are all unmodified letters and brackets, and they are inert while
an approval is pending — the modal owns the keyboard until it is answered, so a
stray `c` cannot fold the transcript behind a prompt nobody can dismiss.

The sidebar hides below 104 columns and the ASCII wordmark below 96, so a split
pane stays usable instead of wrapping into noise.

### Folded cards

A tool call is one line by default when it succeeded, and its whole body when it
failed:

```
▌ ✔ Bash  npm test  ok  ·  4.2s          ← folded: header, preview, duration
▌ ✖ Bash  npm test  error  ·  900ms      ← opened: the reason is the point
▌   Exit 1: Command failed
▌   1 failing
```

Forty successful reads are then forty lines instead of forty screens, while the
one thing that broke gets the space. A diff folds to its `+n -n` stat and its
line count rather than a first-line preview, because `--- a/path` says nothing
the badge does not.

**Bodies are capped.** Each card keeps at most `TOOL_VIEW_CAP_BYTES` (256 KB) of
output and marks the rest `[view truncated: n bytes omitted]`. The untruncated
body still reaches the model, and `--tool-log` still writes it in full — the cap
is only about what stays in memory on screen.

## The plaintext renderer

- Assistant text is written verbatim, undecorated. It is the model's output.
- Tool calls become the same cards, drawn with a `▌` stripe, folded by the same
  rule. `--verbose` unfolds everything.
- `--tool-log <path>` appends every untruncated body to a file, and the closing
  summary names it. The console is a summary; the file is the record.
- **Nothing is rewritten.** No `\r`, no re-drawn status meter: the output is
  usually being redirected into a file.
- Colour is decided once from `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb` and
  `isTTY`, so `NO_COLOR=1 harness … > run.log` produces a file with no escape
  codes at all.
- Diagnostics (`session saved`, warnings) go to **stderr**, so a redirected
  transcript stays clean.

### What the transcript shows

Each block is a stripe plus content, and the stripe is the status:

| Stripe | Meaning |
| --- | --- |
| accent | the task |
| info | the model's answer |
| tool-colored | a tool call: `info` read-only, `accent` write, `warn` shell, `agent` delegation |
| green / red / amber | the outcome: ok, failed, declined or cancelled |

**The answer is rendered by `harness/ui/markdown-text.ts`, not by
`MarkdownRenderable`.** That renderable paints nothing in this environment:
every variant of it — default, `top-level`, with and without concealment, with
content at construction and set afterwards — lays out (it reports the right width
and height) and parses (one block, one child) and then draws an empty frame. Its
child is a `CodeRenderable` that renders its content happily on its own, so the
failure is in the composition and not something the harness can patch.

The consequence was not cosmetic: the answer *is* a markdown block, so the single
most important thing in a transcript was invisible. A run showed its tool cards
and its notices and no prose at all. `markdown-text.ts` styles the same
constructs into `TextChunk`s for a `TextRenderable` — the one primitive that
renders everywhere here — covering headings, bullets, ordered lists, blockquotes,
rules, fenced code, `**bold**`, `*italic*` and `` `inline code` ``.

It is line-oriented rather than a real parser, which is the right trade: it is
streaming-safe (a half-received line styles correctly), it cannot fail, and it
has no dependency that can be missing. Two things it deliberately does *not* do:
`_` is not an emphasis marker (treating it as markup ate the underscores out of
`snake_case_name`), and a fence body is never parsed as prose.


A tool result renders as a card with its argument summary, outcome badge, diff
stat and duration on the header line. Unified diffs go through OpenTUI's
`DiffRenderable` (per-line backgrounds, line numbers). Long results are
head/tail clipped rather than truncated, so the end of a command's output — the
part that usually matters — survives. `Ctrl+O` expands them.

Failures are classified by the strings the tools actually produce:
`Error: …` is a failure, `Exit <n>: …` is a failing shell command, a
`timed out`/`interrupted` message is a cancellation, and `Declined by user` is a
declined write. Everything else is a success.

## The plaintext renderer

- Assistant text is written verbatim, undecorated. It is the model's output.
- Tool calls become the same cards, drawn with a `▌` stripe.
- **Nothing is rewritten.** No `\r`, no re-drawn status meter: the output is
  usually being redirected into a file.
- Colour is decided once from `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb` and
  `isTTY`, so `NO_COLOR=1 harness … > run.log` produces a file with no escape
  codes at all.
- Diagnostics (`session saved`, warnings) go to **stderr**, so a redirected
  transcript stays clean.

## Approvals

The gate is unchanged in behaviour and much clearer in presentation:

- **TUI**: a modal card at the bottom, with the diff or the exact command above
  it. `y` approves, `n`/`Esc` declines, and quitting declines. A prompt is
  always answered, so no run can be left waiting on a question nobody can see.
- **Plaintext**: an approval card, then `proceed? [y/N]`. A non-TTY stdin
  declines immediately and says to re-run with `--yes`, rather than hanging.

### Risk labels

`--risk` sends the tool name, its arguments, and the truncated preview to the
same model the run is using, and asks for one word and one sentence. Both
renderers print the label above the change.

```
── Approve Bash? ──────────────────────────────────────────────────
▌  risk: dangerous  recursive delete of a tracked directory
▌  $ rm -rf src/generated
```

Three rules make this advice rather than a gate:

- **Absent means unchanged.** No classifier, a timeout, a thrown client error,
  or output that is not the requested JSON all degrade to `caution` with the
  reason `unclassified` — never to `safe`. The feature cannot make a run more
  permissive than it was without it.
- **A late verdict is not a verdict.** The classification is raced against its
  own budget, so a client that resolves *after* being aborted cannot hand back a
  late `safe` that then skips a prompt.
- **`--auto-approve-safe` only ever skips `safe`.** `caution` and `dangerous`
  always prompt, including for `run_command`, and every skip is written to the
  transcript and counted in the summary under `auto-approved`.

## Adversarial review

`--review` registers a bundled, read-only `Reviewer` agent and, after a run that
recorded changes, asks it to critique them: correctness, unhandled cases, and
anything the task asked for that the change does not do. The critique goes to
**stderr** and is never applied automatically.

The definition is parsed through the same frontmatter parser and tool mapper
every other agent goes through, and the grant is *derived* and then checked: if
the derived tier contains any mutating tool, the agent is refused with a warning
instead of registered. A reviewer that could write would be a second editor
nobody approved. A failed review is one line and never changes the run's exit
code.

## Undo

`u` (TUI) and `--undo [run-id]` (CLI) both report what they touched, grouped:
restored paths, removed paths, what could not be undone, and what the snapshot
could not cover (a `bash` call can change paths the harness never saw, and the
report says so instead of implying full coverage).

## Saved runs

```
mhh sessions                 # one line per run: id, model, turns, task
mhh sessions show <id>       # the record, plus its tool-call histogram
mhh sessions rm <id>         # delete, with a prompt; --yes to skip
mhh sessions --json          # machine-readable list
```

Deleting a session removes the transcript and nothing else. A run's snapshot
lives outside the sessions directory on purpose, so forgetting a transcript never
destroys the ability to roll back the change the transcript described —
`--undo <run-id>` still works after `sessions rm <id>`.

## Approvals that remember

The gate accepts four answers:

| Answer | Meaning |
| --- | --- |
| `y` | approve this call once |
| `a` | approve every call matching this tool and target, for this session |
| `p` | the same, persisted for this workspace |
| `n` | decline |

A rule matches an **exact** tool + target — the command string for `bash`, the
file path for a write — and never a prefix. Widening a rule from "this command"
to "any command starting like it" is a decision the user has not been shown, and
an unshown widening is how a remembered approval becomes an unapproved one.

Three things a rule never does:

- override a decline, or apply at all on the non-TTY path, which declines because
  nobody could answer rather than because the answer was no;
- apply to a call the risk classifier has since called `caution` or `dangerous` —
  that prompts again and names the rule it overrode;
- get persisted for `bash` without a second confirmation when no classifier is
  configured, because the first answer approved one command and the second
  approves every future command that matches it exactly.

Persisted rules live in `~/.modelhitch/harness/approval-rules.json`, keyed by
workspace. A corrupt file logs one warning and behaves as if there were no rules:
refusing to run because a convenience file is damaged would make the convenience
the most dangerous thing in the tool.

## Context compaction

`--compact` (or `--compact-threshold <n>`, `--no-compact`) replaces the oldest
completed turns with a digest once the history passes a character budget. It is
off by default: compaction rewrites the run's own history, and a run that
silently replaced its transcript would be a surprise.

Three rules are structural, and each exists because breaking it produces a
request the provider *rejects* rather than one that is merely worse:

- the **system message** is never touched — a digest of instructions is not
  instructions;
- the **task** (the first user message) is never touched — a digest of the task
  is a paraphrase of the thing everything else is measured against;
- an assistant message carrying **tool calls** moves with the `tool` results that
  answer them, or not at all. An orphaned result or an unanswered call is
  malformed.

It also refuses when there is nothing to gain: with no completed turn to drop, or
when the digest would save less than `MIN_COMPACTION_GAIN` (10%), the history is
left alone. A compaction that saves 12 characters costs a model call and a
rewrite and buys neither — observed in a live run before the guard existed.

Every compaction is announced on stderr (`[harness] compacted 6 turns into 1`),
and a saved run that compacted says so, because the session then holds the digest
rather than the original transcript.

## Machine-readable runs

`--json-events` turns stdout into NDJSON, one record per line, and moves the
human-readable transcript to stderr. `--json` stays scoped to `doctor`.

```
{"type":"run-start","schema":1,"task":"…","model":"…","sessionId":"…"}
{"type":"text","turn":1,"text":"I'll read the file."}
{"type":"tool","turn":1,"name":"read","args":{…},"outcome":"ok","durationMs":5,"truncated":false,"bytes":412}
{"type":"tool","turn":2,"name":"subagent","args":{…},"outcome":"error","durationMs":4,"truncated":false,"bytes":88,"output":"Error: unknown subagent \"scout\". Available: …"}
{"type":"approval","tool":"edit","decision":"approved","risk":"caution"}
{"type":"turn","turn":1,"tokens":4728,"totalTokens":4728}
{"type":"done","turns":2,"tokens":9605,"tools":2,"durationMs":2600}
```

Tool bodies are multi-line by nature, and a raw newline would split one record
across two lines that both fail to parse — which is why the body goes through
JSON rather than being interpolated. `truncated` is set when the body is not the
raw output: a summarized result, or a capped match list. `--tui --json-events`
fails loudly rather than emitting nothing.

`output` carries the tool's own text, and only when the outcome is `error`,
`timeout`, or `truncated`. A successful call's output is the work itself and is
already in the session, so copying it here would put every file a run touched
onto stdout; a failed call's output is the one thing no other record holds, and
without it a consumer can only report that something broke in 4ms. It is capped
at `TOOL_EVENT_OUTPUT_CHARS`, with the cut stated in the text itself.

## Repeated reads

A per-run cache serves a repeat read of an **unchanged** file as
`src/app.ts unchanged since turn 2 (412 bytes)` instead of the body again. It
keys on the resolved real path (so two symlinks collapse), revalidates size and
mtime on every read, and is invalidated wholesale by any mutating call — a file
changed by `bash` is never served stale. It is in memory only, scoped to one run,
and never written to the session or snapshot directory.

## Testing

```bash
npm test          # vitest: format.ts, render.ts, and the rest of the suite
npm run test:tui  # bun: drives the real renderer and asserts on painted frames
bun run scripts/preview-tui.ts   # render a full frame to text, to eyeball a change
```

`tests/harness-tui-frame.test.ts` is a bun test because OpenTUI's renderer needs
bun's native FFI. It builds the real view on a test renderer, feeds it a
scripted event stream, and asserts on `captureCharFrame()` output — which is the
only way to catch a renderable handed a bad option, since that fails at runtime
rather than at the type level. It is excluded from vitest via `vitest.config.ts`.

Two bugs that test found, and which are worth not reintroducing:

- **A failing shell command rendered as success.** `bash` reports a non-zero
  exit as `Exit <code>: …`, not `Error: …`, because it is a result the model
  should read. A classifier that only looked for `Error:` coloured it green.
- **A clipped diff rendered as `Error parsing diff`.** A hunk header declares
  its own line counts, so cutting a diff mid-hunk produces invalid input;
  `DiffRenderable` shows a parse error instead of the change. `diffWindow` cuts
  between hunks and reports how many were kept.

