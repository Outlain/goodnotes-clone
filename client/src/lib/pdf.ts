import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist";

GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

const pdfCache = new Map<string, Promise<PDFDocumentProxy>>();
const pdfPageCache = new Map<string, Map<number, Promise<PDFPageProxy>>>();
const PREVIEW_WIDTH_BUCKETS = [240, 1000, 1400];

// Serialize full-page PDF rasterization. iPad Safari is much smoother when
// we avoid stacking multiple expensive canvas renders at the same time.
const MAX_CONCURRENT_RENDERS = 1;
let activeRenders = 0;
const renderQueue: Array<{ resolve: () => void }> = [];

export function acquireRenderSlot(): Promise<void> {
  if (activeRenders < MAX_CONCURRENT_RENDERS) {
    activeRenders++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    renderQueue.push({ resolve });
  });
}

export function releaseRenderSlot(): void {
  activeRenders = Math.max(0, activeRenders - 1);
  const next = renderQueue.shift();
  if (next) {
    activeRenders++;
    next.resolve();
  }
}

class CanvasSnapshotCache {
  private totalPixels = 0;
  private readonly entries = new Map<string, { canvas: HTMLCanvasElement; pixels: number }>();

  constructor(private maxPixels: number) {}

  resize(newMaxPixels: number): void {
    this.maxPixels = Math.max(this.maxPixels, newMaxPixels);
  }

  get(key: string): HTMLCanvasElement | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.canvas;
  }

  set(key: string, sourceCanvas: HTMLCanvasElement): void {
    if (typeof document === "undefined") {
      return;
    }

    const previousEntry = this.entries.get(key);
    if (previousEntry) {
      this.totalPixels -= previousEntry.pixels;
      this.entries.delete(key);
    }

    const snapshot = document.createElement("canvas");
    snapshot.width = sourceCanvas.width;
    snapshot.height = sourceCanvas.height;
    const snapshotContext = snapshot.getContext("2d");
    if (!snapshotContext) {
      return;
    }

    snapshotContext.drawImage(sourceCanvas, 0, 0);
    const pixels = snapshot.width * snapshot.height;

    this.entries.set(key, {
      canvas: snapshot,
      pixels
    });
    this.totalPixels += pixels;

    while (this.totalPixels > this.maxPixels && this.entries.size > 1) {
      const oldestKey = this.entries.keys().next().value;
      if (!oldestKey) {
        break;
      }

      const oldestEntry = this.entries.get(oldestKey);
      if (!oldestEntry) {
        this.entries.delete(oldestKey);
        continue;
      }

      this.totalPixels -= oldestEntry.pixels;
      this.entries.delete(oldestKey);
    }
  }
}

const pageSnapshotCache = new CanvasSnapshotCache(40_000_000);
const thumbnailSnapshotCache = new CanvasSnapshotCache(10_000_000);

interface PdfLoadProfile {
  cacheKey: string;
  disableAutoFetch: boolean;
  disableStream: boolean;
  rangeChunkSize: number;
}

function resolvePdfLoadProfile(fileSize?: number): PdfLoadProfile {
  const sizeMb = (fileSize ?? 0) / (1024 * 1024);

  if (sizeMb >= 160) {
    return {
      cacheKey: "huge",
      disableAutoFetch: true,
      disableStream: true,
      rangeChunkSize: 4 * 1024 * 1024
    };
  }

  if (sizeMb >= 64) {
    return {
      cacheKey: "large",
      disableAutoFetch: true,
      disableStream: true,
      rangeChunkSize: 2 * 1024 * 1024
    };
  }

  return {
    cacheKey: "default",
    disableAutoFetch: false,
    disableStream: false,
    rangeChunkSize: 1024 * 1024
  };
}

function pdfCacheKey(url: string, fileSize?: number): string {
  return `${url}|${resolvePdfLoadProfile(fileSize).cacheKey}`;
}

export function resolvePreviewWidthBucket(requestedWidth: number): number {
  const safeRequestedWidth = Math.max(120, Math.min(1800, Math.round(requestedWidth)));
  const matchingWidth = PREVIEW_WIDTH_BUCKETS.find((width) => width >= safeRequestedWidth);
  return matchingWidth ?? PREVIEW_WIDTH_BUCKETS[PREVIEW_WIDTH_BUCKETS.length - 1];
}

export function loadPdf(url: string, fileSize?: number): Promise<PDFDocumentProxy> {
  const profile = resolvePdfLoadProfile(fileSize);
  const cacheKey = pdfCacheKey(url, fileSize);

  if (!pdfCache.has(cacheKey)) {
    const promise = (async () => {
      try {
        return await getDocument({
          url,
          length: fileSize,
          withCredentials: true,
          disableRange: false,
          disableStream: profile.disableStream,
          disableAutoFetch: profile.disableAutoFetch,
          rangeChunkSize: profile.rangeChunkSize
        }).promise;
      } catch (streamingError) {
        console.warn("[Inkflow] Streaming PDF load failed, falling back to byte fetch.", { url, streamingError });

        const response = await fetch(url, {
          credentials: "include"
        });

        if (!response.ok) {
          throw new Error(`PDF fetch failed with status ${response.status}.`);
        }

        const bytes = new Uint8Array(await response.arrayBuffer());
        return getDocument({ data: bytes }).promise;
      }
    })();

    promise.catch(() => {
      pdfCache.delete(cacheKey);
    });

    pdfCache.set(cacheKey, promise);
  }

  return pdfCache.get(cacheKey) as Promise<PDFDocumentProxy>;
}

export function loadPdfPage(url: string, pageNumber: number, fileSize?: number): Promise<PDFPageProxy> {
  const cacheKey = pdfCacheKey(url, fileSize);

  if (!pdfPageCache.has(cacheKey)) {
    pdfPageCache.set(cacheKey, new Map<number, Promise<PDFPageProxy>>());
  }

  const documentPages = pdfPageCache.get(cacheKey) as Map<number, Promise<PDFPageProxy>>;
  if (!documentPages.has(pageNumber)) {
    const promise = loadPdf(url, fileSize).then((pdf) => pdf.getPage(pageNumber));
    promise.catch(() => {
      documentPages.delete(pageNumber);
    });
    documentPages.set(pageNumber, promise);
  }

  return documentPages.get(pageNumber) as Promise<PDFPageProxy>;
}

export function getCachedPageSnapshot(key: string): HTMLCanvasElement | undefined {
  return pageSnapshotCache.get(key);
}

export function storePageSnapshot(key: string, sourceCanvas: HTMLCanvasElement): void {
  pageSnapshotCache.set(key, sourceCanvas);
}

export function getCachedThumbnailSnapshot(key: string): HTMLCanvasElement | undefined {
  return thumbnailSnapshotCache.get(key);
}

export function storeThumbnailSnapshot(key: string, sourceCanvas: HTMLCanvasElement): void {
  thumbnailSnapshotCache.set(key, sourceCanvas);
}

export function scaleCachesForDocument(pageCount: number): void {
  if (pageCount > 500) {
    pageSnapshotCache.resize(80_000_000);
    thumbnailSnapshotCache.resize(16_000_000);
  } else if (pageCount > 100) {
    pageSnapshotCache.resize(60_000_000);
    thumbnailSnapshotCache.resize(14_000_000);
  }
}
