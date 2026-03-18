import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from "pdfjs-dist";

GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

const pdfCache = new Map<string, Promise<PDFDocumentProxy>>();

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
          rangeChunkSize: 256 * 1024
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
