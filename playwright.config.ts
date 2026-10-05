import { defineConfig, devices } from "@playwright/test";

// Real-browser call tests against the local dev stack (api :3000, gateway :3001, media :3003, coturn :3478).
export default defineConfig({
  testDir: "test/browser",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:5180",
    permissions: ["camera", "microphone"],
    launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--auto-accept-this-tab-capture"] },
  },
  webServer: { command: "node test/browser/serve.mjs", url: "http://127.0.0.1:5180", reuseExistingServer: true },
});
