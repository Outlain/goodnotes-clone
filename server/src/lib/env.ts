import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const libDir = path.dirname(currentFile);
const serverRoot = path.resolve(libDir, "..", "..");

function toNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProduction: (process.env.NODE_ENV ?? "development") === "production",
  port: toNumber(process.env.PORT, 3000),
  dataDir: path.resolve(process.env.DATA_DIR ?? path.join(serverRoot, "..", "data")),
  sessionSecret: process.env.SESSION_SECRET ?? "development-only-session-secret",
  appPassword: process.env.APP_PASSWORD?.trim() || "",
  publicDir: path.join(serverRoot, "public"),
  cookieName: "inkflow_session"
};

