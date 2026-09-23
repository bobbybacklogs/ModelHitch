import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { WorkspaceStore } from '../src/workspace/store.js';
import type { ChatSession } from '../src/workspace/types.js';

const dir = mkdtempSync(join(tmpdir(), 'mh-store-probe-'));
const store = new WorkspaceStore(dir);
const now = new Date().toISOString();
const session: ChatSession = {
  id: 'probe-sess',
  title: 'probe',
  target: { kind: 'rotation' },
  messages: [],
  updatedAt: now,
};

const start = performance.now();
store.saveSession(session);
const read = store.readSession(session.id);
const ms = performance.now() - start;
rmSync(dir, { recursive: true, force: true });

if (!read || read.id !== session.id) {
  console.error('save+read did not return the same session id');
  process.exit(1);
}

console.log(ms.toFixed(3));
if (ms >= 50) process.exit(1);
