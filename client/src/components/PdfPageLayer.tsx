import { useEffect, useRef, useState } from "react";
import { loadPdf } from "../lib/pdf";

interface PdfPageLayerProps {
  pageIndex: number;
  url: string;
  width: number;
  height: number;
  zoom: number;
}

export function PdfPageLayer({ pageIndex, url, width, height, zoom }: PdfPageLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
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
        const pdf = await loadPdf(url);
        const page = await pdf.getPage(pageIndex + 1);
        const deviceScale = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: zoom * deviceScale });

        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${width * zoom}px`;
        canvas.style.height = `${height * zoom}px`;
        context.clearRect(0, 0, canvas.width, canvas.height);

        await page.render({
          canvasContext: context,
          viewport
        }).promise;

        if (!cancelled) {
          setError("");
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Could not render PDF page.");
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
      {error ? <div className="page-fallback">PDF preview failed: {error}</div> : null}
    </>
  );
}

