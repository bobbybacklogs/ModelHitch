/**
 * Lane-rotation detection: which configured lanes' model ids have vanished
 * from their provider's live model list.
 *
 * Providers rotate model ids constantly — version bumps are the common shape
 * (`deepseek-v4-flash` → `deepseek-v4.2-flash`), and a bridge configured with
 * the old id keeps failing on that lane with opaque upstream 404s while the
 * fix is one settings edit. This module compares what the user configured
 * against what the provider actually serves today and names the difference.
 *
 * Pure data + pure functions (no `node:*`, no HTTP, no provider SDK) so the
 * server route and the tests compute the same answer. The fetch itself stays
 * in the server: a transport failure there means "unknown, skip", not
 * "rotated" — an offline provider must not be flagged as misconfigured.
 */

/** One lane as configured on the bridge: the real route, provider + model. */
export interface ConfiguredLane {
  providerId: string;
  model: string;
}

/** A configured lane whose model id no longer exists at its provider. */
export interface RotatedLane {
  providerId: string;
  model: string;
  /** The ids the provider serves today (basis for `suggestion`). */
  available: string[];
  /** Best same-family replacement, or omitted when no candidate is close. */
  suggestion?: string;
}

/**
 * Find configured lanes whose model id is missing from their provider's list.
 *
 * A lane only counts as rotated when its provider is *known* in
 * `modelIdsByProvider` — an absent entry means the list could not be fetched,
 * which is a transport condition, not evidence of rotation, so those lanes are
 * skipped. Lanes are deduped (`providerId/model`): one configuration, one row.
 */
export function detectRotatedLanes(
  lanes: readonly ConfiguredLane[],
  modelIdsByProvider: ReadonlyMap<string, string[]>,
): RotatedLane[] {
  const out: RotatedLane[] = [];
  const seen = new Set<string>();
  for (const lane of lanes) {
    if (!lane || typeof lane !== 'object') continue;
    if (typeof lane.providerId !== 'string' || !lane.providerId) continue;
    if (typeof lane.model !== 'string' || !lane.model) continue;
    const key = `${lane.providerId}/${lane.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const available = modelIdsByProvider.get(lane.providerId);
    if (!available) continue; // unknown provider or failed fetch — cannot claim rotation
    if (available.includes(lane.model)) continue;
    const suggestion = suggestReplacement(lane.model, available);
    out.push({
      providerId: lane.providerId,
      model: lane.model,
      available: [...available],
      ...(suggestion !== undefined ? { suggestion } : {}),
    });
  }
  return out;
}

/**
 * The best same-family replacement for a rotated model id, or undefined.
 *
 * Version bumps are the common rotation shape — `mimo-v2.5-free` →
 * `mimo-v2.6-free` — so "overlaps on the model family's leading tokens" is the
 * right heuristic, and it stays honest by refusing to guess across families.
 * Candidates must share the model's *first* token (`mimo-*`), are scored by the
 * longest common token prefix, and ties break by shorter id then alphabetical
 * — the safest replacement is the most specific shared history, then the
 * leanest id. The input is never returned, and no shared token means no
 * suggestion at all (`foo-bar` does not become `baz-qux` on a hunch).
 */
export function suggestReplacement(model: string, available: readonly string[]): string | undefined {
  const tokens = tokenize(model);
  const first = tokens[0];
  if (first === undefined) return undefined;
  let best: { id: string; score: number } | undefined;
  for (const candidate of available) {
    if (candidate === model) continue; // the input never suggests itself
    const candidateTokens = tokenize(candidate);
    if (candidateTokens[0] !== first) continue; // different family — not a bump
    const score = commonPrefixLength(tokens, candidateTokens);
    if (best === undefined || score > best.score) {
      best = { id: candidate, score };
      continue;
    }
    if (
      score === best.score &&
      (candidate.length < best.id.length ||
        (candidate.length === best.id.length && candidate < best.id))
    ) {
      best = { id: candidate, score };
    }
  }
  return best?.id;
}

/** Lowercase and split on the id's separators (`foo-v2.5_free`, spaces too). */
function tokenize(model: string): string[] {
  return model.toLowerCase().split(/[-_. ]+/).filter(Boolean);
}

/** How many leading tokens both ids share before they diverge. */
function commonPrefixLength(a: readonly string[], b: readonly string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}
