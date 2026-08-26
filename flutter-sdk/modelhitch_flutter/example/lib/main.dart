import 'package:flutter/material.dart';
import 'package:modelhitch_flutter/modelhitch_flutter.dart';

void main() => runApp(const ModelHitchExampleApp());

final class ModelHitchExampleApp extends StatelessWidget {
  const ModelHitchExampleApp({super.key});

  @override
  Widget build(BuildContext context) => const MaterialApp(home: ChatPage());
}

final class ChatPage extends StatefulWidget {
  const ChatPage({super.key});

  @override
  State<ChatPage> createState() => _ChatPageState();
}

final class _ChatPageState extends State<ChatPage> {
  final _keyController = TextEditingController();
  final _promptController = TextEditingController(text: 'Say hello from Flutter.');
  final _keys = FlutterSecureKeyStore();
  String _answer = '';
  String? _error;
  bool _pending = false;

  @override
  void dispose() {
    _keyController.dispose();
    _promptController.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final key = _keyController.text.trim();
    final prompt = _promptController.text.trim();
    if (key.isEmpty || prompt.isEmpty) return;
    setState(() {
      _pending = true;
      _answer = '';
      _error = null;
    });
    try {
      await _keys.set('openai', key);
      final hitch = ModelHitch(keyStore: _keys);
      await for (final chunk in hitch.stream(
        ChatRequest(
          provider: 'openai',
          model: 'gpt-4o-mini',
          messages: [ModelMessage.user(MessageContent.text(prompt))],
        ),
      )) {
        if (chunk case TextDelta(:final text)) {
          setState(() => _answer += text);
        }
      }
    } on ModelHitchException catch (error) {
      setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _pending = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('ModelHitch Flutter')),
        body: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(controller: _keyController, obscureText: true, decoration: const InputDecoration(labelText: 'OpenAI key')),
              TextField(controller: _promptController, minLines: 2, maxLines: 4, decoration: const InputDecoration(labelText: 'Prompt')),
              const SizedBox(height: 12),
              FilledButton(onPressed: _pending ? null : _send, child: Text(_pending ? 'Streaming...' : 'Send')),
              if (_error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_error!)),
              if (_answer.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_answer)),
            ],
          ),
        ),
      );
}