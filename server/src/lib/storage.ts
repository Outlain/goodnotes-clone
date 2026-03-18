import { mkdirSync } from "node:fs";
import { copyFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { env } from "./env.js";

export const uploadsDir = path.join(env.dataDir, "uploads");
export const tempUploadsDir = path.join(env.dataDir, "temp");

function ensureDirectories(): void {
  mkdirSync(env.dataDir, { recursive: true });
  mkdirSync(uploadsDir, { recursive: true });
  mkdirSync(tempUploadsDir, { recursive: true });
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

