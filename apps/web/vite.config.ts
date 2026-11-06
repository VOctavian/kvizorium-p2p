import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const target = process.env.KVZ_SERVER ?? "http://localhost:8787";
const packsDir = fileURLToPath(new URL("../../packs", import.meta.url));

/** Built-in packs and their names, read from content.xml. */
async function packList(): Promise<{ id: string; name: string }[]> {
  if (!existsSync(packsDir)) return [];
  const out: { id: string; name: string }[] = [];
  for (const id of readdirSync(packsDir).filter((f) => f.toLowerCase().endsWith(".siq"))) {
    try {
      const zip = await JSZip.loadAsync(readFileSync(`${packsDir}/${id}`));
      const xml = (await zip.file(/^content\.xml$/i)[0]?.async("string")) ?? "";
      const raw = /<package\b[^>]*\bname="([^"]*)"/.exec(xml)?.[1] ?? id;
      const name = raw.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
      out.push({ id, name });
    } catch { /* not a pack */ }
  }
  return out;
}

/**
 * Peer mode has no game server: the built-in packs are plain files of the site (packs/*.siq plus
 * packs/index.json), served by Vite in dev and copied into the build.
 */
function peerPacks(): Plugin {
  return {
    name: "kvz-peer-packs",
    configureServer(server) {
      server.middlewares.use("/packs", (req, res, next) => {
        const name = decodeURIComponent((req.url ?? "/").replace(/^\//, "").split("?")[0]);
        if (name === "index.json") {
          void packList().then((list) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(list)); });
          return;
        }
        const file = `${packsDir}/${name}`;
        if (!/^[^/\\]+\.siq$/i.test(name) || !existsSync(file)) return next();
        res.setHeader("Content-Type", "application/octet-stream");
        res.end(readFileSync(file));
      });
    },
    async generateBundle() {
      const list = await packList();
      for (const p of list) this.emitFile({ type: "asset", fileName: `packs/${p.id}`, source: readFileSync(`${packsDir}/${p.id}`) });
      this.emitFile({ type: "asset", fileName: "packs/index.json", source: JSON.stringify(list) });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === "p2p" ? [peerPacks()] : [])],
  base: "./",
  server: {
    port: 5173,
    proxy: mode === "p2p" ? undefined : {
      "/ws": { target, ws: true },
      "/api": target,
      "/media": target,
      "/avatar": target,
    },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 900 },
  // ffmpeg.wasm (converting WMV and the like) starts its own worker: Vite must leave it as it is.
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"] },
  worker: { format: "es" as const },
}));
