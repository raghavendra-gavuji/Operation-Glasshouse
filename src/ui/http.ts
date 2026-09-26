export function apiErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error" in body) {
    if (typeof body.error === "string" && body.error.trim()) return body.error;
    if (body.error && typeof body.error === "object" && "message" in body.error && typeof body.error.message === "string" && body.error.message.trim()) return body.error.message;
  }
  return `The server returned HTTP ${status}.`;
}

export async function readApiError(response: Response): Promise<string> {
  try {
    return apiErrorMessage(await response.json(), response.status);
  } catch {
    return `The server returned HTTP ${response.status} without a readable error response.`;
  }
}
