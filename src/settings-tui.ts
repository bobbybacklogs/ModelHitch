#!/usr/bin/env bun
/**
 * The local settings TUI (`modelhitch settings`).
 *
 * A form over the ModelHitch config document, run under bun because OpenTUI's
 * renderer needs its native FFI. It shares the harness's visual language on
 * purpose: same palette, same panel idiom, same key hints — a project whose two
 * TUIs look like two different products is a project that reads as unmaintained.
 *
 * Two behaviours here are about not losing work rather than about looks:
 *   - the form knows when it differs from what is on disk, and Esc asks before
 *     discarding; a second Esc confirms.
 *   - validation failures from `writeConfigFile` land in the status bar with the
 *     field that caused them, rather than replacing the whole form.
 */

import {
  ASCIIFontRenderable,
  BoxRenderable,
  InputRenderable,
  StyledText,
  TabSelectRenderable,
  TabSelectRenderableEvents,
  TextRenderable,
  bold,
  fg,
  type KeyEvent,
  type Renderable,
  type TextChunk,
} from '@opentui/core';
import { defaultConfigPath, defaultConfigTemplate, readConfigFile, writeConfigFile } from './config-file.js';
import { validateConfig } from './config.js';
import { applySettingsForm, configToSettingsForm } from './settings-form.js';

const BG = '#0d1117';
const PANEL = '#161b22';
const PANEL_ALT = '#1c2128';
const FIELD = '#21262d';
const BORDER = '#30363d';
const ACCENT = '#d4a72c';
const TEXT = '#e6edf3';
const MUTED = '#8b949e';
const FAINT = '#6e7681';
const INFO = '#58a6ff';
const OK = '#3fb950';
const ERROR = '#f85149';

const chunk = (color: string, text: string): TextChunk => fg(color)(text);

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  const value = process.argv[index + 1];
  return index === -1 || !value || value.startsWith('--') ? undefined : value;
}

function selectedValue<T extends string>(control: TabSelectRenderable): T {
  return control.getSelectedOption()?.value as T;
}

function selectIndex(values: string[], selected: string): number {
  const index = values.indexOf(selected);
  return index === -1 ? 0 : index;
}

function tabOptions(values: string[]): Array<{ name: string; description: string; value: string }> {
  return values.map((value) => ({ name: value, description: '', value }));
}

interface FieldEntry {
  label: string;
  panel: string;
  control: Renderable & { focus(): void; blur(): void };
  /** Label renderable, so the focused field can be marked. */
  labelView?: TextRenderable;
}

const OPENAI_MODELS = ['gpt-image-2', 'gpt-image-1.5'];
const GEMINI_MODELS = [
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-lite-image',
  'gemini-3-pro-image',
  'gemini-2.5-flash-image',
];

async function run(): Promise<void> {
  const configPath = argValue('--config') ?? defaultConfigPath();
  const config = readConfigFile(configPath) ?? defaultConfigTemplate();
  const originalValidation = validateConfig(config);
  if (originalValidation.errors.length) {
    throw new Error(`Config is invalid:\n${originalValidation.errors.join('\n')}`);
  }
  const original = configToSettingsForm(config);
  const form = original;

  const { createCliRenderer } = await import('@opentui/core');
  const renderer = await createCliRenderer({
    screenMode: 'alternate-screen',
    exitOnCtrlC: true,
    consoleMode: 'disabled',
    backgroundColor: BG,
    targetFps: 30,
  });
  renderer.setTerminalTitle(`ModelHitch settings · ${configPath}`);

  /* ---------------------------------------------------------------- *
   * Chrome
   * ---------------------------------------------------------------- */

  const root = new BoxRenderable(renderer, {
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    backgroundColor: BG,
  });

  const wordmark = new ASCIIFontRenderable(renderer, {
    text: 'MODELHITCH',
    font: 'tiny',
    color: ACCENT,
    backgroundColor: BG,
    selectable: false,
  });
  const wordmarkSmall = new TextRenderable(renderer, {
    content: new StyledText([bold(chunk(ACCENT, '▌ MODELHITCH'))]),
    height: 1,
    visible: false,
  });
  const headerRight = new BoxRenderable(renderer, {
    flexDirection: 'column',
    alignItems: 'flex-end',
  });
  headerRight.add(
    new TextRenderable(renderer, {
      content: new StyledText([chunk(MUTED, 'local settings')]),
      height: 1,
    }),
  );
  headerRight.add(
    new TextRenderable(renderer, {
      content: new StyledText([chunk(FAINT, configPath)]),
      height: 1,
      wrapMode: 'none',
    }),
  );

  const headerRow = new BoxRenderable(renderer, {
    flexDirection: 'row',
    width: '100%',
    justifyContent: 'space-between',
    paddingLeft: 1,
    paddingRight: 1,
    flexShrink: 0,
  });
  const wordmarkBox = new BoxRenderable(renderer, { flexDirection: 'column', flexShrink: 0 });
  wordmarkBox.add(wordmark);
  wordmarkBox.add(wordmarkSmall);
  headerRow.add(wordmarkBox);
  headerRow.add(headerRight);

  const panelOptions = (title: string): ConstructorParameters<typeof BoxRenderable>[1] => ({
    flexDirection: 'column',
    borderStyle: 'rounded',
    borderColor: BORDER,
    title: ` ${title} `,
    titleColor: ACCENT,
    backgroundColor: PANEL,
    paddingLeft: 1,
    paddingRight: 1,
    paddingTop: 0,
    gap: 1,
    minHeight: 0,
  });

  const routingPanel = new BoxRenderable(renderer, { ...panelOptions('Routing'), width: '52%' });
  const imagesPanel = new BoxRenderable(renderer, { ...panelOptions('Images'), width: '48%' });
  const reliabilityPanel = new BoxRenderable(renderer, {
    ...panelOptions('Reliability'),
    flexGrow: 1,
  });

  const body = new BoxRenderable(renderer, {
    flexDirection: 'row',
    width: '100%',
    flexGrow: 1,
    gap: 1,
    paddingLeft: 1,
    paddingRight: 1,
    minHeight: 0,
  });
  const rightColumn = new BoxRenderable(renderer, { flexDirection: 'column', width: '48%', gap: 1, minHeight: 0 });
  rightColumn.add(imagesPanel);
  rightColumn.add(reliabilityPanel);
  body.add(routingPanel);
  body.add(rightColumn);

  const status = new TextRenderable(renderer, { content: '', height: 1, wrapMode: 'none', flexShrink: 1 });
  const statusRight = new TextRenderable(renderer, { content: '', height: 1, wrapMode: 'none', flexShrink: 0 });
  const statusBar = new BoxRenderable(renderer, {
    flexDirection: 'row',
    width: '100%',
    height: 1,
    paddingLeft: 1,
    paddingRight: 1,
    justifyContent: 'space-between',
    flexShrink: 0,
  });
  statusBar.add(status);
  statusBar.add(statusRight);

  const keybar = new TextRenderable(renderer, {
    content: new StyledText([
      chunk(ACCENT, 'Tab'), chunk(FAINT, ' next field   '),
      chunk(ACCENT, '←/→'), chunk(FAINT, ' choose   '),
      chunk(ACCENT, 'Ctrl+S'), chunk(FAINT, ' save   '),
      chunk(ACCENT, 'Esc'), chunk(FAINT, ' close   '),
      chunk(ACCENT, '?'), chunk(FAINT, ' help'),
    ]),
    height: 1,
    wrapMode: 'none',
    paddingLeft: 1,
    flexShrink: 0,
  });

  for (const child of [headerRow, body, statusBar, keybar]) root.add(child);
  renderer.root.add(root);

  /* ---------------------------------------------------------------- *
   * Controls
   * ---------------------------------------------------------------- */

  const input = (id: string, value: string, placeholder: string): InputRenderable => new InputRenderable(renderer, {
    id,
    value,
    placeholder,
    width: '100%',
    backgroundColor: FIELD,
    focusedBackgroundColor: '#30363d',
    textColor: TEXT,
    cursorColor: ACCENT,
  });

  const tabs = (id: string, values: string[], selected: string): TabSelectRenderable => {
    const control = new TabSelectRenderable(renderer, {
      id,
      width: '100%',
      height: 1,
      options: tabOptions(values),
      showDescription: false,
      showUnderline: true,
      wrapSelection: true,
      backgroundColor: PANEL_ALT,
      focusedBackgroundColor: FIELD,
      selectedTextColor: ACCENT,
      textColor: MUTED,
    });
    control.setSelectedIndex(selectIndex(values, selected));
    return control;
  };

  const controlIds = {
    defaultProvider: 'default-provider',
    defaultModel: 'default-model',
    defaultWorkspaceTarget: 'workspace-target',
    trustedLanes: 'trusted-lanes',
    fallbackLanes: 'fallback-lanes',
    imageEnabled: 'image-enabled',
    imageProvider: 'image-provider',
    imageModel: 'image-model',
    imageQuality: 'image-quality',
    imageSize: 'image-size',
    cooldownType: 'cooldown-type',
    failureThreshold: 'failure-threshold',
    baseTripMs: 'base-trip-ms',
    maxTripMs: 'max-trip-ms',
  } as const;

  const defaultProvider = input(controlIds.defaultProvider, form.defaultProviderId, 'provider id');
  const defaultModel = input(controlIds.defaultModel, form.defaultModel, 'provider default');
  const defaultWorkspaceTarget = input(controlIds.defaultWorkspaceTarget, form.defaultWorkspaceTarget, 'rotation or provider/model');
  const trustedLanes = input(controlIds.trustedLanes, form.trustedLanes, 'provider/model; provider/model');
  const fallbackLanes = input(controlIds.fallbackLanes, form.fallbackLanes, 'provider/model; provider/model');
  const imageEnabled = tabs(controlIds.imageEnabled, ['off', 'on'], form.imageEnabled ? 'on' : 'off');
  const imageProvider = tabs(controlIds.imageProvider, ['openai', 'gemini'], form.imageProvider);
  const imageModel = tabs(controlIds.imageModel, form.imageProvider === 'gemini' ? GEMINI_MODELS : OPENAI_MODELS, form.imageModel);
  const imageQuality = tabs(controlIds.imageQuality, ['low', 'medium'], form.imageQuality);
  const imageSize = input(controlIds.imageSize, form.imageSize, '1024x1024');
  const cooldownType = tabs(controlIds.cooldownType, ['none', 'memory', 'circuit-breaker'], form.cooldownType);
  const failureThreshold = input(controlIds.failureThreshold, form.failureThreshold, '3');
  const baseTripMs = input(controlIds.baseTripMs, form.baseTripMs, '15000');
  const maxTripMs = input(controlIds.maxTripMs, form.maxTripMs, '120000');

  const entries: FieldEntry[] = [];
  const field = (
    panel: BoxRenderable,
    panelName: string,
    label: string,
    control: Renderable & { focus(): void; blur(): void },
    hint?: string,
  ): void => {
    const row = new BoxRenderable(renderer, { flexDirection: 'column', height: hint ? 3 : 2, width: '100%' });
    const labelView = new TextRenderable(renderer, { content: '', height: 1, wrapMode: 'none' });
    labelView.content = new StyledText([chunk(MUTED, label)]);
    row.add(labelView);
    row.add(control);
    if (hint !== undefined) {
      row.add(new TextRenderable(renderer, { content: new StyledText([chunk(FAINT, hint)]), height: 1, wrapMode: 'none' }));
    }
    panel.add(row);
    entries.push({ label, panel: panelName, control, labelView });
  };

  field(routingPanel, 'Routing', 'Default provider', defaultProvider, 'provider id, e.g. vercel-ai-gateway');
  field(routingPanel, 'Routing', 'Default model', defaultModel, 'model id under that provider');
  field(routingPanel, 'Routing', 'Workspace target', defaultWorkspaceTarget, '“rotation” or provider/model');
  field(routingPanel, 'Routing', 'Trusted lanes', trustedLanes, 'provider/model,model; …  walked first');
  field(routingPanel, 'Routing', 'Fallback lanes', fallbackLanes, 'provider/model,model; …  walked next');

  field(imagesPanel, 'Images', 'Image lane', imageEnabled);
  field(imagesPanel, 'Images', 'Provider', imageProvider);
  field(imagesPanel, 'Images', 'Model', imageModel);
  field(imagesPanel, 'Images', 'OpenAI quality', imageQuality);
  field(imagesPanel, 'Images', 'Size', imageSize);

  field(reliabilityPanel, 'Reliability', 'Cooldown engine', cooldownType);
  field(reliabilityPanel, 'Reliability', 'Failure threshold', failureThreshold, 'trips before a lane cools down');
  field(reliabilityPanel, 'Reliability', 'Base trip', baseTripMs, 'ms before the first retry');
  field(reliabilityPanel, 'Reliability', 'Maximum trip', maxTripMs, 'ms cap for the backoff');

  let focusIndex = 0;
  let dirty = false;
  let confirmDiscard = false;

  /** The form as it stands, which is also how the dirty check works. */
  const currentForm = (): Parameters<typeof applySettingsForm>[1] => ({
    defaultProviderId: defaultProvider.value,
    defaultModel: defaultModel.value,
    defaultWorkspaceTarget: defaultWorkspaceTarget.value,
    trustedLanes: trustedLanes.value,
    fallbackLanes: fallbackLanes.value,
    imageEnabled: selectedValue<'off' | 'on'>(imageEnabled) === 'on',
    imageProvider: selectedValue<'openai' | 'gemini'>(imageProvider),
    imageModel: selectedValue<string>(imageModel),
    imageQuality: selectedValue<'low' | 'medium'>(imageQuality),
    imageSize: imageSize.value,
    cooldownType: selectedValue<'none' | 'memory' | 'circuit-breaker'>(cooldownType),
    failureThreshold: failureThreshold.value,
    baseTripMs: baseTripMs.value,
    maxTripMs: maxTripMs.value,
  });

  const isDirty = (): boolean => JSON.stringify(currentForm()) !== JSON.stringify(original);

  const renderFocus = (): void => {
    entries.forEach((entry, index) => {
      const focused = index === focusIndex;
      entry.labelView!.content = new StyledText([
        focused ? chunk(ACCENT, '▌ ') : chunk(FAINT, '  '),
        focused ? bold(chunk(TEXT, entry.label)) : chunk(MUTED, entry.label),
      ]);
    });
    const entry = entries[focusIndex];
    statusRight.content = new StyledText([
      chunk(FAINT, entry === undefined ? '' : `${entry.panel} · field ${focusIndex + 1}/${entries.length}`),
    ]);
  };

  const setStatus = (message: string, color: string): void => {
    status.content = new StyledText([chunk(color, message)]);
  };

  const save = (): void => {
    try {
      const next = applySettingsForm(config, currentForm());
      writeConfigFile(configPath, next);
      dirty = false;
      confirmDiscard = false;
      setStatus(`✔ Saved to ${configPath}`, OK);
    } catch (error) {
      setStatus(`✖ ${(error as Error).message.replace(/\n/g, ' · ')}`, ERROR);
    }
  };

  const focusField = (index: number): void => {
    entries[focusIndex]?.control.blur();
    focusIndex = (index + entries.length) % entries.length;
    entries[focusIndex]?.control.focus();
    renderFocus();
    setStatus('Tab and Shift+Tab move between fields', MUTED);
  };

  imageProvider.on(TabSelectRenderableEvents.SELECTION_CHANGED, () => {
    const provider = selectedValue<'openai' | 'gemini'>(imageProvider);
    imageModel.options = tabOptions(provider === 'gemini' ? GEMINI_MODELS : OPENAI_MODELS);
    imageModel.setSelectedIndex(0);
    setStatus(provider === 'gemini' ? 'Gemini ignores the OpenAI quality setting' : 'OpenAI Image API selected', MUTED);
  });
  imageModel.on(TabSelectRenderableEvents.SELECTION_CHANGED, () => {
    if (selectedValue<string>(imageModel) === 'gpt-image-1.5') imageQuality.setSelectedIndex(1);
  });

  const layout = (): void => {
    const narrow = renderer.width < 96;
    wordmark.visible = !narrow;
    wordmarkSmall.visible = narrow;
    body.flexDirection = narrow ? 'column' : 'row';
    routingPanel.width = narrow ? '100%' : '52%';
    rightColumn.width = narrow ? '100%' : '48%';
  };

  renderer.on('resize', () => layout());
  layout();
  focusField(0);
  setStatus('Ready', MUTED);

  renderer.keyInput.on('keypress', (key: KeyEvent) => {
    if (key.name === 'tab') {
      key.preventDefault();
      confirmDiscard = false;
      focusField(focusIndex + (key.shift ? -1 : 1));
      return;
    }
    if (key.ctrl && key.name === 's') {
      key.preventDefault();
      save();
      return;
    }
    if (key.name === 'escape') {
      key.preventDefault();
      dirty = isDirty();
      // Closing with unsaved edits is the one destructive thing this screen can
      // do, so it takes two presses and says so in between.
      if (dirty && !confirmDiscard) {
        confirmDiscard = true;
        setStatus('✖ Unsaved changes — Ctrl+S to save, Esc again to discard', ERROR);
        return;
      }
      renderer.destroy();
      return;
    }
  });
}

run().catch((error) => {
  console.error(`modelhitch settings: ${(error as Error).message}`);
  process.exitCode = 1;
});
