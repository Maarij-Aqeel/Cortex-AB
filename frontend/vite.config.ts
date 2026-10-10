import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// In dev, /api is proxied to the backend. Set TRIBE_API_URL in frontend/.env.local
// (see .env.example) or inline: TRIBE_API_URL=https://... npm run dev
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = process.env.TRIBE_API_URL ?? env.TRIBE_API_URL;

  return {
    plugins: [react()],
    build: { chunkSizeWarningLimit: 1000 }, // three.js is most of the bundle
    server: {
      proxy: apiTarget ? { "/api": { target: apiTarget, changeOrigin: true } } : undefined,
    },
  };
});
