/**
 * Renders the TUI to text so the layout can be eyeballed without a terminal.
 *
 * Not part of the test suite: `bun run scripts/preview-tui.ts` prints a frame
 * with a diff, a failure, a notice and a pending approval in it.
 */
import { createTestRenderer } from '@opentui/core/testing';
import type { ToolLoopEvent } from '../src/agent.js';
import { createHarnessTui } from '../harness/tui.js';
import { unifiedDiff } from '../harness/diff.js';
import type { RunEnvironment } from '../harness/ui/environment.js';

const ENVIRONMENT: RunEnvironment = {
  provider: 'vercel-ai-gateway',
  model: 'anthropic/claude-sonnet-4',
  target: 'vercel-ai-gateway/anthropic/claude-sonnet-4',
  configPath: '/home/dev/.modelhitch/config.json',
  playbook: 'feature',
  principles: 3,
  workspaceDir: '/home/dev/project',
  workspaceFacts: 'typescript (pnpm), 1.4k source files',
  sessionId: '20260601-143012-4f2a',
  maxTurns: 8,
  toolTimeoutMs: 120_000,
  approvals: 'prompt',
  snapshots: true,
  agents: 'on (bihan; 56 agents from ~/.agents/agents)',
  resumed: false,
};

/**
 * Built with the harness's own differ rather than hand-written: a hand-written
 * hunk header with the wrong line count is invalid unified diff, and the point
 * of this preview is to look at what the real producer emits.
 */
const DIFF = unifiedDiff(
  [
    'import { Router } from "./router";',
    'const app = new Router();',
    'app.use(json());',
    'app.use(cors());',
    'app.get("/health", (req, res) => res.send("ok"));',
    'export { app };',
  ].join('\n'),
  [
    'import { Router } from "./router";',
    'const app = new Router();',
    'app.use(json());',
    'app.use(cors());',
    'app.get("/health", (_req, res) => res.json({ status: "ok" }));',
    'app.get("/version", (_req, res) => res.json({ version: VERSION }));',
    'export { app };',
  ].join('\n'),
  { path: 'src/app.ts' },
);

const setup = await createTestRenderer({ width: 132, height: 38 });

const stream = async function* (): AsyncGenerator<ToolLoopEvent> {
  yield { type: 'chunk', turn: 1, chunk: { type: 'text-delta', text: 'I read the router and the existing test, then ' } };
  yield { type: 'chunk', turn: 1, chunk: { type: 'text-delta', text: 'updated the health route to return JSON.' } };
  yield {
    type: 'tool',
    turn: 1,
    call: { id: 'c1', name: 'read', arguments: { path: 'src/router.ts' } },
    output: 'export class Router {\n  get(path, handler) { /* ... */ }\n}',
  };
  yield {
    type: 'tool',
    turn: 1,
    call: { id: 'c2', name: 'bash', arguments: { command: 'npm test -- health' } },
    output: 'Exit 1: Command failed: npm test -- health\n  ✗ health returns json (12 ms)\n\n1 failing',
  };
  yield {
    type: 'turn',
    turn: 1,
    result: {
      message: { role: 'assistant', content: 'Reading the code.' },
      finishReason: 'tool-calls',
      usage: { totalTokens: 8_420 },
    },
  };
  yield {
    type: 'tool',
    turn: 2,
    call: { id: 'c3', name: 'edit', arguments: { path: 'src/app.ts' } },
    output: DIFF,
  };
  yield {
    type: 'chunk',
    turn: 2,
    chunk: { type: 'text-delta', text: 'The failure was the test asserting on text rather than JSON. Fixed.' },
  };
  yield {
    type: 'turn',
    turn: 2,
    result: {
      message: { role: 'assistant', content: 'Done.' },
      finishReason: 'stop',
      usage: { totalTokens: 11_240 },
    },
  };
  yield { type: 'done', turns: 2, messages: [], usage: { totalTokens: 19_660 }, final: { message: { role: 'assistant', content: 'Done.' }, finishReason: 'stop' } };
};

const app = await createHarnessTui('Fix the failing health test and make the route return JSON.', {}, {
  createRenderer: async () => setup.renderer,
  environment: ENVIRONMENT,
  stream: stream as never,
});

await app.finished;
await setup.flush();
console.log(setup.captureCharFrame());
app.quit(0);
