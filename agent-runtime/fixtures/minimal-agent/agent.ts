// minimal-agent stub (non-executing).
//
// Phase 1 discovers and validates agent files; it does not run them. This stub
// only exists so discovery can see a typed agent entry point next to
// instructions.md. No runtime behavior is implemented yet.
export const agent = {
  name: 'minimal-agent',
  entry: import.meta.url,
};