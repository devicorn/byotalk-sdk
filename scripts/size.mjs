// Bundle-size budget (docs/09 §1): the core import must stay ≤ 25 KB gzip with zero dependencies.
import { build } from "esbuild";
import { gzipSync } from "node:zlib";

const BUDGET = 25 * 1024;
const out = await build({ entryPoints: ["src/core/index.ts"], bundle: true, minify: true, format: "esm", write: false, platform: "neutral" });
const size = gzipSync(out.outputFiles[0].contents).length;
console.log(`core: ${(size / 1024).toFixed(1)} KB gzip (budget ${BUDGET / 1024} KB)`);
if (size > BUDGET) process.exit(1);
