import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { createExpoModelHitch, type ModelMessage } from 'modelhitch-expo';
import { useChat, type UseChatOptions } from 'modelhitch-expo/react';

/**
 * ModelHitch for Expo — example app.
 *
 * Two connection modes, mirroring examples/byok-ui:
 *
 * 1. **Direct BYOK** (default) — chats straight from the device via
 *    `createExpoModelHitch`. The pasted API key is stored with
 *    `SecureStoreKeyStore` (Android Keystore / iOS keychain; localStorage on
 *    web) and never leaves the device. Works offline with the `mock` provider.
 * 2. **Bridge** — points at a ModelHitch bridge (`npx modelhitch bridge`),
 *    which holds the keys and speaks OpenAI-compatible /v1/chat/completions.
 *    Uses the `useChat` hook from `modelhitch-expo/react`.
 */

const DIRECT_PROVIDERS = [
  { id: 'mock', name: 'Mock (offline)', model: 'mock-model', needsKey: false },
  { id: 'openai', name: 'OpenAI', model: 'gpt-4o-mini', needsKey: true },
  { id: 'groq', name: 'Groq', model: 'llama-3.3-70b-versatile', needsKey: true },
] as const;

// The host machine's localhost differs on the Android emulator.
const DEFAULT_BRIDGE_URL =
  Platform.OS === 'android' ? 'http://10.0.2.2:3939/v1' : 'http://127.0.0.1:3939/v1';

type Mode = 'direct' | 'bridge';

export default function App() {
  const [mode, setMode] = useState<Mode>('direct');

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>ModelHitch · Expo</Text>
        <Text style={styles.subtitle}>Streaming BYOK AI on iOS, Android & web</Text>
        <View style={styles.tabs} accessibilityRole="tablist">
          {(['direct', 'bridge'] as const).map((m) => (
            <Pressable
              key={m}
              accessibilityRole="tab"
              accessibilityState={{ selected: mode === m }}
              onPress={() => setMode(m)}
              style={[styles.tab, mode === m && styles.tabActive]}
            >
              <Text style={[styles.tabText, mode === m && styles.tabTextActive]}>
                {m === 'direct' ? 'Direct BYOK' : 'Bridge'}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      {mode === 'direct' ? <DirectChat /> : <BridgeChat />}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Direct BYOK
// ---------------------------------------------------------------------------

function DirectChat() {
  // One client for the app's lifetime; the default keystore is
  // SecureStoreKeyStore (device-encrypted, localStorage fallback on web).
  const [mh] = useState(() => createExpoModelHitch());
  const [providerId, setProviderId] = useState<string>('mock');
  const [apiKey, setApiKey] = useState('');
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<ModelMessage[]>([]);
  const [pending, setPending] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const provider = DIRECT_PROVIDERS.find((p) => p.id === providerId) ?? DIRECT_PROVIDERS[0];

  // Load any stored key when the provider changes.
  useEffect(() => {
    let cancelled = false;
    void mh.keystore?.get(providerId).then((key) => {
      if (!cancelled) setApiKey(key ?? '');
    });
    return () => {
      cancelled = true;
    };
  }, [mh, providerId]);

  const submit = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    if (provider.needsKey && !apiKey.trim()) {
      setError(`Paste a ${provider.name} API key above — direct BYOK calls the provider straight from the device.`);
      return;
    }
    setDraft('');
    setError(null);
    // Store the pasted key in the device keychain (or clear it when emptied).
    if (provider.needsKey) {
      if (apiKey.trim()) await mh.keystore?.set(providerId, apiKey.trim());
      else await mh.keystore?.delete(providerId);
    }
    const history: ModelMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(history);
    setBusy(true);
    setPending('');
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const stream = await mh.stream({
        provider: providerId,
        messages: history,
        signal: controller.signal,
      });
      let acc = '';
      for await (const chunk of stream) {
        if (controller.signal.aborted) break;
        if (chunk.type === 'text-delta') {
          acc += chunk.text;
          setPending(acc);
        } else if (chunk.type === 'finish') {
          setMessages((prev) => [...prev, { role: 'assistant', content: acc }]);
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
      setPending('');
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.body}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.controls}>
        <View style={styles.row}>
          <Text style={styles.label}>Provider</Text>
          <View style={styles.pickerWrap}>
            {DIRECT_PROVIDERS.map((p) => (
              <Pressable
                key={p.id}
                onPress={() => setProviderId(p.id)}
                style={[styles.chip, providerId === p.id && styles.chipActive]}
              >
                <Text style={[styles.chipText, providerId === p.id && styles.chipTextActive]}>{p.name}</Text>
              </Pressable>
            ))}
          </View>
        </View>
        {provider.needsKey && (
          <TextInput
            style={styles.keyInput}
            value={apiKey}
            onChangeText={setApiKey}
            placeholder={`${provider.name} API key`}
            placeholderTextColor="#5b6672"
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
        )}
        <Text style={styles.status}>
          {provider.name} · {provider.model} · key stored on-device only
        </Text>
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.messages}
        contentContainerStyle={styles.messagesInner}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      >
        {messages.length === 0 && !pending && (
          <Text style={styles.empty}>
            Try the offline mock provider, or paste a key and pick a real one. Streaming replies
            arrive token-by-token via expo/fetch.
          </Text>
        )}
        {messages.map((m, i) => (
          <MessageBubble key={i} m={m} />
        ))}
        {pending !== '' && (
          <View style={[styles.bubble, styles.assistantBubble]}>
            <Text style={styles.assistantText}>{pending}<Text style={styles.caret}>▍</Text></Text>
          </View>
        )}
        {busy && pending === '' && (
          <View style={styles.thinking}>
            <ActivityIndicator color="#6c8cff" size="small" />
            <Text style={styles.thinkingText}>thinking…</Text>
          </View>
        )}
      </ScrollView>

      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>⚠ {error}</Text>
        </View>
      )}

      <View style={styles.inputBar}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder='Ask something… (mock echoes you)'
          placeholderTextColor="#5b6672"
          editable={!busy}
          onSubmitEditing={submit}
          returnKeyType="send"
        />
        {busy ? (
          <Pressable
            style={[styles.sendBtn, styles.stopBtn]}
            onPress={() => controllerRef.current?.abort()}
          >
            <Text style={styles.sendText}>Stop</Text>
          </Pressable>
        ) : (
          <Pressable style={[styles.sendBtn, !draft.trim() && styles.sendBtnDisabled]} onPress={submit} disabled={!draft.trim()}>
            <Text style={styles.sendText}>Send</Text>
          </Pressable>
        )}
        <Pressable style={styles.clearBtn} onPress={() => setMessages([])}>
          <Text style={styles.clearText}>Clear</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

function BridgeChat() {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BRIDGE_URL);
  const [model, setModel] = useState('mock-model');
  const [draft, setDraft] = useState('');

  const options: UseChatOptions = {
    baseUrl,
    model,
    systemPrompt: 'You are a helpful assistant.',
  };
  const { messages, pending, isThinking, error, usage, send, reset, cancel } = useChat(options);

  const submit = () => {
    const text = draft.trim();
    if (!text || isThinking) return;
    setDraft('');
    void send(text);
  };

  return (
    <KeyboardAvoidingView
      style={styles.body}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.controls}>
        <Text style={styles.label}>Bridge URL</Text>
        <TextInput
          style={styles.keyInput}
          value={baseUrl}
          onChangeText={setBaseUrl}
          placeholder="http://127.0.0.1:3939/v1"
          placeholderTextColor="#5b6672"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Text style={styles.label}>Model</Text>
        <TextInput
          style={styles.keyInput}
          value={model}
          onChangeText={setModel}
          placeholder="mock-model"
          placeholderTextColor="#5b6672"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Text style={styles.status}>
          bridge: {baseUrl} · model: {model} · {usage ? `tokens: ${usage.totalTokens ?? '?'}` : 'no usage yet'}
        </Text>
      </View>

      <ScrollView
        style={styles.messages}
        contentContainerStyle={styles.messagesInner}
      >
        {messages.map((m, i) => (
          <MessageBubble key={i} m={m} />
        ))}
        {pending !== null && (
          <View style={[styles.bubble, styles.assistantBubble]}>
            <Text style={styles.assistantText}>
              {pending || (isThinking ? '…' : '')}
              {pending ? <Text style={styles.caret}>▍</Text> : null}
            </Text>
          </View>
        )}
      </ScrollView>

      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>⚠ {error.message}</Text>
        </View>
      )}

      <View style={styles.inputBar}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Message the bridge…"
          placeholderTextColor="#5b6672"
          editable={!isThinking}
          onSubmitEditing={submit}
          returnKeyType="send"
        />
        {isThinking ? (
          <Pressable style={[styles.sendBtn, styles.stopBtn]} onPress={cancel}>
            <Text style={styles.sendText}>Stop</Text>
          </Pressable>
        ) : (
          <Pressable style={[styles.sendBtn, !draft.trim() && styles.sendBtnDisabled]} onPress={submit} disabled={!draft.trim()}>
            <Text style={styles.sendText}>Send</Text>
          </Pressable>
        )}
        <Pressable style={styles.clearBtn} onPress={reset}>
          <Text style={styles.clearText}>Clear</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function MessageBubble({ m }: { m: ModelMessage }) {
  if (m.role === 'user') {
    const content = typeof m.content === 'string' ? m.content : '[multimodal]';
    return (
      <View style={[styles.bubble, styles.userBubble]}>
        <Text style={styles.userText}>{content}</Text>
      </View>
    );
  }
  if (m.role === 'assistant') {
    const content = typeof m.content === 'string' ? m.content : '[multimodal]';
    const toolCalls = m.toolCalls?.map((t) => `⚙ ${t.name}(${JSON.stringify(t.arguments)})`).join('\n');
    return (
      <View style={[styles.bubble, styles.assistantBubble]}>
        {content !== '' && <Text style={styles.assistantText}>{content}</Text>}
        {toolCalls ? <Text style={styles.toolText}>{toolCalls}</Text> : null}
      </View>
    );
  }
  return null;
}

const palette = {
  bg: '#0b0f14',
  surface: '#141a22',
  surface2: '#1a2230',
  border: '#232b36',
  accent: '#6c8cff',
  accentDim: '#3b4a7a',
  text: '#e6edf3',
  muted: '#8b98a5',
  danger: '#f87171',
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: palette.bg,
    paddingTop: Platform.OS === 'web' ? 24 : 56,
  },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
  },
  title: {
    color: palette.text,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  subtitle: {
    color: palette.muted,
    fontSize: 13,
    marginTop: 2,
  },
  tabs: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 14,
  },
  tab: {
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: palette.border,
  },
  tabActive: {
    backgroundColor: palette.accentDim,
    borderColor: palette.accent,
  },
  tabText: {
    color: palette.muted,
    fontSize: 13,
    fontWeight: '600',
  },
  tabTextActive: {
    color: palette.text,
  },
  body: {
    flex: 1,
  },
  controls: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
    gap: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  label: {
    color: palette.muted,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  pickerWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.surface,
  },
  chipActive: {
    borderColor: palette.accent,
    backgroundColor: palette.accentDim,
  },
  chipText: {
    color: palette.muted,
    fontSize: 12,
    fontWeight: '600',
  },
  chipTextActive: {
    color: palette.text,
  },
  keyInput: {
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: palette.text,
    fontSize: 14,
  },
  status: {
    color: palette.muted,
    fontSize: 12,
  },
  messages: {
    flex: 1,
  },
  messagesInner: {
    padding: 20,
    gap: 10,
  },
  empty: {
    color: palette.muted,
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
    paddingVertical: 40,
    paddingHorizontal: 24,
  },
  bubble: {
    maxWidth: '85%',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  userBubble: {
    alignSelf: 'flex-end',
    backgroundColor: palette.accent,
    borderBottomRightRadius: 4,
  },
  userText: {
    color: '#0b0f14',
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '500',
  },
  assistantBubble: {
    alignSelf: 'flex-start',
    backgroundColor: palette.surface2,
    borderWidth: 1,
    borderColor: palette.border,
    borderBottomLeftRadius: 4,
  },
  assistantText: {
    color: palette.text,
    fontSize: 15,
    lineHeight: 21,
  },
  toolText: {
    color: palette.accent,
    fontSize: 13,
    marginTop: 6,
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
  },
  caret: {
    color: palette.accent,
  },
  thinking: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
  },
  thinkingText: {
    color: palette.muted,
    fontSize: 13,
  },
  errorBanner: {
    marginHorizontal: 20,
    marginBottom: 8,
    backgroundColor: 'rgba(248,113,113,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.4)',
    borderRadius: 10,
    padding: 10,
  },
  errorText: {
    color: palette.danger,
    fontSize: 13,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: palette.border,
  },
  input: {
    flex: 1,
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: palette.text,
    fontSize: 15,
  },
  sendBtn: {
    backgroundColor: palette.accent,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  sendBtnDisabled: {
    opacity: 0.4,
  },
  stopBtn: {
    backgroundColor: palette.danger,
  },
  sendText: {
    color: '#0b0f14',
    fontWeight: '700',
    fontSize: 14,
  },
  clearBtn: {
    paddingHorizontal: 6,
    paddingVertical: 11,
  },
  clearText: {
    color: palette.muted,
    fontSize: 13,
    fontWeight: '600',
  },
});