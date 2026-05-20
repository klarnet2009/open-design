import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ToolDevError } from "../src/lib/errors.js";
import { ensure } from "../src/lib/ensure.js";

describe("tools-dev error model", () => {
  it("keeps stable error codes and user-facing messages", () => {
    const error = ToolDevError.invalidOption("--timeout", "must be a positive number of seconds");

    assert.equal(error.name, "ToolDevError");
    assert.equal(error.code, "invalid-option");
    assert.equal(error.message, "--timeout must be a positive number of seconds");
    assert.deepEqual(error.details, { optionName: "--timeout" });
  });

  it("throws factory-created errors through ensure", () => {
    assert.throws(
      () => ensure(false).or(() => ToolDevError.unsupportedApp("mobile", ["daemon", "web", "desktop"])),
      (error) => {
        assert.ok(error instanceof ToolDevError);
        assert.equal(error.code, "unsupported-app");
        assert.match(error.message, /unsupported tools-dev app: mobile/);
        return true;
      },
    );
  });

  it("returns defined values without truthy coercion", () => {
    assert.equal(ensure.defined(0).or(() => ToolDevError.invalidOption("--zero", "should be accepted")), 0);
  });
});
