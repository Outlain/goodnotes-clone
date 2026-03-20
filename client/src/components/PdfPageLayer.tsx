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
const ZOOM_RENDER_DEBOUNCE_MS = 150;

function PdfPageLayerInner({ pageIndex, url, fileSize, previewUrl, width, height, zoom }: PdfPageLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<{ cancel: () => void; promise: Promise<unknown> } | null>(null);
  const hasRenderedOnceRef = useRef(false);
  const lastRenderedKeyRef = useRef<string>("");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    const deviceScale = window.devicePixelRatio || 1;
    const requestedScale = zoom * deviceScale;
    const maxScale = Math.sqrt(MAX_RENDER_PIXELS / Math.max(width * height, 1));
    const effectiveScale = Math.min(requestedScale, maxScale);
    const cacheKey = `${url}|${pageIndex}|${effectiveScale.toFixed(3)}`;

    async function render() {
      if (!canvasRef.current || cancelled) {
        return;
      }

      const canvas = canvasRef.current;
      const context = canvas.getContext("2d");
      if (!context) {
        return;
      }

      try {
        canvas.style.width = `${width * zoom}px`;
        canvas.style.height = `${height * zoom}px`;

        if (!cancelled) {
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
          context.drawImage(cachedSnapshot, 0, 0);
          canvas.style.opacity = "1";
          hasRenderedOnceRef.current = true;
          lastRenderedKeyRef.current = cacheKey;

          if (!cancelled) {
            setError("");
          }
          return;
        }

        // Show preview snapshot on canvas if no content yet
        if (!hasRenderedOnceRef.current) {
          const previewSnapshot = getCachedPreviewSnapshot(url, pageIndex + 1);
          if (previewSnapshot) {
            canvas.width = previewSnapshot.width;
            canvas.height = previewSnapshot.height;
            context.drawImage(previewSnapshot, 0, 0);
            canvas.style.opacity = "1";
          }
        }

        const page = await loadPdfPage(url, pageIndex + 1, fileSize);
        if (cancelled) {
          page.cleanup();
          return;
        }
        const viewport = page.getViewport({ scale: effectiveScale });

        // Double-buffer: render to offscreen canvas, then swap in one shot
        const offscreen = document.createElement("canvas");
        offscreen.width = viewport.width;
        offscreen.height = viewport.height;
        const offscreenCtx = offscreen.getContext("2d");
        if (!offscreenCtx) {
          page.cleanup();
          return;
        }

        const renderTask = page.render({
          canvasContext: offscreenCtx,
          viewport
        });
        renderTaskRef.current = renderTask;

        await renderTask.promise;

        if (renderTaskRef.current === renderTask) {
          renderTaskRef.current = null;
        }

        if (cancelled) {
          page.cleanup();
          return;
        }

        // Atomic swap: resize visible canvas and paint in one shot
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        context.drawImage(offscreen, 0, 0);
        canvas.style.opacity = "1";

        page.cleanup();
        storePageSnapshot(cacheKey, canvas);
        hasRenderedOnceRef.current = true;
        lastRenderedKeyRef.current = cacheKey;

        if (!cancelled) {
          setError("");
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
        }
      }
    }

    // Cache hit or first render: start immediately. Otherwise debounce (zoom changes).
    if (getCachedPageSnapshot(cacheKey) || !hasRenderedOnceRef.current) {
      render();
    } else {
      debounceTimer = setTimeout(render, ZOOM_RENDER_DEBOUNCE_MS);
    }

    return () => {
      cancelled = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      renderTaskRef.current?.cancel();
    };
  }, [fileSize, height, pageIndex, url, width, zoom]);

  return (
    <>
      {previewUrl ? (
        <img alt="" className="page-preview-image" decoding="async" src={previewUrl} />
      ) : null}
      <canvas className="pdf-canvas" ref={canvasRef} />
      {!hasRenderedOnceRef.current && !error && !previewUrl ? (
        <div className="page-fallback page-skeleton">Loading PDF page...</div>
      ) : null}
      {error ? <div className="page-fallback">PDF preview failed: {error}</div> : null}
    </>
  );
}

export const PdfPageLayer = memo(PdfPageLayerInner);
