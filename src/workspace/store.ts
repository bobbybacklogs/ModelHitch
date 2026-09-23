import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ChatSession, WorkOrder } from './types.js';

export class WorkspaceStore {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  saveSession(session: ChatSession): void {
    this.writeRecord('sessions', session.id, session);
  }

  readSession(id: string): ChatSession | null {
    return this.readRecord<ChatSession>('sessions', id);
  }

  saveWorkOrder(order: WorkOrder): void {
    this.writeRecord('work-orders', order.id, order);
  }

  readWorkOrder(id: string): WorkOrder | null {
    return this.readRecord<WorkOrder>('work-orders', id);
  }

  private recordPath(kind: 'sessions' | 'work-orders', id: string): string {
    return join(this.directory, kind, `${id}.json`);
  }

  private writeRecord(kind: 'sessions' | 'work-orders', id: string, value: unknown): void {
    const dir = join(this.directory, kind);
    mkdirSync(dir, { recursive: true });
    const targetPath = this.recordPath(kind, id);
    const tempPath = join(dir, `.${randomUUID()}.tmp`);
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(tempPath, targetPath);
  }

  private readRecord<T>(kind: 'sessions' | 'work-orders', id: string): T | null {
    const path = this.recordPath(kind, id);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    return JSON.parse(text) as T;
  }
}
