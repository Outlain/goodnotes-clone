import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist";

GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

const pdfCache = new Map<string, Promise<PDFDocumentProxy>>();
const pdfPageCache = new Map<string, Map<number, Promise<PDFPageProxy>>>();

class CanvasSnapshotCache {
  private totalPixels = 0;
  private readonly entries = new Map<string, { canvas: HTMLCanvasElement; pixels: number }>();

  constructor(private readonly maxPixels: number) {}

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

const pageSnapshotCache = new CanvasSnapshotCache(28_000_000);
const thumbnailSnapshotCache = new CanvasSnapshotCache(8_000_000);

export function loadPdf(url: string): Promise<PDFDocumentProxy> {
  if (!pdfCache.has(url)) {
    const promise = (async () => {
      try {
        return await getDocument({
          url,
          withCredentials: true,
          disableRange: false,
          disableStream: false,
          disableAutoFetch: false,
          rangeChunkSize: 1024 * 1024
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
      pdfCache.delete(url);
    });

    pdfCache.set(url, promise);
  }

  return pdfCache.get(url) as Promise<PDFDocumentProxy>;
}

export function loadPdfPage(url: string, pageNumber: number): Promise<PDFPageProxy> {
  if (!pdfPageCache.has(url)) {
    pdfPageCache.set(url, new Map<number, Promise<PDFPageProxy>>());
  }

  const documentPages = pdfPageCache.get(url) as Map<number, Promise<PDFPageProxy>>;
  if (!documentPages.has(pageNumber)) {
    const promise = loadPdf(url).then((pdf) => pdf.getPage(pageNumber));
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
