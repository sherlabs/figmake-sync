import { describe, expect, it } from "vitest";

import { isPlaywrightBrowserMissingError } from "../src/browser/install.js";
import {
  AuthRequiredError,
  ProfileInUseError,
  isLoginUrl,
  probeLoginState,
} from "../src/browser/session.js";

describe("browser session helpers", () => {
  it("detects figma login urls", () => {
    expect(isLoginUrl("https://www.figma.com/login?x=1")).toBe(true);
    expect(isLoginUrl("https://www.figma.com/files/recent")).toBe(false);
    expect(isLoginUrl("https://example.com/login")).toBe(false);
    expect(isLoginUrl("not a url")).toBe(false);
  });

  it("does not treat generic launch errors as missing browser", () => {
    expect(
      isPlaywrightBrowserMissingError(
        new Error("browserType.launchPersistentContext: profile in use"),
      ),
    ).toBe(false);
  });

  it("typed errors keep names", () => {
    expect(new AuthRequiredError().name).toBe("AuthRequiredError");
    expect(new ProfileInUseError("/x").message).toContain("/x");
  });

  it("probe reports unauthenticated for missing profile", async () => {
    const result = await probeLoginState("/nonexistent/figmake-profile-xyz");
    expect(result.authenticated).toBe(false);
  });
});
