export class ServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("status" in error && typeof error.status === "number") return error.status;
  if ("statusCode" in error && typeof error.statusCode === "number") return error.statusCode;
  return undefined;
}

export function providerError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  const status = errorStatus(error);
  if (status === 401 || status === 403) {
    return new ServiceError(502, "GEMINI_AUTH", "Gemini rejected the server credentials or model access. Check the server configuration.");
  }
  if (status === 404) {
    return new ServiceError(502, "GEMINI_MODEL", "The configured Gemini model is unavailable for this API. No substitute model was used.");
  }
  if (status === 400) {
    return new ServiceError(502, "GEMINI_REQUEST", "Gemini rejected the request format or configuration. Check the configured model and supported request schema.");
  }
  if (status === 429) {
    return new ServiceError(429, "GEMINI_QUOTA", "Gemini's quota or rate limit was reached. Wait before explicitly trying again.", true);
  }
  if (status === 408 || status === 504 || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))) {
    return new ServiceError(504, "GEMINI_TIMEOUT", "The Gemini request timed out or was cancelled. You can continue using text or practice mode.", true);
  }
  return new ServiceError(502, "GEMINI_UNAVAILABLE", "The Gemini request failed. You can explicitly retry or continue in practice mode.", true);
}

export function safeLog(operation: string, error: unknown): void {
  const code = error instanceof ServiceError ? error.code : "UNEXPECTED_ERROR";
  console.warn(`[glasshouse] ${operation}: ${code}`, { status: errorStatus(error) ?? 500 });
}

export function invalidResponse(): ServiceError {
  return new ServiceError(502, "GEMINI_RESPONSE_INVALID", "Gemini returned an invalid or incomplete response. No game changes were applied.", true);
}
