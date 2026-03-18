import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from "pdfjs-dist";

GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

const pdfCache = new Map<string, Promise<PDFDocumentProxy>>();

export function loadPdf(url: string): Promise<PDFDocumentProxy> {
  if (!pdfCache.has(url)) {
    pdfCache.set(
      url,
      (async () => {
        const response = await fetch(url, {
          credentials: "include"
        });

        if (!response.ok) {
          throw new Error(`PDF fetch failed with status ${response.status}.`);
        }

        const bytes = new Uint8Array(await response.arrayBuffer());
        return getDocument({ data: bytes }).promise;
      })()
    );
  }

  return pdfCache.get(url) as Promise<PDFDocumentProxy>;
}
