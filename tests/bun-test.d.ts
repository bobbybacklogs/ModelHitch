/**
 * Minimal typings for `bun:test`.
 *
 * The TUI renders through OpenTUI's native FFI, which only bun can load, so
 * `harness-tui-frame.test.ts` has to be a bun test — and `tsc` runs over this
 * directory too. Installing `@types/bun` for one file would pull a second
 * runtime's whole global surface into a Node project's typecheck, so this
 * declares exactly the four functions that file uses.
 *
 * If a bun test ever needs more of the API, add it here rather than reaching
 * for a blanket `any`.
 */
declare module 'bun:test' {
  export interface Matchers {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toContain(expected: string): void;
    toHaveLength(expected: number): void;
    toBeUndefined(): void;
    toBeDefined(): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeGreaterThan(expected: number): void;
    toBeLessThan(expected: number): void;
    toMatch(expected: RegExp | string): void;
    readonly not: Matchers;
  }

  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export function expect(actual: unknown): Matchers;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
}
