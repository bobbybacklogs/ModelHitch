abstract interface class KeyStore {
  Future<String?> get(String providerId);
  Future<void> set(String providerId, String apiKey);
  Future<void> delete(String providerId);
}

final class MemoryKeyStore implements KeyStore {
  final Map<String, String> _keys = {};

  @override
  Future<String?> get(String providerId) async => _keys[providerId];

  @override
  Future<void> set(String providerId, String apiKey) async {
    _keys[providerId] = apiKey;
  }

  @override
  Future<void> delete(String providerId) async {
    _keys.remove(providerId);
  }
}
