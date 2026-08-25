package com.genoventureslabs.modelhitch

enum class ModelHitchErrorCode(val wireValue: String) {
    MISSING_API_KEY("missing-api-key"),
    INVALID_API_KEY("invalid-api-key"),
    RATE_LIMITED("rate-limited"),
    MODEL_NOT_FOUND("model-not-found"),
    PROVIDER_NOT_FOUND("provider-not-found"),
    PROVIDER_ERROR("provider-error"),
    NETWORK_ERROR("network-error"),
    BAD_REQUEST("bad-request"),
}

class ModelHitchException(
    val code: ModelHitchErrorCode,
    message: String,
    val status: Int? = null,
    val providerId: String? = null,
    val retryAfterMillis: Long? = null,
    cause: Throwable? = null,
) : Exception(message, cause)