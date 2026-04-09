export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown, attemptNumber: number) => boolean;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export async function withRetry<T>(
  operation: (attemptNumber: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const shouldRetry = options.shouldRetry ?? (() => true);

  let lastError: unknown;

  for (let attemptNumber = 1; attemptNumber <= attempts; attemptNumber += 1) {
    try {
      return await operation(attemptNumber);
    } catch (error) {
      lastError = error;

      if (attemptNumber >= attempts || !shouldRetry(error, attemptNumber)) {
        throw error;
      }

      const delayMs = Math.min(
        baseDelayMs * 2 ** (attemptNumber - 1),
        maxDelayMs,
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}
