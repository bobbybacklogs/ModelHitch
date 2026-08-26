enum ModelHitchErrorCode {
  missingApiKey,
  invalidApiKey,
  rateLimited,
  modelNotFound,
  providerNotFound,
  providerError,
  networkError,
  badRequest,
}

final class ModelHitchException implements Exception {
  const ModelHitchException({
    required this.code,
    required this.message,
    this.status,
    this.providerId,
    this.retryAfter,
    this.cause,
  });

  final ModelHitchErrorCode code;
  final String message;
  final int? status;
  final String? providerId;
  final Duration? retryAfter;
  final Object? cause;

  @override
  String toString() => 'ModelHitchException($code): $message';
}
