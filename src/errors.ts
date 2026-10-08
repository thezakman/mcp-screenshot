export class ScreenshotError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}
export function failure(error: unknown) {
  if (error instanceof ScreenshotError)
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  const message = error instanceof Error ? error.message : String(error);
  const match = /^([A-Z_]+):\s*(.*)$/s.exec(message);
  return {
    code: match?.[1] ?? "CAPTURE_FAILED",
    message: match?.[2] ?? message,
    retryable: false,
  };
}
