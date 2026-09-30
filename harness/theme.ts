/**
 * The one palette, and the one way to colour plaintext output.
 *
 * The TUI and the plaintext CLI previously carried the same hex values in two
 * files, which is how a rebrand ends up half-applied. The TUI reads `PALETTE`
 * directly; the CLI goes through `paint()` so a run that is piped into a file
 * gets no escape codes at all.
 */

export const PALETTE = {
  /** App background. */
  bg: '#0d1117',
  /** Raised surfaces: cards, panels, scroll bodies. */
  panel: '#161b22',
  /** Panel headers and selected rows. */
  panelAlt: '#1c2128',
  /** Hairline borders. */
  border: '#30363d',
  /** Border of the focused or highlighted surface. */
  borderFocus: '#d4a72c',
  /** Primary text. */
  text: '#e6edf3',
  /** Secondary text: labels, metadata, key hints. */
  muted: '#8b949e',
  /** Tertiary text: timestamps, counts, gutters. */
  faint: '#6e7681',
  /** Brand accent, and "this needs you" states. */
  accent: '#d4a72c',
  /** Assistant prose and calls to action. */
  info: '#58a6ff',
  /** Success. */
  ok: '#3fb950',
  /** Warnings, model self-corrections, tool errors. */
  warn: '#d29922',
  /** Hard failures: thrown errors, declines. */
  error: '#f85149',
  /** Delegated work (subagents, agentic CLIs). */
  agent: '#bc8cff',
  /** Diff additions. */
  added: '#3fb950',
  /** Diff removals. */
  removed: '#f85149',
} as const;

export type PaletteKey = keyof typeof PALETTE;

/** Raw ANSI SGR codes, used only by the plaintext renderer. */
const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  italic: '\u001b[3m',
  underline: '\u001b[4m',
  strikethrough: '\u001b[9m',
} as const;

const hexToRgb = (hex: string): [number, number, number] => {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.replace(/./g, (char) => `${char}${char}`) : value;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
};

export interface ColorCapability {
  /** False when the sink cannot take colour; every method then returns its input. */
  readonly enabled: boolean;
  /** Wrap `text` in `hex`. The only method that takes a colour. */
  color(hex: string, text: string): string;
  bold(text: string): string;
  dim(text: string): string;
  italic(text: string): string;
  underline(text: string): string;
}

const plain: ColorCapability = {
  enabled: false,
  color: (_hex: string, text: string) => text,
  bold: (text: string) => text,
  dim: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
};

const ansi: ColorCapability = {
  enabled: true,
  color: (hex: string, text: string) => {
    const [r, g, b] = hexToRgb(hex);
    return `\u001b[38;2;${r};${g};${b}m${text}${ANSI.reset}`;
  },
  bold: (text: string) => `${ANSI.bold}${text}${ANSI.reset}`,
  dim: (text: string) => `${ANSI.dim}${text}${ANSI.reset}`,
  italic: (text: string) => `${ANSI.italic}${text}${ANSI.reset}`,
  underline: (text: string) => `${ANSI.underline}${text}${ANSI.reset}`,
};

/**
 * Coloring for plaintext runs.
 *
 * Two environmental signals matter and they disagree often: a run whose stdout
 * is redirected should stay clean, while a run inside CI wants colour even
 * though it is not a TTY. `NO_COLOR` and `FORCE_COLOR` are the standard answer
 * to both, so honour them before guessing.
 */
export function colorCapability(options: { stream?: { isTTY?: boolean | undefined }; env?: NodeJS.ProcessEnv } = {}): ColorCapability {
  const env = options.env ?? process.env;
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return plain;
  const force = env['FORCE_COLOR'];
  if (force !== undefined && force !== '' && force !== '0') return ansi;
  if (env['TERM'] === 'dumb') return plain;
  const stream = options.stream ?? process.stdout;
  return stream.isTTY === true ? ansi : plain;
}

const RESET = ANSI.reset;
const SGR = /\u001b\[[0-9;]*m/g;

/** Strip SGR sequences, for measuring and for writing to a non-color sink. */
export function stripAnsi(text: string): string {
  return text.replace(SGR, '');
}

export class Painter {
  private readonly caps: ColorCapability;
  private open = false;

  constructor(capability: ColorCapability) {
    this.caps = capability;
  }

  get enabled(): boolean {
    return this.caps.enabled;
  }

  /** Wrap text in a palette color, remembering that a reset is owed. */
  color(key: PaletteKey | string, text: string): string {
    if (!this.caps.enabled || text === '') return text;
    const hex = key in PALETTE ? PALETTE[key as PaletteKey] : key;
    this.open = true;
    return this.caps.color(hex, text);
  }

  bold(text: string): string {
    return this.caps.enabled && text !== '' ? this.caps.bold(text) : text;
  }

  dim(text: string): string {
    return this.caps.enabled && text !== '' ? this.caps.dim(text) : text;
  }

  italic(text: string): string {
    return this.caps.enabled && text !== '' ? this.caps.italic(text) : text;
  }

  /**
   * Close any color left open when text was split across writes (a streamed
   * token, a status line). Cheap to call, and the alternative is a terminal
   * that keeps painting the rest of the session in the last color.
   */
  end(): string {
    if (!this.open) return '';
    this.open = false;
    return ANSI.reset;
  }
}

/** Paint with a throwaway painter, for one-off lines. */
export function paint(key: PaletteKey | string, text: string, capability?: ColorCapability): string {
  return new Painter(capability ?? colorCapability()).color(key, text);
}
