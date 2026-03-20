import { mkdirSync } from "node:fs";
import { copyFile, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { env } from "./env.js";

export const uploadsDir = path.join(env.dataDir, "uploads");
export const tempUploadsDir = path.join(env.dataDir, "temp");
export const previewsDir = path.join(env.dataDir, "previews");

function ensureDirectories(): void {
  mkdirSync(env.dataDir, { recursive: true });
  mkdirSync(uploadsDir, { recursive: true });
  mkdirSync(tempUploadsDir, { recursive: true });
  mkdirSync(previewsDir, { recursive: true });
}

ensureDirectories();

export async function persistUploadedPdf(tempPath: string): Promise<{ storageKey: string; absolutePath: string }> {
  const storageKey = `${nanoid()}.pdf`;
  const absolutePath = path.join(uploadsDir, storageKey);

  try {
    await rename(tempPath, absolutePath);
  } catch {
    await copyFile(tempPath, absolutePath);
    await unlink(tempPath).catch(() => undefined);
  }

  return { storageKey, absolutePath };
}

export function getUploadPath(storageKey: string): string {
  return path.join(uploadsDir, storageKey);
}

export function getPreviewDirectory(storageKey: string): string {
  return path.join(previewsDir, storageKey.replace(/\.pdf$/i, ""));
}

export function getPreviewImagePath(storageKey: string, pageNumber: number, width: number): string {
  return path.join(getPreviewDirectory(storageKey), `page-${String(pageNumber).padStart(5, "0")}-w${width}.jpg`);
}

export function getUploadOptimizationMarkerPath(storageKey: string): string {
  return path.join(getPreviewDirectory(storageKey), ".optimized");
}

export async function removePreviewCacheForUpload(storageKey: string): Promise<void> {
  await rm(getPreviewDirectory(storageKey), { recursive: true, force: true });
}
