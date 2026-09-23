/** Maps bridge session ids to durable Cursor Cloud Agent ids (`bc-…`). */
export class CursorCloudSessionStore {
  private readonly agents = new Map<string, string>();

  get(sessionId: string): string | undefined {
    return this.agents.get(sessionId);
  }

  set(sessionId: string, agentId: string): void {
    this.agents.set(sessionId, agentId);
  }

  delete(sessionId: string): void {
    this.agents.delete(sessionId);
  }

  clear(): void {
    this.agents.clear();
  }
}
