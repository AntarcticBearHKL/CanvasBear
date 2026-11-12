import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/",
  plugins: [react()],
  server: {
    watch: {
      ignored: ["**/release/**", "**/release-*/**", "**/mcp/.venv/**"],
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
