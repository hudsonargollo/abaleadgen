import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
const repo = fileURLToPath(new URL("../..", import.meta.url));
export default defineConfig({ root: repo, base: "/", plugins: [react(), tailwindcss()], resolve: { alias: { "@": repo + "src" } }, build: { outDir: "/tmp/gp-preview", emptyOutDir: true, rollupOptions: { input: repo + "test/preview/preview.html" } } });
