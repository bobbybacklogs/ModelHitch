#!/usr/bin/env bun
import {
  BoxRenderable,
  createCliRenderer,
  InputRenderable,
  TabSelectRenderable,
  TabSelectRenderableEvents,
  TextRenderable,
  type KeyEvent,
  type Renderable,
} from '@opentui/core';
import { defaultConfigPath, defaultConfigTemplate, readConfigFile, writeConfigFile } from './config-file.js';
import { validateConfig } from './config.js';
import { applySettingsForm, configToSettingsForm } from './settings-form.js';

const ACCENT = '#d4a72c';
const MUTED = '#8b949e';
const PANEL = '#161b22';
const FIELD = '#21262d';
const TEXT = '#e6edf3';
const OK = '#3fb950';
const ERROR = '#f85149';

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

async function run(): Promise<void> {
  const configPath = argValue('--config') ?? defaultConfigPath();
  const config = readConfigFile(configPath) ?? defaultConfigTemplate();
  const currentValidation = validateConfig(config);
  if (currentValidation.errors.length) {
    throw new Error(`Config is invalid:\n${currentValidation.errors.join('\n')}`);
  }
  const form = configToSettingsForm(config);
  const renderer = await createCliRenderer({
    screenMode: 'alternate-screen',
    exitOnCtrlC: true,
    consoleMode: 'disabled',
    backgroundColor: '#0d1117',
    targetFps: 30,
  });

  const root = new BoxRenderable(renderer, {
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    padding: 1,
    gap: 1,
    backgroundColor: '#0d1117',
  });
  const heading = new TextRenderable(renderer, { content: 'MODELHiTCH  /  LOCAL SETTINGS', fg: ACCENT, height: 1 });
  const pathText = new TextRenderable(renderer, { content: configPath, fg: MUTED, height: 1 });
  const body = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: 'row', gap: 1 });
  const left = new BoxRenderable(renderer, {
    width: '50%',
    flexDirection: 'column',
    borderStyle: 'rounded',
    borderColor: '#30363d',
    title: ' Routing + images ',
    titleColor: ACCENT,
    padding: 1,
    gap: 0,
  });
  const right = new BoxRenderable(renderer, {
    width: '50%',
    flexDirection: 'column',
    borderStyle: 'rounded',
    borderColor: '#30363d',
    title: ' Reliability ',
    titleColor: ACCENT,
    padding: 1,
    gap: 0,
  });
  const status = new TextRenderable(renderer, { content: 'Ready', fg: MUTED, height: 1 });
  const footer = new TextRenderable(renderer, {
    content: 'Tab / Shift+Tab move   Left/Right choose   Ctrl+S save   Esc close',
    fg: MUTED,
    height: 1,
  });

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
      backgroundColor: PANEL,
      focusedBackgroundColor: FIELD,
      selectedTextColor: ACCENT,
      textColor: MUTED,
    });
    control.setSelectedIndex(selectIndex(values, selected));
    return control;
  };
  const field = (label: string, control: Renderable): BoxRenderable => {
    const row = new BoxRenderable(renderer, { flexDirection: 'column', height: 2 });
    row.add(new TextRenderable(renderer, { content: label, fg: MUTED, height: 1 }));
    row.add(control);
    return row;
  };

  const defaultProvider = input('default-provider', form.defaultProviderId, 'provider id');
  const defaultModel = input('default-model', form.defaultModel, 'provider default');
  const defaultWorkspaceTarget = input('workspace-target', form.defaultWorkspaceTarget, 'rotation or provider/model');
  const trustedLanes = input('trusted-lanes', form.trustedLanes, 'provider/model; provider/model');
  const fallbackLanes = input('fallback-lanes', form.fallbackLanes, 'provider/model; provider/model');
  const imageEnabled = tabs('image-enabled', ['off', 'on'], form.imageEnabled ? 'on' : 'off');
  const imageProvider = tabs('image-provider', ['openai', 'gemini'], form.imageProvider);
  const openAIModels = ['gpt-image-2', 'gpt-image-1.5'];
  const geminiModels = ['gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-3-pro-image', 'gemini-2.5-flash-image'];
  const imageModel = tabs('image-model', form.imageProvider === 'gemini' ? geminiModels : openAIModels, form.imageModel);
  const imageQuality = tabs('image-quality', ['low', 'medium'], form.imageQuality);
  const imageSize = input('image-size', form.imageSize, '1024x1024');
  const cooldownType = tabs('cooldown-type', ['none', 'memory', 'circuit-breaker'], form.cooldownType);
  const failureThreshold = input('failure-threshold', form.failureThreshold, '3');
  const baseTripMs = input('base-trip-ms', form.baseTripMs, '15000');
  const maxTripMs = input('max-trip-ms', form.maxTripMs, '120000');

  for (const child of [
    field('Default provider', defaultProvider),
    field('Default model', defaultModel),
    field('Workspace target (rotation or provider/model)', defaultWorkspaceTarget),
    field('Trusted lanes  (provider/model,model; ...)', trustedLanes),
    field('Fallback lanes (provider/model,model; ...)', fallbackLanes),
    new TextRenderable(renderer, {
      content: 'Rotation walks trusted lanes first, then fallback lanes.',
      fg: MUTED,
      flexGrow: 1,
    }),
  ]) left.add(child);
  for (const child of [
    field('Image lane', imageEnabled),
    field('Image provider', imageProvider),
    field('Image model', imageModel),
    field('OpenAI quality', imageQuality),
    field('Image size', imageSize),
    field('Cooldown engine', cooldownType),
    field('Failure threshold', failureThreshold),
    field('Base trip ms', baseTripMs),
    field('Maximum trip ms', maxTripMs),
  ]) right.add(child);
  body.add(left);
  body.add(right);
  for (const child of [heading, pathText, body, status, footer]) root.add(child);
  renderer.root.add(root);

  const focusables: Array<{ focus(): void; blur(): void }> = [
    defaultProvider,
    defaultModel,
    defaultWorkspaceTarget,
    trustedLanes,
    fallbackLanes,
    imageEnabled,
    imageProvider,
    imageModel,
    imageQuality,
    imageSize,
    cooldownType,
    failureThreshold,
    baseTripMs,
    maxTripMs,
  ];
  let focusIndex = 0;
  focusables[focusIndex]!.focus();

  imageProvider.on(TabSelectRenderableEvents.SELECTION_CHANGED, () => {
    const provider = selectedValue<'openai' | 'gemini'>(imageProvider);
    const models = provider === 'gemini' ? geminiModels : openAIModels;
    imageModel.options = tabOptions(models);
    imageModel.setSelectedIndex(0);
    status.content = provider === 'gemini' ? 'Gemini ignores the OpenAI quality setting.' : 'OpenAI Image API selected.';
    status.fg = MUTED;
  });
  imageModel.on(TabSelectRenderableEvents.SELECTION_CHANGED, () => {
    if (selectedValue<string>(imageModel) === 'gpt-image-1.5') imageQuality.setSelectedIndex(1);
  });

  const save = (): void => {
    try {
      const next = applySettingsForm(config, {
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
      writeConfigFile(configPath, next);
      status.content = `Saved ${configPath}`;
      status.fg = OK;
    } catch (error) {
      status.content = (error as Error).message.replace(/\n/g, ' | ');
      status.fg = ERROR;
    }
  };

  renderer.keyInput.on('keypress', (key: KeyEvent) => {
    if (key.name === 'tab') {
      key.preventDefault();
      focusables[focusIndex]!.blur();
      focusIndex = (focusIndex + (key.shift ? -1 : 1) + focusables.length) % focusables.length;
      focusables[focusIndex]!.focus();
      return;
    }
    if (key.ctrl && key.name === 's') {
      key.preventDefault();
      save();
      return;
    }
    if (key.name === 'escape') {
      key.preventDefault();
      renderer.destroy();
    }
  });
}

run().catch((error) => {
  console.error(`modelhitch settings: ${(error as Error).message}`);
  process.exitCode = 1;
});
