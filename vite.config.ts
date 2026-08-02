import { defineConfig } from "vite";

// BASE_PATH lets the same build serve from a GitHub Pages project subpath.
export default defineConfig({
  base: process.env.BASE_PATH ?? "./",
  build: {
    target: "es2020",
    assetsInlineLimit: 0,
  },
  // Jagex's hiscores and RuneMetrics endpoints send no CORS headers, so the browser
  // blocks direct calls. The dev server proxies them instead.
  server: {
    // Alt1 registers the app against 127.0.0.1, and "localhost" can bind IPv6
    // only, which leaves that address refusing connections.
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/rs-hiscores": {
        target: "https://secure.runescape.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/rs-hiscores/, "/m=hiscore/index_lite.ws"),
      },
      "/rs-runemetrics": {
        target: "https://apps.runescape.com",
        changeOrigin: true,
        rewrite: (path) =>
          path.replace(/^\/rs-runemetrics/, "/runemetrics/profile/profile"),
      },
      // Weird Gloop RS3 GE latest prices (batch by ?name=A|B|C).
      "/ge-price": {
        target: "https://api.weirdgloop.org",
        changeOrigin: true,
        rewrite: (path) =>
          path.replace(/^\/ge-price/, "/exchange/history/rs/latest"),
      },
    },
  },
});
