// Bundled by test/browser/serve.mjs for the Playwright call tests: exposes the SDK on window.
import { CallClient } from "../../src/calls/index.js";
import { Chat } from "../../src/core/index.js";

(window as unknown as Record<string, unknown>).byotalk = { Chat, CallClient };
