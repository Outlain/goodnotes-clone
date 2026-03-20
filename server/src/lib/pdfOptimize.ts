import { execFile } from "node:child_process";
import { rename, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { env } from "./env.js";

const execFileAsync = promisify(execFile);
const LINEARIZE_MIN_SIZE_BYTES = 24 * 1024 * 1024;

export async function maybeLinearizePdf(filePath: string, fileSize: number): Promise<void> {
  if (!env.pdfLinearizeUploads || fileSize < LINEARIZE_MIN_SIZE_BYTES) {
    return;
  }

  const tempOutputPath = path.join(
    path.dirname(filePath),
    `${path.basename(filePath, path.extname(filePath))}.linearized${path.extname(filePath)}`
  );

  try {
    await execFileAsync("qpdf", ["--linearize", filePath, tempOutputPath], {
      timeout: 5 * 60 * 1000,
      maxBuffer: 1024 * 1024
    });
    await rename(tempOutputPath, filePath);
  } catch (error) {
    await unlink(tempOutputPath).catch(() => undefined);
    const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";

    if (code === "ENOENT") {
      return;
    }

    console.warn("[Inkflow] PDF linearization skipped.", {
      filePath,
      error
    });
  }
}
