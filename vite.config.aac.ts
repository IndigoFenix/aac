import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client-aac", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  root: path.resolve(import.meta.dirname, "client-aac"),
  // Electron build uses relative paths; web production uses /aac/; dev uses /
  base: process.env.ELECTRON_BUILD === "1" ? "./" : process.env.NODE_ENV === "production" ? "/aac/" : "/",
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public-aac"),
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    host: "0.0.0.0",
  },
});
