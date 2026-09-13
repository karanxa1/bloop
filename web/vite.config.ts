import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  // envDir "." resolves against the vite root (web/) — avoids needing node types for __dirname
  const env = loadEnv(mode, ".", "");
  const apiTarget = env.BLOOP_API ?? "http://localhost:8787";
  return {
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true
        },
        "/files": {
          target: apiTarget,
          changeOrigin: true
        }
      }
    }
  };
});
