import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { extname, join, resolve } from 'node:path';

import { formatCount } from './format.js';

/**
 * One line of understanding about the folder a run starts in.
 *
 * A model given a task and a workspace otherwise spends its first turn on `ls`
 * and a manifest read to learn the same three facts, and a human reading the
 * header has to work them out from the path. Both readers are served from one
 * detection, so the line the human sees and the section the model reads cannot
 * disagree.
 *
 * The scan is synchronous and capped because it runs before the first token of
 * a run: a slow scan is a slow start. Nothing here is worth failing a run over,
 * so anything that cannot be answered cheaply is reported as `unknown` rather
 * than guessed at.
 *
 * `grep.ts` is the other filesystem module in the harness and this follows its
 * shape: pure exported functions, an injectable `AbortSignal`, size caps, and
 * no dependency beyond `node:`.
 */

/** Directories that hold dependencies or build output rather than this project's source. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  'vendor',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
]);

/**
 * Levels below the root that are walked.
 *
 * Monorepos keep their packages one or two levels down, and the leaves of a
 * deep tree cannot change which language the repository is written in. Files
 * below this horizon go uncounted, which is deliberate: the alternative is a
 * walk whose cost is set by the largest `src/` in the tree.
 */
const MAX_DEPTH = 4;

/**
 * Files visited before the histogram is treated as good enough.
 *
 * The ordering of a histogram is stable long before its total is: another
 * thousand `.ts` files do not displace `python`. The cap is what keeps the
 * worst case bounded when someone points the harness at a home directory.
 *
 * Depth is a horizon rather than a cap, so it does not set `truncated`; this
 * one does, because the counts it produces are a lower bound.
 */
const MAX_FILES = 4000;

/**
 * Wall-clock budget for the whole walk, checked per entry.
 *
 * This runs while a human watches an empty screen, and 150ms is below the point
 * where a terminal feels slow to start. A larger repository still reports its
 * root manifests, which is where the language and the tooling come from; the
 * histogram only fills in what the manifests do not name.
 */
export const WORKSPACE_BUDGET_MS = 150;

/** A manifest is read for a few fields; anything larger is not one. */
const MAX_TEXT_BYTES = 256 * 1024;

/** Bytes sniffed for a null byte before a file is treated as binary. */
const SNIFF_BYTES = 8_000;

/** Manifest names printed before the rest collapse into `+n more`. */
const MAX_LISTED_MANIFESTS = 3;

/**
 * Languages kept in the report. A repository written in more than three
 * languages at once is a monorepo, and the fourth language is not the answer to
 * "what is this folder".
 */
const MAX_LANGUAGES = 3;

/**
 * Score given to a language a root manifest names.
 *
 * Deliberately above anything the histogram can reach: a manifest states intent
 * and a file count is inferred from names, so a manifest language is always
 * first and the histogram only orders what the manifests leave unnamed.
 */
const MANIFEST_WEIGHT = 1_000_000;

/**
 * Extra weight for `tsconfig.json` over `package.json`.
 *
 * A repository with a `tsconfig.json` is written in TypeScript, but it carries
 * a `package.json` too, which alone would name JavaScript. One point is enough
 * to break that tie and is not enough to move anything else.
 */
const TSCONFIG_PROMOTION = 1;

/**
 * Test files count half.
 *
 * In a fixtures directory or a heavily tested library the tests can outnumber
 * the sources, and "the language of this repository" should not be decided by
 * the language of its tests. Halving keeps them in the count without letting
 * them pick the headline.
 */
const SOURCE_WEIGHT = 2;
const TEST_WEIGHT = 1;

/** Language names this module can report. */
export type LanguageName =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'kotlin'
  | 'scala'
  | 'csharp'
  | 'c'
  | 'cpp'
  | 'ruby'
  | 'php'
  | 'swift'
  | 'shell'
  | 'sql'
  | 'perl'
  | 'lua'
  | 'r'
  | 'dart'
  | 'elixir'
  | 'haskell'
  | 'clojure'
  | 'objective-c'
  | 'terraform'
  | 'powershell'
  | 'vue'
  | 'svelte';

/**
 * Extensions that identify a language.
 *
 * Markup, data, and prose extensions (`.md`, `.json`, `.yml`, `.html`, `.css`)
 * are left out on purpose: a docs or fixtures directory would outvote the
 * source, and "markdown" is not an answer anyone wants to the question this
 * module asks.
 */
const LANGUAGES: Readonly<Record<string, LanguageName>> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.scala': 'scala',
  '.sc': 'scala',
  '.cs': 'csharp',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.sql': 'sql',
  '.pl': 'perl',
  '.pm': 'perl',
  '.lua': 'lua',
  '.r': 'r',
  '.dart': 'dart',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.hs': 'haskell',
  '.clj': 'clojure',
  '.cljs': 'clojure',
  '.m': 'objective-c',
  '.mm': 'objective-c',
  '.tf': 'terraform',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.vue': 'vue',
  '.svelte': 'svelte',
};

/**
 * Files a tool wrote rather than a person.
 *
 * They are excluded from the histogram and from the source count: a single
 * minified bundle or a generated protobuf stub can outweigh a whole `src/`.
 */
const GENERATED_FILE = /(?:\.min|\.bundle|\.generated|\.g|\.pb|\.designer|\.freezed)\./i;

/** Test files, by the naming conventions that cover most ecosystems. */
const TEST_FILE = /(?:\.test\.|\.spec\.|_test\.|^test_|Tests?\.(?:java|cs|kt|fs)$)/i;

/** Root files that name an ecosystem, in the order they are reported. */
const ROOT_MANIFESTS: ReadonlyArray<{ name: string; language: LanguageName }> = [
  { name: 'package.json', language: 'javascript' },
  { name: 'tsconfig.json', language: 'typescript' },
  { name: 'pyproject.toml', language: 'python' },
  { name: 'setup.py', language: 'python' },
  { name: 'go.mod', language: 'go' },
  { name: 'Cargo.toml', language: 'rust' },
  { name: 'pom.xml', language: 'java' },
  { name: 'build.gradle', language: 'java' },
  { name: 'build.gradle.kts', language: 'kotlin' },
  { name: 'build.sbt', language: 'scala' },
  { name: 'Gemfile', language: 'ruby' },
  { name: 'composer.json', language: 'php' },
  { name: 'Package.swift', language: 'swift' },
  { name: 'mix.exs', language: 'elixir' },
  { name: 'pubspec.yaml', language: 'dart' },
  { name: 'CMakeLists.txt', language: 'cpp' },
];

/**
 * Root files that decide the package manager, checked in order.
 *
 * Lockfiles are not reported as manifests even though they are root manifests,
 * because `package.json` next to `package-lock.json` would spend two of the
 * three printed slots on one ecosystem. A repository carrying two lockfiles is
 * already inconsistent, so the first table entry wins rather than a heuristic.
 */
const PACKAGE_MANAGERS: ReadonlyArray<{ file: string; manager: string }> = [
  { file: 'package-lock.json', manager: 'npm' },
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'pnpm-workspace.yaml', manager: 'pnpm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'bun.lockb', manager: 'bun' },
  { file: 'bun.lock', manager: 'bun' },
  { file: 'poetry.lock', manager: 'poetry' },
  { file: 'uv.lock', manager: 'uv' },
  { file: 'Pipfile', manager: 'pipenv' },
  { file: 'requirements.txt', manager: 'pip' },
  { file: 'go.mod', manager: 'go modules' },
  { file: 'Cargo.toml', manager: 'cargo' },
  { file: 'pom.xml', manager: 'maven' },
  { file: 'build.gradle', manager: 'gradle' },
  { file: 'build.gradle.kts', manager: 'gradle' },
  { file: 'build.sbt', manager: 'sbt' },
  { file: 'Gemfile', manager: 'bundler' },
  { file: 'composer.json', manager: 'composer' },
  { file: 'Package.swift', manager: 'swiftpm' },
  { file: 'mix.exs', manager: 'mix' },
  { file: 'pubspec.yaml', manager: 'pub' },
  { file: 'CMakeLists.txt', manager: 'cmake' },
];

/**
 * Test commands a single manifest justifies, checked in order.
 *
 * Every entry is the command that manifest's own tooling runs; a project file
 * that says nothing about testing is left alone, because a command the
 * repository does not support is worse than an empty field.
 */
const TEST_COMMANDS: ReadonlyArray<{ file: string; command: string }> = [
  { file: 'go.mod', command: 'go test ./...' },
  { file: 'Cargo.toml', command: 'cargo test' },
  { file: 'pom.xml', command: 'mvn test' },
  { file: 'build.gradle', command: './gradlew test' },
  { file: 'build.gradle.kts', command: './gradlew test' },
  { file: 'pyproject.toml', command: 'pytest' },
  { file: 'setup.py', command: 'pytest' },
  { file: 'Package.swift', command: 'swift test' },
];

/** Test scripts in `package.json`, most specific name last: `test` is the entry point. */
const PACKAGE_SCRIPTS = ['test', 'vitest', 'jest'];

const NODE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

export interface DetectWorkspaceOptions {
  /** Root of the workspace. A missing or unreadable directory reports unknown. */
  dir: string;
  /**
   * Cancel the walk. A synchronous walk cannot be interrupted from outside
   * without a check inside the loop, so the flag is polled per entry, the same
   * way `grepWorkspace` polls it.
   */
  signal?: AbortSignal;
  /** Override for the walk budget. Defaults to `WORKSPACE_BUDGET_MS`. */
  budgetMs?: number;
}

export interface WorkspaceFacts {
  /** Detected languages, most likely first. Empty when nothing was recognised. */
  languages: LanguageName[];
  /** Package manager implied by a lockfile or a manifest field, `''` when none. */
  packageManager: string;
  /** Test command a manifest supports, `''` when no manifest justifies one. */
  testCommand: string;
  /** Root manifests found, in `ROOT_MANIFESTS` order. */
  manifests: string[];
  /** Files with a recognised source extension, minus generated files. */
  sourceFiles: number;
  /** True when the file cap, the budget, or an abort stopped the walk early. */
  truncated: boolean;
  /** True when the walk was cancelled rather than finished. */
  aborted: boolean;
}

/** The answer for a directory nothing could be said about. */
export function unknownWorkspaceFacts(): WorkspaceFacts {
  return {
    languages: [],
    packageManager: '',
    testCommand: '',
    manifests: [],
    sourceFiles: 0,
    truncated: false,
    aborted: false,
  };
}

/** `1 file` / `2 files`, so a count never reads as `1 source file(s)`. */
function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

/**
 * Read through a call so TypeScript re-checks the flag every time: a direct
 * `options.signal?.aborted` comparison inside the loop gets narrowed once and
 * then treated as never changing.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** `realpathSync` that reports failure as `null`: a broken link is not an error here. */
function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Whether a resolved path is a directory, with failure read as "no". */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read a small text file, or `null`.
 *
 * The size and null-byte checks matter for `package.json` in particular: some
 * repositories commit a generated one, and parsing a megabyte of minified JSON
 * to find no `scripts` field is work the budget should not pay for.
 */
function readSmallTextFile(path: string): string | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) return null;
    const buffer = readFileSync(path);
    if (buffer.subarray(0, SNIFF_BYTES).includes(0)) return null;
    return buffer.toString('utf8');
  } catch {
    return null;
  }
}

/** The root's entry names, so manifest checks cost one directory read. */
function listRootNames(root: string): Set<string> {
  const names = new Set<string>();
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const entry of entries) {
    // A symlinked manifest still names an ecosystem, so links count here and
    // are left to fail later if they dangle.
    if (entry.isFile() || entry.isSymbolicLink()) names.add(entry.name);
  }
  return names;
}

interface PackageJsonFacts {
  /** Raw `packageManager` field, e.g. `pnpm@9.1.0`. */
  packageManager: string;
  scripts: Record<string, string>;
}

/** The two fields of `package.json` this module reads, or `null` when unusable. */
function readPackageJson(path: string): PackageJsonFacts | null {
  const text = readSmallTextFile(path);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;

  const scripts: Record<string, string> = {};
  const rawScripts = record['scripts'];
  if (typeof rawScripts === 'object' && rawScripts !== null) {
    for (const [name, value] of Object.entries(rawScripts as Record<string, unknown>)) {
      if (typeof value === 'string') scripts[name] = value;
    }
  }
  const declared = record['packageManager'];
  return { packageManager: typeof declared === 'string' ? declared : '', scripts };
}

/** `pnpm@9.1.0` -> `pnpm`, and anything unrecognisable -> `''`. */
function managerFromField(value: string): string {
  const name = (value.split('@')[0] ?? '').trim().toLowerCase();
  return /^[a-z][a-z0-9-]*$/.test(name) ? name : '';
}

function detectPackageManager(rootNames: Set<string>, declared: string): string {
  // An explicit `packageManager` field outranks a lockfile, because a lockfile
  // can be left behind by a migration and the field cannot be accidental.
  const explicit = managerFromField(declared);
  if (explicit !== '') return explicit;
  for (const candidate of PACKAGE_MANAGERS) {
    if (rootNames.has(candidate.file)) return candidate.manager;
  }
  return '';
}

/**
 * The Node script runner: a repository with both `package.json` and `go.mod`
 * needs the Node one for a Node script, and the detected manager may be neither.
 */
function nodeManager(packageManager: string): string {
  return NODE_MANAGERS.has(packageManager) ? packageManager : 'npm';
}

function scriptCommand(manager: string, script: string): string {
  // `bun test` is bun's own runner rather than the `test` script, and only the
  // three managers here accept `test` as an alias for `run test`.
  if (script === 'test' && (manager === 'npm' || manager === 'pnpm' || manager === 'yarn')) {
    return `${manager} test`;
  }
  return `${manager} run ${script}`;
}

function detectTestCommand(
  packageJson: PackageJsonFacts | null,
  rootNames: Set<string>,
  packageManager: string,
): string {
  if (packageJson !== null) {
    for (const script of PACKAGE_SCRIPTS) {
      if (packageJson.scripts[script] !== undefined) {
        return scriptCommand(nodeManager(packageManager), script);
      }
    }
  }
  for (const candidate of TEST_COMMANDS) {
    if (rootNames.has(candidate.file)) return candidate.command;
  }
  return '';
}

function isTestFile(name: string): boolean {
  return TEST_FILE.test(name);
}

/** The language a file name claims, or `undefined` when this module has no opinion. */
function languageForFile(name: string): LanguageName | undefined {
  if (GENERATED_FILE.test(name)) return undefined;
  return LANGUAGES[extname(name).toLowerCase()];
}

/**
 * Pairs where the stronger name already covers the weaker one.
 *
 * TypeScript compiles to JavaScript, so a repository with both is reported once:
 * `typescript + javascript` spends two of the three slots saying one thing. And
 * `.h` is a C file in a C repository but a header in a C++ one, so when both
 * appear the C count is the smaller half of one C++ tree.
 */
const SUBSUMED_LANGUAGES: ReadonlyArray<readonly [LanguageName, LanguageName]> = [
  ['typescript', 'javascript'],
  ['cpp', 'c'],
];

/**
 * Order the languages by evidence.
 *
 * Manifest scores and histogram weights are not on the same scale on purpose:
 * the manifest score is out of the histogram's reach, so the ordering inside
 * the detected set is what the manifests said and the histogram only decides
 * the rest.
 */
function rankLanguages(
  manifestScores: ReadonlyMap<LanguageName, number>,
  counts: ReadonlyMap<LanguageName, number>,
): LanguageName[] {
  const totals = new Map<LanguageName, number>(manifestScores);
  for (const [language, count] of counts) {
    totals.set(language, (totals.get(language) ?? 0) + count);
  }
  for (const [strong, weak] of SUBSUMED_LANGUAGES) {
    if (totals.has(strong)) totals.delete(weak);
  }
  // A stable sort keeps insertion order for equal scores, which is manifest
  // order for the languages a manifest named.
  return [...totals.entries()]
    .sort(([, left], [, right]) => right - left)
    .slice(0, MAX_LANGUAGES)
    .map(([language]) => language);
}

/** The histogram over the walked tree, plus the walk's own bookkeeping. */
interface WalkResult {
  counts: Map<LanguageName, number>;
  sourceFiles: number;
  truncated: boolean;
  aborted: boolean;
}

/**
 * Walk the tree for a file-extension histogram.
 *
 * No file is opened: the histogram is built from names, so a binary or an
 * oversized file costs nothing but its directory entry. That is also why the
 * walk's caps are the only thing standing between this and a slow start.
 */
function walkForExtensions(options: {
  root: string;
  rootReal: string;
  signal: AbortSignal | undefined;
  deadline: number;
}): WalkResult {
  const counts = new Map<LanguageName, number>();
  let sourceFiles = 0;
  let visited = 0;
  let truncated = false;
  let aborted = false;

  // Every directory is keyed by a path, because a link can point at one of its
  // own ancestors; a repeat means this walk has been here already. The root is
  // keyed both ways so a link back to it is caught whichever form it resolves to.
  const seenDirs = new Set<string>([options.root, options.rootReal]);
  const queue: Array<{ path: string; depth: number }> = [{ path: options.root, depth: 0 }];

  while (queue.length > 0) {
    if (isAborted(options.signal)) {
      aborted = true;
      truncated = true;
      break;
    }
    if (visited >= MAX_FILES || Date.now() >= options.deadline) {
      truncated = true;
      break;
    }
    const current = queue.shift();
    if (current === undefined) break;

    let entries: Dirent[];
    try {
      entries = readdirSync(current.path, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: skip rather than abandon the scan
    }

    for (const entry of entries) {
      if (isAborted(options.signal)) {
        aborted = true;
        truncated = true;
        break;
      }
      if (visited >= MAX_FILES || Date.now() >= options.deadline) {
        truncated = true;
        break;
      }
      // The skip list is about directories, so a *file* named `build` is still
      // counted; only an entry that could be descended into is dropped here.
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        if (SKIP_DIRS.has(entry.name) || current.depth >= MAX_DEPTH) continue;
        const full = join(current.path, entry.name);
        // Resolving a path is the most expensive call in this loop — measured
        // at about half the walk on a Windows checkout — so it is paid only for
        // links, which are the only entries that can point back into the tree.
        // A plain directory is keyed by the path it was reached by, and the root
        // is keyed both ways, so a link that does loop back meets its own
        // resolved path in the set at worst one level later.
        const link = entry.isSymbolicLink();
        const key = link ? safeRealpath(full) : full;
        if (key === null || seenDirs.has(key)) continue;
        if (link && !isDirectory(key)) continue; // a link to a file, or a broken one
        seenDirs.add(key);
        queue.push({ path: key, depth: current.depth + 1 });
        continue;
      }
      // A link that does not point at a directory is dropped in the branch
      // above, because the same bytes can be linked from several places and the
      // count is of this tree's own files, each seen once. Named pipes and
      // sockets land here and are not files either.
      if (!entry.isFile()) continue;

      visited++;
      const language = languageForFile(entry.name);
      if (language === undefined) continue;
      sourceFiles++;
      counts.set(language, (counts.get(language) ?? 0) + (isTestFile(entry.name) ? TEST_WEIGHT : SOURCE_WEIGHT));
    }
  }

  return { counts, sourceFiles, truncated, aborted };
}

function scan(options: DetectWorkspaceOptions): WorkspaceFacts {
  const root = resolve(options.dir);
  if (!isDirectory(root)) return unknownWorkspaceFacts();
  const rootReal = safeRealpath(root);
  if (rootReal === null) return unknownWorkspaceFacts();

  const budgetMs =
    options.budgetMs !== undefined && Number.isFinite(options.budgetMs)
      ? Math.max(0, options.budgetMs)
      : WORKSPACE_BUDGET_MS;
  const deadline = Date.now() + budgetMs;

  // Manifests are read before the walk so that a walk cut short by the budget
  // still reports the language and the tooling they name.
  const rootNames = listRootNames(root);
  const manifestScores = new Map<LanguageName, number>();
  const manifests: string[] = [];
  for (const manifest of ROOT_MANIFESTS) {
    if (!rootNames.has(manifest.name)) continue;
    manifests.push(manifest.name);
    const weight = MANIFEST_WEIGHT + (manifest.name === 'tsconfig.json' ? TSCONFIG_PROMOTION : 0);
    manifestScores.set(manifest.language, (manifestScores.get(manifest.language) ?? 0) + weight);
  }

  const packageJson = rootNames.has('package.json')
    ? readPackageJson(join(root, 'package.json'))
    : null;
  const packageManager = detectPackageManager(rootNames, packageJson?.packageManager ?? '');
  const testCommand = detectTestCommand(packageJson, rootNames, packageManager);

  const walk = walkForExtensions({
    root,
    rootReal,
    signal: options.signal,
    deadline,
  });

  return {
    languages: rankLanguages(manifestScores, walk.counts),
    packageManager,
    testCommand,
    manifests,
    sourceFiles: walk.sourceFiles,
    truncated: walk.truncated,
    aborted: walk.aborted,
  };
}

/**
 * Describe the workspace, never throwing.
 *
 * A cut-short walk is reported through `truncated` rather than discarded: the
 * root manifests are read in full before the walk starts, so a language they
 * name is a fact and not a guess. When the walk was the only source of facts
 * and it produced none, the result is `unknown` — the same answer as an empty
 * directory, which callers already have to handle.
 */
export function detectWorkspace(options: DetectWorkspaceOptions): WorkspaceFacts {
  try {
    return scan(options);
  } catch {
    // A header line and a prompt section are not worth failing a run over.
    return unknownWorkspaceFacts();
  }
}

/**
 * The one-line form, shared by the TUI sidebar and the plaintext header.
 *
 * The count is read through `formatCount` so a large repository reports `12k
 * source files` rather than a number too wide for a 34-column sidebar row.
 */
export function formatWorkspaceFacts(facts: WorkspaceFacts): string {
  if (facts.languages.length === 0) return 'unknown';
  const manager = facts.packageManager === '' ? '' : ` (${facts.packageManager})`;
  return (
    `${facts.languages.join(' + ')}${manager}, ` +
    `${formatCount(facts.sourceFiles)} ${plural(facts.sourceFiles, 'source file')}`
  );
}

/** Up to three manifest names, with the rest counted. */
export function formatManifestList(manifests: readonly string[]): string {
  if (manifests.length === 0) return '';
  const listed = manifests.slice(0, MAX_LISTED_MANIFESTS).join(', ');
  const rest = manifests.length - MAX_LISTED_MANIFESTS;
  return rest > 0 ? `${listed} +${rest} more` : listed;
}

/**
 * The `## Workspace` section for the system prompt.
 *
 * An unrecognised directory still gets a section, one line long. A model that
 * reads no section cannot tell whether detection found nothing or was never
 * run, and "the toolchain here is unknown" is itself worth knowing before it
 * decides how to build or test.
 */
export function formatWorkspaceSection(facts: WorkspaceFacts): string {
  const heading = '## Workspace';
  if (facts.languages.length === 0) {
    return `${heading}\nNothing in this directory identified a language or a build tool; treat the toolchain as unknown.`;
  }
  const lines = [
    `Detected: ${formatWorkspaceFacts(facts)}` +
      (facts.truncated ? ' (scan cut short; file counts are a lower bound)' : ''),
  ];
  const manifestList = formatManifestList(facts.manifests);
  if (manifestList !== '') lines.push(`Manifests: ${manifestList}`);
  if (facts.testCommand !== '') lines.push(`Test command: ${facts.testCommand}`);
  return `${heading}\n${lines.join('\n')}`;
}
