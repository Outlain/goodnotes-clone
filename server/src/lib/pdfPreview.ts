import { execFile } from "node:child_process";
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { env } from "./env.js";
import { getPreviewDirectory, getPreviewImagePath, getUploadOptimizationMarkerPath } from "./storage.js";

const execFileAsync = promisify(execFile);
const previewGenerationTasks = new Map<string, Promise<string>>();

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function resolvePreviewWidth(requestedWidth: number): number {
  const safeRequestedWidth = Math.max(120, Math.min(1800, Math.round(requestedWidth)));
  const configuredWidths = new Set<number>([env.pdfThumbnailWidth, ...env.pdfPagePreviewWidths]);
  const sortedWidths = [...configuredWidths].sort((left, right) => left - right);
  const matchingWidth = sortedWidths.find((width) => width >= safeRequestedWidth);
  return matchingWidth ?? sortedWidths[sortedWidths.length - 1] ?? env.pdfThumbnailWidth;
}

export async function ensurePdfPreviewImage(storageKey: string, sourcePath: string, pageNumber: number, width: number): Promise<string> {
  const safeWidth = resolvePreviewWidth(width);
  const outputPath = getPreviewImagePath(storageKey, pageNumber, safeWidth);
  if (await exists(outputPath)) {
    return outputPath;
  }

  const existingTask = previewGenerationTasks.get(outputPath);
  if (existingTask) {
    return existingTask;
  }

  const outputDir = getPreviewDirectory(storageKey);
  await mkdir(outputDir, { recursive: true });

  const tempPrefix = path.join(outputDir, `tmp-${process.pid}-${Date.now()}-${pageNumber}-${safeWidth}`);
  const tempOutputPath = `${tempPrefix}.jpg`;

  const task = (async () => {
    try {
      await execFileAsync("pdftoppm", [
        "-jpeg",
        "-singlefile",
        "-f",
        String(pageNumber),
        "-l",
        String(pageNumber),
        "-scale-to",
        String(safeWidth),
        sourcePath,
        tempPrefix
      ], {
        timeout: 5 * 60 * 1000,
        maxBuffer: 1024 * 1024
      });
      await rename(tempOutputPath, outputPath);
      return outputPath;
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
      if (code === "ENOENT") {
        throw new Error("Server preview generation requires pdftoppm (poppler-utils) to be installed.");
      }
      throw error;
    } finally {
      previewGenerationTasks.delete(outputPath);
    }
  })();

  previewGenerationTasks.set(outputPath, task);
  return task;
}

export async function markUploadOptimized(storageKey: string): Promise<void> {
  const markerPath = getUploadOptimizationMarkerPath(storageKey);
  await mkdir(path.dirname(markerPath), { recursive: true });
  await writeFile(markerPath, new Date().toISOString(), "utf8");
}

export async function wasUploadOptimized(storageKey: string): Promise<boolean> {
  return exists(getUploadOptimizationMarkerPath(storageKey));
}
