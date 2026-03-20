import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const libDir = path.dirname(currentFile);
const serverRoot = path.resolve(libDir, "..", "..");

function toNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProduction: (process.env.NODE_ENV ?? "development") === "production",
  port: toNumber(process.env.PORT, 3000),
  dataDir: path.resolve(process.env.DATA_DIR ?? path.join(serverRoot, "..", "data")),
  pdfUploadLimitMb: Math.max(25, toNumber(process.env.PDF_UPLOAD_LIMIT_MB, 512)),
  pdfLinearizeUploads: toBoolean(process.env.PDF_LINEARIZE_UPLOADS, true),
  pdfOptimizeExistingOnStartup: toBoolean(process.env.PDF_OPTIMIZE_EXISTING_ON_STARTUP, true),
  pdfPregeneratePreviewCount: Math.max(0, Math.min(24, toNumber(process.env.PDF_PREGENERATE_PREVIEW_COUNT, 8))),
  pdfThumbnailWidth: Math.max(120, Math.min(480, toNumber(process.env.PDF_THUMBNAIL_WIDTH, 240))),
  sessionSecret: process.env.SESSION_SECRET ?? "development-only-session-secret",
  appPassword: process.env.APP_PASSWORD?.trim() || "",
  publicDir: path.join(serverRoot, "public"),
  cookieName: "inkflow_session"
};
