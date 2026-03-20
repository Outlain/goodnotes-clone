import { memo, useEffect, useRef, useState } from "react";
import { getCachedPageSnapshot, getCachedPreviewSnapshot, loadPdfPage, storePageSnapshot } from "../lib/pdf";

interface PdfPageLayerProps {
  pageIndex: number;
  url: string;
  fileSize?: number;
  previewUrl?: string;
  width: number;
  height: number;
  zoom: number;
}

const MAX_RENDER_PIXELS = 3_200_000;

function PdfPageLayerInner({ pageIndex, url, fileSize, previewUrl, width, height, zoom }: PdfPageLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<{ cancel: () => void; promise: Promise<unknown> } | null>(null);
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
        const deviceScale = window.devicePixelRatio || 1;
        const requestedScale = zoom * deviceScale;
        const maxScale = Math.sqrt(MAX_RENDER_PIXELS / Math.max(width * height, 1));
        const effectiveScale = Math.min(requestedScale, maxScale);
        const cacheKey = `${url}|${pageIndex}|${effectiveScale.toFixed(3)}`;
        canvas.style.width = `${width * zoom}px`;
        canvas.style.height = `${height * zoom}px`;

        if (!cancelled) {
          setIsLoading(true);
          setError("");
        }

        const previousTask = renderTaskRef.current;
        if (previousTask) {
          previousTask.cancel();
          try {
            await previousTask.promise;
          } catch {
            // Ignore cancellation rejections from the previous render.
          }
          if (renderTaskRef.current === previousTask) {
            renderTaskRef.current = null;
          }
        }

        const cachedSnapshot = getCachedPageSnapshot(cacheKey);
        if (cachedSnapshot) {
          canvas.width = cachedSnapshot.width;
          canvas.height = cachedSnapshot.height;
          context.clearRect(0, 0, canvas.width, canvas.height);
          context.drawImage(cachedSnapshot, 0, 0);

          if (!cancelled) {
            setError("");
            setIsLoading(false);
          }
          return;
        }

        const previewSnapshot = getCachedPreviewSnapshot(url, pageIndex + 1);
        if (previewSnapshot) {
          canvas.width = previewSnapshot.width;
          canvas.height = previewSnapshot.height;
          context.clearRect(0, 0, canvas.width, canvas.height);
          context.drawImage(previewSnapshot, 0, 0);
        }

        const page = await loadPdfPage(url, pageIndex + 1, fileSize);
        if (cancelled) {
          page.cleanup();
          return;
        }
        const viewport = page.getViewport({ scale: effectiveScale });

        canvas.width = viewport.width;
        canvas.height = viewport.height;
        context.clearRect(0, 0, canvas.width, canvas.height);

        const renderTask = page.render({
          canvasContext: context,
          viewport
        });
        renderTaskRef.current = renderTask;

        await renderTask.promise;

        if (renderTaskRef.current === renderTask) {
          renderTaskRef.current = null;
        }

        page.cleanup();
        storePageSnapshot(cacheKey, canvas);

        if (!cancelled) {
          setError("");
          setIsLoading(false);
        }
      } catch (nextError) {
        const isCancelledError =
          cancelled ||
          (nextError instanceof Error &&
            (nextError.name === "RenderingCancelledException" ||
              nextError.message.toLowerCase().includes("cancelled")));

        if (isCancelledError) {
          return;
        }

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
      renderTaskRef.current?.cancel();
    };
  }, [fileSize, height, pageIndex, url, width, zoom]);

  return (
    <>
      {previewUrl && (isLoading || Boolean(error)) ? (
        <img alt="" className="page-preview-image" decoding="async" src={previewUrl} />
      ) : null}
      <canvas className="pdf-canvas" ref={canvasRef} />
      {isLoading && !error && !previewUrl ? <div className="page-fallback">Loading PDF page...</div> : null}
      {error ? <div className="page-fallback">PDF preview failed: {error}</div> : null}
    </>
  );
}

export const PdfPageLayer = memo(PdfPageLayerInner);
