import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

  listSessions(): ChatSession[] {
    return this.listRecords<ChatSession>('sessions');
  }

  listWorkOrders(): WorkOrder[] {
    return this.listRecords<WorkOrder>('work-orders');
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

  private listRecords<T extends { updatedAt: string }>(kind: 'sessions' | 'work-orders'): T[] {
    const dir = join(this.directory, kind);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const records: T[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      const record = this.readRecord<T>(kind, name.slice(0, -'.json'.length));
      if (record) records.push(record);
    }
    records.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return records;
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
