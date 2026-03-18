import { useEffect, useRef, useState } from "react";
import { loadPdf } from "../lib/pdf";

interface PdfPageLayerProps {
  pageIndex: number;
  url: string;
  width: number;
  height: number;
  zoom: number;
}

const MAX_RENDER_PIXELS = 3_200_000;

export function PdfPageLayer({ pageIndex, url, width, height, zoom }: PdfPageLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let cancelled = false;

    async function render() {
      if (!canvasRef.current) {
        return;
      }

      const canvas = canvasRef.current;
      const context = canvas.getContext("2d");
      if (!context) {
        return;
      }

      try {
        if (!cancelled) {
          setIsLoading(true);
        }

        const pdf = await loadPdf(url);
        const page = await pdf.getPage(pageIndex + 1);
        const deviceScale = window.devicePixelRatio || 1;
        const requestedScale = zoom * deviceScale;
        const maxScale = Math.sqrt(MAX_RENDER_PIXELS / Math.max(width * height, 1));
        const effectiveScale = Math.min(requestedScale, maxScale);
        const viewport = page.getViewport({ scale: effectiveScale });

        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${width * zoom}px`;
        canvas.style.height = `${height * zoom}px`;
        context.clearRect(0, 0, canvas.width, canvas.height);

        await page.render({
          canvasContext: context,
          viewport
        }).promise;

        page.cleanup();

        if (!cancelled) {
          setError("");
          setIsLoading(false);
        }
      } catch (nextError) {
        console.error("[Inkflow] PDF page render failed.", {
          url,
          pageIndex,
          error: nextError
        });

        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Could not render PDF page.");
          setIsLoading(false);
        }
      }
    }

    render();

    return () => {
      cancelled = true;
    };
  }, [height, pageIndex, url, width, zoom]);

  return (
    <>
      <canvas className="pdf-canvas" ref={canvasRef} />
      {isLoading && !error ? <div className="page-fallback">Loading PDF page...</div> : null}
      {error ? <div className="page-fallback">PDF preview failed: {error}</div> : null}
    </>
  );
}
