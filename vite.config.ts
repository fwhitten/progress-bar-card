import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2021",
    lib: {
      entry: "src/ha-progress-card.ts",
      formats: ["es"],
      fileName: () => "ha-progress-card.js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
    minify: "esbuild",
    emptyOutDir: true,
  },
});
