import 'package:flutter_test/flutter_test.dart';
import 'package:modelhitch_flutter/modelhitch_flutter.dart';

void main() {
  test('secure storage adapter implements the Dart core credential contract', () {
    expect(FlutterSecureKeyStore(), isA<KeyStore>());
  });
}