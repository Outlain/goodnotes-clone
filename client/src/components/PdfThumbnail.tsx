import { memo, useEffect, useRef, useState } from "react";
import { getCachedThumbnailSnapshot, loadPdfPage, storeThumbnailSnapshot } from "../lib/pdf";

interface PdfThumbnailProps {
  pageIndex: number;
  url: string;
  fileSize?: number;
  width: number;
  height: number;
}

function PdfThumbnailInner({ pageIndex, url, fileSize, width, height }: PdfThumbnailProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<{ cancel: () => void; promise: Promise<unknown> } | null>(null);
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
        setError("");

        const deviceScale = window.devicePixelRatio || 1;
        const scale = Math.min((100 / width) * deviceScale, (140 / height) * deviceScale);
        const cacheKey = `${url}|${pageIndex}|thumb|${scale.toFixed(3)}`;
        canvas.style.width = "100%";
        canvas.style.height = "100%";

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

        const cachedSnapshot = getCachedThumbnailSnapshot(cacheKey);
        if (cachedSnapshot) {
          canvas.width = cachedSnapshot.width;
          canvas.height = cachedSnapshot.height;
          context.clearRect(0, 0, canvas.width, canvas.height);
          context.drawImage(cachedSnapshot, 0, 0);
          return;
        }

        const page = await loadPdfPage(url, pageIndex + 1, fileSize);
        if (cancelled) {
          page.cleanup();
          return;
        }

        const viewport = page.getViewport({ scale });

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
        storeThumbnailSnapshot(cacheKey, canvas);

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
      renderTaskRef.current?.cancel();
    };
  }, [fileSize, height, pageIndex, url, width]);

  return (
    <>
      <canvas className="thumbnail-canvas" ref={canvasRef} />
      {error ? <div className="thumbnail-overlay">Preview unavailable</div> : null}
    </>
  );
}

export const PdfThumbnail = memo(PdfThumbnailInner);
