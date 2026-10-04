import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/core/index.ts", server: "src/server/index.ts", "react-native": "src/react-native/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    target: "es2022",
    external: ["react-native", "@react-native-community/netinfo", "react-native-mmkv", "@react-native-async-storage/async-storage"],
  },
  {
    entry: { cli: "src/cli/index.ts" },
    format: ["esm"],
    platform: "node",
    target: "node22",
    banner: { js: "#!/usr/bin/env node" },
    external: ["pg", "mysql2", "mysql2/promise", "mongodb"],
  },
]);
