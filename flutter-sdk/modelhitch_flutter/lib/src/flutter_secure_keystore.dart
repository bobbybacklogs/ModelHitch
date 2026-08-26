import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:modelhitch_dart/modelhitch_dart.dart';

/// Stores end-user provider keys in the platform's encrypted credential store.
///
/// Do not use this for an application-owned provider credential. Route those
/// requests through your backend or a ModelHitch bridge instead.
final class FlutterSecureKeyStore implements KeyStore {
  FlutterSecureKeyStore({FlutterSecureStorage? storage, String keyPrefix = 'modelhitch.credentials.'})
      : _storage = storage ?? const FlutterSecureStorage(),
        _keyPrefix = keyPrefix;

  final FlutterSecureStorage _storage;
  final String _keyPrefix;

  String _keyFor(String providerId) => '$_keyPrefix$providerId';

  @override
  Future<String?> get(String providerId) => _storage.read(key: _keyFor(providerId));

  @override
  Future<void> set(String providerId, String apiKey) => _storage.write(key: _keyFor(providerId), value: apiKey);

  @override
  Future<void> delete(String providerId) => _storage.delete(key: _keyFor(providerId));
}