import { env } from "./env.js";
import { listStoredFiles } from "./db.js";
import { maybeLinearizePdf } from "./pdfOptimize.js";
import { ensurePdfPreviewImage, markUploadOptimized, wasUploadOptimized } from "./pdfPreview.js";
import { getUploadPath } from "./storage.js";

type StoredFileRecord = ReturnType<typeof listStoredFiles>[number];

const queuedStorageKeys = new Set<string>();
const pendingQueue: StoredFileRecord[] = [];
let workerRunning = false;

async function optimizeStoredFile(file: StoredFileRecord): Promise<void> {
  const sourcePath = getUploadPath(file.storageKey);
  const previewWidths = [...new Set([env.pdfThumbnailWidth, ...env.pdfPagePreviewWidths])].sort((left, right) => left - right);

  try {
    const alreadyOptimized = await wasUploadOptimized(file.storageKey);
    if (!alreadyOptimized) {
      await maybeLinearizePdf(sourcePath, file.size);
    }

    const previewCount = Math.min(env.pdfPregeneratePreviewCount, file.pageCount);
    for (let pageNumber = 1; pageNumber <= previewCount; pageNumber += 1) {
      for (const previewWidth of previewWidths) {
        await ensurePdfPreviewImage(file.storageKey, sourcePath, pageNumber, previewWidth);
      }
    }

    if (!alreadyOptimized) {
      await markUploadOptimized(file.storageKey);
    }
  } catch (error) {
    console.warn("[Inkflow] Background PDF optimization skipped for file.", {
      fileId: file.id,
      storageKey: file.storageKey,
      error
    });
  }
}

async function runQueue(): Promise<void> {
  if (workerRunning) {
    return;
  }

  workerRunning = true;
  try {
    while (pendingQueue.length > 0) {
      const nextFile = pendingQueue.shift();
      if (!nextFile) {
        continue;
      }

      queuedStorageKeys.delete(nextFile.storageKey);
      await optimizeStoredFile(nextFile);
    }
  } finally {
    workerRunning = false;
  }
}

export function enqueuePdfOptimization(file: StoredFileRecord): void {
  if (queuedStorageKeys.has(file.storageKey)) {
    return;
  }

  queuedStorageKeys.add(file.storageKey);
  pendingQueue.push(file);
  void runQueue();
}

export function startBackgroundPdfMaintenance(): void {
  if (!env.pdfOptimizeExistingOnStartup) {
    return;
  }

  const files = listStoredFiles();
  files.forEach((file) => enqueuePdfOptimization(file));
}
