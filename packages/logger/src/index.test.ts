import { describe, expect, it } from "vitest";
import { LOGGER_PACKAGE } from "./index.js";

describe("@triage/logger scaffold", () => {
  it("exports its package name", () => {
    expect(LOGGER_PACKAGE).toBe("@triage/logger");
  });
});
