/// <reference types="vitest/config" />
import { builtinModules } from "module";
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";
import pkg from "./package.json";

export default defineConfig({
  plugins: [
    dts({
      insertTypesEntry: true,
      include: ["src"],
    }),
  ],

  resolve: {
    tsconfigPaths: true,
  },

  build: {
    minify: false,
    lib: {
      entry: "src/index.ts",
      name: "@mi8y/cap-agents-cmis-backend",
      fileName: "index",
      formats: ["es", "cjs"],
    },
    sourcemap: true,
    rolldownOptions: {
      external: [
        ...builtinModules,
        ...builtinModules.map((module) => `node:${module}`),
        ...Object.keys(pkg.dependencies || {}),
        ...Object.keys(pkg.peerDependencies || {}),
      ],
    },
  },

  test: {
    name: "cap-agents-cmis-backend",
    globals: true,
    root: import.meta.dirname,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
    },
  },
});
