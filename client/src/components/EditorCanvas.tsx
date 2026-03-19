import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { buildStrokePath, hitTestAnnotation } from "../lib/annotations";
import type { Annotation, EditorTool, PageRecord, PalmSettings, TextAnnotation } from "../types";
import { PdfPageLayer } from "./PdfPageLayer";

interface EditorCanvasProps {
  page: PageRecord;
  fileUrl?: string;
  viewportWidthHint?: number;
  zoom: number;
  tool: EditorTool;
  color: string;
  strokeWidth: number;
  palmSettings: PalmSettings;
  onChange: (annotations: Annotation[]) => void;
}

interface PointLike {
  x: number;
  y: number;
  pressure: number;
}

interface TouchScrollState {
  identifier: number;
  startX: number;
  startY: number;
  startScrollLeft: number;
  startScrollTop: number;
  lastX: number;
  lastY: number;
  lastTimestamp: number;
  velocityX: number;
  velocityY: number;
}

type SafariTouch = Touch & { touchType?: string };

function shouldIgnorePointer(event: ReactPointerEvent<SVGSVGElement>, palmSettings: PalmSettings): boolean {
  if (event.pointerType === "mouse") {
    return false;
  }

  if (palmSettings.stylusOnly) {
    return event.pointerType !== "pen";
  }

  if (event.pointerType === "touch") {
    return event.width * event.height > palmSettings.maxTouchArea;
  }

  return false;
}

function createId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function averagePressure(points: PointLike[]): number {
  if (points.length === 0) {
    return 0.5;
  }

  return points.reduce((total, point) => total + (point.pressure || 0.5), 0) / points.length;
}

function PagePaper({ template }: { template: PageRecord["template"] }) {
  return <div className={`page-paper template-${template ?? "blank"}`} />;
}

function shouldCaptureEditorGesture(
  event: ReactPointerEvent<SVGSVGElement>,
  tool: EditorTool,
  palmSettings: PalmSettings
): boolean {
  return tool !== "hand" && !shouldIgnorePointer(event, palmSettings);
}

export function EditorCanvas({
  page,
  fileUrl,
  viewportWidthHint,
  zoom,
  tool,
  color,
  strokeWidth,
  palmSettings,
  onChange
}: EditorCanvasProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drawingRef = useRef(false);
  const erasingRef = useRef(false);
  const touchScrollRef = useRef<TouchScrollState | null>(null);
  const momentumFrameRef = useRef<number | null>(null);
  const [availableWidth, setAvailableWidth] = useState(() => Math.max(0, viewportWidthHint ?? 0));
  const [draftStroke, setDraftStroke] = useState<Extract<Annotation, { type: "stroke" }> | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);

  useEffect(() => {
    setDraftStroke(null);
    setEditingTextId(null);
  }, [page.id]);

  useEffect(() => {
    if (!viewportWidthHint) {
      return;
    }

    setAvailableWidth((current) => (Math.abs(current - viewportWidthHint) < 1 ? current : viewportWidthHint));
  }, [viewportWidthHint]);

  useLayoutEffect(() => {
    const shellNode = shellRef.current;
    if (!shellNode || typeof ResizeObserver === "undefined") {
      return;
    }

    const updateWidth = (nextWidth?: number) => {
      const measuredWidth = nextWidth ?? shellNode.clientWidth;
      const shellStyle = window.getComputedStyle(shellNode);
      const horizontalPadding = Number.parseFloat(shellStyle.paddingLeft) + Number.parseFloat(shellStyle.paddingRight);
      setAvailableWidth(Math.max(0, measuredWidth - horizontalPadding));
    };

    updateWidth();

    const observer = new ResizeObserver((entries) => {
      updateWidth(entries[0]?.contentRect.width);
    });

    observer.observe(shellNode);

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const svgNode = svgRef.current;
    const stageNode = stageRef.current;
    const shellNode = shellRef.current;
    if (!svgNode || !stageNode || !shellNode) {
      return;
    }

    const scrollContainer = shellNode.closest(".page-panel");
    if (!(scrollContainer instanceof HTMLElement)) {
      return;
    }

    const findTrackedTouch = (event: TouchEvent): SafariTouch | undefined => {
      const activeIdentifier = touchScrollRef.current?.identifier;
      if (activeIdentifier == null) {
        return undefined;
      }

      return [...event.touches, ...event.changedTouches].find((touch) => touch.identifier === activeIdentifier) as SafariTouch | undefined;
    };

    const isDirectTouch = (touch: SafariTouch | undefined): boolean => !touch?.touchType || touch.touchType === "direct";
    const shouldManuallyScrollTouch = (touch: SafariTouch | undefined): boolean => {
      if (!isDirectTouch(touch)) {
        return false;
      }

      return palmSettings.stylusOnly || tool === "hand";
    };

    const cancelMomentum = () => {
      if (momentumFrameRef.current != null) {
        window.cancelAnimationFrame(momentumFrameRef.current);
        momentumFrameRef.current = null;
      }
    };

    const startMomentum = (velocityX: number, velocityY: number) => {
      cancelMomentum();

      let nextVelocityX = velocityX;
      let nextVelocityY = velocityY;
      let lastFrameTime = performance.now();

      const step = (timestamp: number) => {
        const deltaMs = Math.max(1, timestamp - lastFrameTime);
        lastFrameTime = timestamp;

        scrollContainer.scrollLeft -= nextVelocityX * deltaMs;
        scrollContainer.scrollTop -= nextVelocityY * deltaMs;

        const damping = Math.pow(0.992, deltaMs);
        nextVelocityX *= damping;
        nextVelocityY *= damping;

        if (Math.abs(nextVelocityX) < 0.02 && Math.abs(nextVelocityY) < 0.02) {
          momentumFrameRef.current = null;
          return;
        }

        momentumFrameRef.current = window.requestAnimationFrame(step);
      };

      momentumFrameRef.current = window.requestAnimationFrame(step);
    };

    const handleTouchStart = (event: TouchEvent) => {
      const touch = event.changedTouches[0] as SafariTouch | undefined;
      if (!shouldManuallyScrollTouch(touch)) {
        return;
      }
      if (!touch) {
        return;
      }
      cancelMomentum();

      touchScrollRef.current = {
        identifier: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        startScrollLeft: scrollContainer.scrollLeft,
        startScrollTop: scrollContainer.scrollTop,
        lastX: touch.clientX,
        lastY: touch.clientY,
        lastTimestamp: event.timeStamp,
        velocityX: 0,
        velocityY: 0
      };

      event.preventDefault();
    };

    const handleTouchMove = (event: TouchEvent) => {
      const trackedTouch = findTrackedTouch(event);
      if (!trackedTouch || !touchScrollRef.current) {
        return;
      }

      event.preventDefault();
      const deltaMs = Math.max(1, event.timeStamp - touchScrollRef.current.lastTimestamp);
      const deltaX = trackedTouch.clientX - touchScrollRef.current.lastX;
      const deltaY = trackedTouch.clientY - touchScrollRef.current.lastY;

      scrollContainer.scrollLeft = touchScrollRef.current.startScrollLeft - (trackedTouch.clientX - touchScrollRef.current.startX);
      scrollContainer.scrollTop = touchScrollRef.current.startScrollTop - (trackedTouch.clientY - touchScrollRef.current.startY);
      touchScrollRef.current.velocityX = deltaX / deltaMs;
      touchScrollRef.current.velocityY = deltaY / deltaMs;
      touchScrollRef.current.lastX = trackedTouch.clientX;
      touchScrollRef.current.lastY = trackedTouch.clientY;
      touchScrollRef.current.lastTimestamp = event.timeStamp;
    };

    const handleTouchEnd = (event: TouchEvent) => {
      const trackedTouch = findTrackedTouch(event);
      if (!trackedTouch || !touchScrollRef.current) {
        return;
      }

      event.preventDefault();
      startMomentum(touchScrollRef.current.velocityX, touchScrollRef.current.velocityY);
      touchScrollRef.current = null;
    };

    const suppressSurfaceActivation = (event: Event) => {
      event.preventDefault();
    };

    svgNode.addEventListener("touchstart", handleTouchStart, { passive: false });
    svgNode.addEventListener("touchmove", handleTouchMove, { passive: false });
    svgNode.addEventListener("touchend", handleTouchEnd, { passive: false });
    svgNode.addEventListener("touchcancel", handleTouchEnd, { passive: false });
    stageNode.addEventListener("contextmenu", suppressSurfaceActivation);
    stageNode.addEventListener("dblclick", suppressSurfaceActivation);
    stageNode.addEventListener("selectstart", suppressSurfaceActivation);

    return () => {
      cancelMomentum();
      svgNode.removeEventListener("touchstart", handleTouchStart);
      svgNode.removeEventListener("touchmove", handleTouchMove);
      svgNode.removeEventListener("touchend", handleTouchEnd);
      svgNode.removeEventListener("touchcancel", handleTouchEnd);
      stageNode.removeEventListener("contextmenu", suppressSurfaceActivation);
      stageNode.removeEventListener("dblclick", suppressSurfaceActivation);
      stageNode.removeEventListener("selectstart", suppressSurfaceActivation);
    };
  }, [palmSettings.stylusOnly, tool]);

  function getPoint(event: ReactPointerEvent<SVGSVGElement>): PointLike {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) {
      return { x: 0, y: 0, pressure: event.pressure || 0.5 };
    }

    return {
      x: ((event.clientX - rect.left) / rect.width) * page.width,
      y: ((event.clientY - rect.top) / rect.height) * page.height,
      pressure: event.pressure || 0.5
    };
  }

  function eraseAt(point: PointLike): void {
    for (let index = page.annotations.length - 1; index >= 0; index -= 1) {
      if (hitTestAnnotation(page.annotations[index], point.x, point.y)) {
        const nextAnnotations = [...page.annotations];
        nextAnnotations.splice(index, 1);
        onChange(nextAnnotations);
        break;
      }
    }
  }

  function createTextAnnotation(x: number, y: number): void {
    const safeX = Math.max(16, Math.min(x, page.width - 140));
    const safeY = Math.max(16, Math.min(y, page.height - 120));
    const next: TextAnnotation = {
      id: createId(),
      type: "text",
      x: safeX,
      y: safeY,
      width: Math.max(120, Math.min(220, page.width - safeX - 24)),
      height: 96,
      text: "",
      color,
      fontSize: 18
    };
    onChange([...page.annotations, next]);
    setEditingTextId(next.id);
  }

  function commitDraftStroke(): void {
    if (!draftStroke) {
      return;
    }

    if (draftStroke.points.length === 0) {
      setDraftStroke(null);
      return;
    }

    const weightedWidth =
      (tool === "highlighter" ? strokeWidth * 2.2 : strokeWidth) * (0.72 + averagePressure(draftStroke.points) * 0.5);
    onChange([
      ...page.annotations,
      {
        ...draftStroke,
        width: Number(weightedWidth.toFixed(2))
      }
    ]);
    setDraftStroke(null);
  }

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>): void {
    if (shouldIgnorePointer(event, palmSettings)) {
      return;
    }

    if (shouldCaptureEditorGesture(event, tool, palmSettings)) {
      event.preventDefault();
      event.stopPropagation();
    }

    const point = getPoint(event);

    if (tool === "text") {
      createTextAnnotation(point.x, point.y);
      return;
    }

    if (tool === "eraser") {
      erasingRef.current = true;
      svgRef.current?.setPointerCapture(event.pointerId);
      eraseAt(point);
      return;
    }

    if (tool === "hand") {
      return;
    }

    drawingRef.current = true;
    svgRef.current?.setPointerCapture(event.pointerId);
    setDraftStroke({
      id: createId(),
      type: "stroke",
      tool: tool === "highlighter" ? "highlighter" : "pen",
      color,
      width: strokeWidth,
      points: [point]
    });
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>): void {
    if (drawingRef.current && draftStroke) {
      event.preventDefault();
      const point = getPoint(event);
      setDraftStroke({
        ...draftStroke,
        points: [...draftStroke.points, point]
      });
      return;
    }

    if (erasingRef.current) {
      event.preventDefault();
      eraseAt(getPoint(event));
    }
  }

  function handlePointerUp(event: ReactPointerEvent<SVGSVGElement>): void {
    if (drawingRef.current) {
      event.preventDefault();
      drawingRef.current = false;
      if (svgRef.current?.hasPointerCapture(event.pointerId)) {
        svgRef.current.releasePointerCapture(event.pointerId);
      }
      commitDraftStroke();
    }

    if (erasingRef.current) {
      event.preventDefault();
      erasingRef.current = false;
      if (svgRef.current?.hasPointerCapture(event.pointerId)) {
        svgRef.current.releasePointerCapture(event.pointerId);
      }
    }
  }

  function updateTextAnnotation(annotationId: string, nextText: string): void {
    onChange(
      page.annotations.map((annotation) =>
        annotation.type === "text" && annotation.id === annotationId
          ? {
              ...annotation,
              text: nextText
            }
          : annotation
      )
    );
  }

  function finishTextEditing(annotationId: string): void {
    const annotation = page.annotations.find((entry) => entry.type === "text" && entry.id === annotationId);
    if (annotation?.type === "text" && !annotation.text.trim()) {
      onChange(page.annotations.filter((entry) => entry.id !== annotationId));
    }
    setEditingTextId(null);
  }

  const fitScale = availableWidth > 0 ? availableWidth / page.width : 1;
  const renderZoom = Math.max(0.2, fitScale * zoom);
  const annotationLayerClassName = [
    "annotation-layer",
    tool === "hand" ? "annotation-hand" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="page-stage-shell" ref={shellRef}>
      <div
        className="page-stage"
        ref={stageRef}
        style={{
          width: `${page.width * renderZoom}px`,
          height: `${page.height * renderZoom}px`
        }}
      >
        {page.kind === "pdf" && fileUrl ? (
          <PdfPageLayer
            pageIndex={page.sourcePageIndex ?? 0}
            url={fileUrl}
            width={page.width}
            height={page.height}
            zoom={renderZoom}
          />
        ) : page.kind === "pdf" ? (
          <div className="page-fallback">The PDF source for this page is missing.</div>
        ) : (
          <PagePaper template={page.template} />
        )}

        <svg
          className={annotationLayerClassName}
          ref={svgRef}
          viewBox={`0 0 ${page.width} ${page.height}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
        >
          {page.annotations.map((annotation) =>
            annotation.type === "stroke" ? (
              <path
                key={annotation.id}
                d={buildStrokePath(annotation)}
                fill="none"
                stroke={annotation.color}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeOpacity={annotation.tool === "highlighter" ? 0.22 : 1}
                strokeWidth={annotation.width}
              />
            ) : null
          )}

          {draftStroke ? (
            <path
              d={buildStrokePath(draftStroke)}
              fill="none"
              stroke={draftStroke.color}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeOpacity={draftStroke.tool === "highlighter" ? 0.22 : 1}
              strokeWidth={draftStroke.width}
            />
          ) : null}
        </svg>

        {page.annotations.map((annotation) => {
          if (annotation.type !== "text") {
            return null;
          }

          const sharedStyle = {
            left: `${annotation.x * renderZoom}px`,
            top: `${annotation.y * renderZoom}px`,
            width: `${annotation.width * renderZoom}px`,
            minHeight: `${annotation.height * renderZoom}px`,
            color: annotation.color,
            fontSize: `${annotation.fontSize * renderZoom}px`
          };

          if (editingTextId === annotation.id) {
            return (
              <textarea
                autoFocus
                className="text-annotation-editor"
                key={annotation.id}
                style={sharedStyle}
                value={annotation.text}
                onBlur={() => finishTextEditing(annotation.id)}
                onChange={(event) => updateTextAnnotation(annotation.id, event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    finishTextEditing(annotation.id);
                  }
                }}
              />
            );
          }

          return (
            <button
              className="text-annotation"
              key={annotation.id}
              style={sharedStyle}
              onClick={() => setEditingTextId(annotation.id)}
              type="button"
            >
              {annotation.text || "Text"}
            </button>
          );
        })}
      </div>
    </div>
  );
}
