import { useEffect, useRef, useState } from "react";
import { loadPdf } from "../lib/pdf";

interface PdfThumbnailProps {
  pageIndex: number;
  url: string;
  width: number;
  height: number;
}

export function PdfThumbnail({ pageIndex, url, width, height }: PdfThumbnailProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState("");

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
        const scale = Math.min((100 / width) * deviceScale, (140 / height) * deviceScale);
        const viewport = page.getViewport({ scale });

        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        context.clearRect(0, 0, canvas.width, canvas.height);

        await page.render({
          canvasContext: context,
          viewport
        }).promise;

        if (!cancelled) {
          setError("");
        }
      } catch (nextError) {
        console.error("[Inkflow] Thumbnail render failed.", {
          url,
          pageIndex,
          error: nextError
        });

        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Could not render thumbnail.");
        }
      }
    }

    render();

    return () => {
      cancelled = true;
    };
  }, [height, pageIndex, url, width]);

  return (
    <>
      <canvas className="thumbnail-canvas" ref={canvasRef} />
      {error ? <div className="thumbnail-overlay">Preview unavailable</div> : null}
    </>
  );
}
