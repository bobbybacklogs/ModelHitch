import 'dart:io';

import 'package:modelhitch_dart/modelhitch_dart.dart';

Future<void> main() async {
  final apiKey = Platform.environment['OPENAI_API_KEY'];
  if (apiKey == null || apiKey.isEmpty) {
    stderr.writeln('Set OPENAI_API_KEY before running this example.');
    exitCode = 2;
    return;
  }

  final hitch = ModelHitch(keyStore: MemoryKeyStore());
  await hitch.keyStore!.set('openai', apiKey);
  await for (final chunk in hitch.stream(
    ChatRequest(
      provider: 'openai',
      model: 'gpt-4o-mini',
      messages: [
        ModelMessage.user(MessageContent.text('Reply with one short greeting.'))
      ],
    ),
  )) {
    if (chunk case TextDelta(:final text)) stdout.write(text);
  }
  stdout.writeln();
}
