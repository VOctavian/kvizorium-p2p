import { join } from "node:path";
import { startServer } from "./index.ts";

const here = import.meta.dirname;
// In dev (tsx) `here` is apps/server/src, in the bundle it is apps/server/dist.
const root = join(here, "..", "..", "..");

const argPort = process.argv.indexOf("--port");
startServer({
  port: Number(argPort > 0 ? process.argv[argPort + 1] : process.env.PORT) || 8787,
  host: process.env.HOST,
  staticDir: process.env.KVZ_STATIC ?? join(root, "apps", "web", "dist"),
  packsDir: process.env.KVZ_PACKS ?? join(root, "packs"),
  dataDir: process.env.KVZ_DATA,
  persist: process.env.KVZ_PERSIST !== "0",
  trustProxy: process.env.KVZ_TRUST_PROXY === "1",
  maxPerIp: Number(process.env.KVZ_MAX_PER_IP) || undefined,
}).then((srv) => {
  // A restart (deploy, Ctrl+C) saves the rooms first; the next start brings them back.
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    srv.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
