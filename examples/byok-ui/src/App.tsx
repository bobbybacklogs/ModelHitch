import { useEffect, useState } from 'react';
import { useChat, type UseChatOptions } from 'modelhitch/react';
import {
  LocalStorageKeyStore,
  ModelHitch,
  type ModelMessage,
  type ToolDefinition,
} from 'modelhitch';

/**
 * BYOK chat UI with two modes:
 *
 * 1. **Bridge** (default) — points at a local ModelHitch bridge (see
 *    `server.ts` in this folder — run it with `npm run server`), which holds
 *    the keys and speaks OpenAI-compatible /v1/chat/completions. The hooks
 *    then stream replies and drive multi-turn tool calls automatically.
 * 2. **Direct BYOK** — chats straight from the browser via the `modelhitch`
 *    browser build. The pasted API key is stored in localStorage through
 *    `LocalStorageKeyStore` and never leaves the user's device. Works offline
 *    with the `mock` provider.
 *
 * Swap `model` for any provider/model the bridge routes, e.g.
 * "vercel-ai-gateway/openai/gpt-5.4" with a real bridge + keys.
 */

const BRIDGE_URL = import.meta.env.VITE_BRIDGE_URL ?? 'http://127.0.0.1:3939/v1';
const MODEL = import.meta.env.VITE_BRIDGE_MODEL ?? 'mock-model';

const weatherTool: ToolDefinition = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'City name, e.g. "london"' },
    },
    required: ['q'],
  },
};

const chatOptions: UseChatOptions = {
  baseUrl: BRIDGE_URL,
  model: MODEL,
  systemPrompt: 'You are a helpful assistant. Use the get_weather tool when the user asks about weather.',
  tools: [weatherTool],
  executeTool: async (name, args) => {
    // In a real app this would call your own backend — never put keys in the
    // browser. For the demo we fake a forecast.
    if (name === 'get_weather') {
      const city = (args as { q?: string }).q ?? 'somewhere';
      return JSON.stringify({ city, temp_c: 18, condition: 'Sunny' });
    }
    return JSON.stringify({ error: `unknown tool ${name}` });
  },
};

type Mode = 'bridge' | 'direct';

export function App() {
  const [mode, setMode] = useState<Mode>('bridge');
  return (
    <main>
      <h1>ModelHitch BYOK UI</h1>
      <div className="tabs" role="tablist" aria-label="Connection mode">
        <button
          className={mode === 'bridge' ? 'tab active' : 'tab'}
          role="tab"
          aria-selected={mode === 'bridge'}
          onClick={() => setMode('bridge')}
        >
          Bridge
        </button>
        <button
          className={mode === 'direct' ? 'tab active' : 'tab'}
          role="tab"
          aria-selected={mode === 'direct'}
          onClick={() => setMode('direct')}
        >
          Direct BYOK
        </button>
      </div>
      {mode === 'bridge' ? <BridgeChat /> : <DirectChat />}
    </main>
  );
}

function BridgeChat() {
  const { messages, pending, activeTool, isThinking, error, usage, send, reset, cancel } = useChat(chatOptions);
  const [draft, setDraft] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void send(draft);
    setDraft('');
  };

  return (
    <>
      <p className="status">
        bridge: {BRIDGE_URL} · model: {MODEL} · {usage ? `tokens: ${usage.totalTokens ?? '?'}` : 'no usage yet'}
      </p>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {messages.map((m, i) => <Message key={i} m={m} />)}
        {pending !== null && (
          <div className="msg assistant">
            {pending || (isThinking ? '…' : '')}
          </div>
        )}
        {activeTool && <div className="tool">⚙ calling {activeTool}…</div>}
      </div>

      {error && <p className="status" style={{ color: '#dc2626' }}>⚠ {error.message}</p>}

      <form onSubmit={submit}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder='Try: "What is the weather in london?"'
          disabled={isThinking}
        />
        <button type="submit" disabled={isThinking || !draft.trim()}>
          {isThinking ? '…' : 'Send'}
        </button>
        <button type="button" onClick={cancel} disabled={!isThinking}>Stop</button>
        <button type="button" onClick={reset}>Clear</button>
      </form>
    </>
  );
}

/** Providers the direct-BYOK mode can reach straight from the browser. */
const DIRECT_PROVIDERS = [
  { id: 'openai', name: 'OpenAI', model: 'gpt-4o-mini' },
  { id: 'openrouter', name: 'OpenRouter', model: 'meta-llama/llama-3.1-8b-instruct:free' },
  { id: 'mock', name: 'Mock (offline)', model: 'mock-model' },
] as const;

function DirectChat() {
  const [mh] = useState(() => new ModelHitch({ keystore: new LocalStorageKeyStore() }));
  const [providerId, setProviderId] = useState<string>('mock');
  const [apiKey, setApiKey] = useState('');
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<ModelMessage[]>([]);
  const [pending, setPending] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const provider = DIRECT_PROVIDERS.find((p) => p.id === providerId) ?? DIRECT_PROVIDERS[0];
  const needsKey = provider.id !== 'mock';

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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    if (needsKey && !apiKey.trim()) {
      setError(`Paste a ${provider.name} API key above — direct BYOK calls the provider straight from the browser.`);
      return;
    }
    setDraft('');
    setError(null);
    // Store the pasted key in localStorage (or clear it when emptied) — never
    // a server key in this bundle.
    if (needsKey) {
      if (apiKey.trim()) await mh.keystore?.set(providerId, apiKey.trim());
      else await mh.keystore?.delete(providerId);
    }
    const history: ModelMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(history);
    setBusy(true);
    setPending('');
    try {
      const stream = await mh.stream({ provider: providerId, messages: history });
      let acc = '';
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') {
          acc += chunk.text;
          setPending(acc);
        } else if (chunk.type === 'finish') {
          setMessages((prev) => [...prev, { role: 'assistant', content: acc }]);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setPending('');
    }
  };

  return (
    <>
      <p className="status">
        direct: {provider.name} · model: {provider.model} · key stored in localStorage only
      </p>

      <div className="row">
        <select value={providerId} onChange={(e) => setProviderId(e.target.value)} aria-label="Provider">
          {DIRECT_PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        {needsKey && (
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={`${provider.name} API key`}
            aria-label="API key"
          />
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {messages.map((m, i) => <Message key={i} m={m} />)}
        {pending !== '' && <div className="msg assistant">{pending}</div>}
      </div>

      {error && <p className="status" style={{ color: '#dc2626' }}>⚠ {error}</p>}

      <form onSubmit={submit}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={provider.id === 'mock' ? 'Try: "hello from the browser"' : 'Type a message…'}
          disabled={busy}
        />
        <button type="submit" disabled={busy || !draft.trim()}>
          {busy ? '…' : 'Send'}
        </button>
        <button type="button" onClick={() => setMessages([])} disabled={busy}>Clear</button>
      </form>
    </>
  );
}

function Message({ m }: { m: ModelMessage }) {
  if (m.role === 'system') return <div className="tool">system: {m.content as string}</div>;
  if (m.role === 'tool') return <div className="tool">tool {m.toolCallId}: {m.content as string}</div>;
  if (m.role === 'assistant') {
    return (
      <>
        <div className="msg assistant">{m.content as string}</div>
        {m.toolCalls?.map((tc) => (
          <div className="tool" key={tc.id}>⚙ {tc.name}({JSON.stringify(tc.arguments)})</div>
        ))}
      </>
    );
  }
  return <div className="msg user">{m.content as string}</div>;
}
