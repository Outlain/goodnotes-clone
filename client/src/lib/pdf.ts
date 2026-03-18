import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from "pdfjs-dist";

GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

const pdfCache = new Map<string, Promise<PDFDocumentProxy>>();

export function loadPdf(url: string): Promise<PDFDocumentProxy> {
  if (!pdfCache.has(url)) {
    pdfCache.set(
      url,
      getDocument({
        url,
        withCredentials: true
      }).promise
    );
  }

  return pdfCache.get(url) as Promise<PDFDocumentProxy>;
}

