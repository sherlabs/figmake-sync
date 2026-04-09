import { describe, expect, it } from "vitest";

import { withRetry } from "../src/utils/retry.js";

describe("withRetry", () => {
  it("returns the result immediately when the operation succeeds on the first attempt", async () => {
    const result = await withRetry(async () => "ok");

    expect(result).toBe("ok");
  });

  it("retries and returns the result when the operation eventually succeeds", async () => {
    let callCount = 0;

    const result = await withRetry(
      async () => {
        callCount += 1;

        if (callCount < 3) {
          throw new Error("transient");
        }

        return "success";
      },
      { attempts: 3, baseDelayMs: 0 },
    );

    expect(result).toBe("success");
    expect(callCount).toBe(3);
  });

  it("throws the last error after exhausting all attempts", async () => {
    let callCount = 0;

    await expect(
      withRetry(
        async () => {
          callCount += 1;
          throw new Error(`attempt ${callCount}`);
        },
        { attempts: 3, baseDelayMs: 0 },
      ),
    ).rejects.toThrow("attempt 3");

    expect(callCount).toBe(3);
  });

  it("stops retrying early when shouldRetry returns false", async () => {
    let callCount = 0;

    await expect(
      withRetry(
        async () => {
          callCount += 1;
          throw new Error("fatal");
        },
        {
          attempts: 5,
          baseDelayMs: 0,
          shouldRetry: () => false,
        },
      ),
    ).rejects.toThrow("fatal");

    expect(callCount).toBe(1);
  });

  it("passes the attempt number to the operation", async () => {
    const attemptNumbers: number[] = [];

    await withRetry(
      async (attemptNumber) => {
        attemptNumbers.push(attemptNumber);

        if (attemptNumber < 2) {
          throw new Error("not yet");
        }

        return "done";
      },
      { attempts: 3, baseDelayMs: 0 },
    );

    expect(attemptNumbers).toEqual([1, 2]);
  });

  it("passes the attempt number to shouldRetry", async () => {
    const seenAttempts: number[] = [];

    await expect(
      withRetry(
        async () => {
          throw new Error("always fails");
        },
        {
          attempts: 4,
          baseDelayMs: 0,
          shouldRetry: (_error, attemptNumber) => {
            seenAttempts.push(attemptNumber);
            return attemptNumber < 2;
          },
        },
      ),
    ).rejects.toThrow("always fails");

    expect(seenAttempts).toEqual([1, 2]);
  });

  it("respects a custom attempts count of 1 (no retries)", async () => {
    let callCount = 0;

    await expect(
      withRetry(
        async () => {
          callCount += 1;
          throw new Error("only once");
        },
        { attempts: 1, baseDelayMs: 0 },
      ),
    ).rejects.toThrow("only once");

    expect(callCount).toBe(1);
  });

  it("performs exponential back-off between attempts", async () => {
    const delays: number[] = [];
    let callCount = 0;

    // Patch the global setTimeout to record delay values without actually sleeping
    const originalSetTimeout = globalThis.setTimeout;
    // @ts-expect-error – deliberately patching for test observation
    globalThis.setTimeout = (fn: () => void, delay: number) => {
      delays.push(delay);
      return originalSetTimeout(fn, 0);
    };

    try {
      await expect(
        withRetry(
          async () => {
            callCount += 1;
            throw new Error("fail");
          },
          {
            attempts: 4,
            baseDelayMs: 100,
            maxDelayMs: 250,
          },
        ),
      ).rejects.toThrow("fail");
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    expect(callCount).toBe(4);
    expect(delays).toEqual([100, 200, 250]);
  });
});
