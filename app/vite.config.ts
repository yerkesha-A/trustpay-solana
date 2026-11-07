import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { buffer: "buffer/" },
    dedupe: ["react", "react-dom", "@solana/wallet-adapter-react"],
  },
  optimizeDeps: { include: ["buffer"] },
  define: { "process.env": {} },
});
