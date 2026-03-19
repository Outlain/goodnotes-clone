import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, SyntheticEvent } from "react";
import { buildStrokePath, hitTestAnnotation } from "../lib/annotations";
import type { Annotation, AnnotationPoint, EditorTool, PageRecord, PalmSettings, TextAnnotation } from "../types";
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

interface PointerScrollState {
  pointerId: number;
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
  const pointerScrollRef = useRef<PointerScrollState | null>(null);
  const momentumFrameRef = useRef<number | null>(null);
  const lastPenInteractionAtRef = useRef(0);
  const draftStrokeRef = useRef<Extract<Annotation, { type: "stroke" }> | null>(null);
  const draftRenderFrameRef = useRef<number | null>(null);
  const [availableWidth, setAvailableWidth] = useState(() => Math.max(0, viewportWidthHint ?? 0));
  const [draftStroke, setDraftStroke] = useState<Extract<Annotation, { type: "stroke" }> | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);

  useEffect(() => {
    draftStrokeRef.current = null;
    if (draftRenderFrameRef.current != null) {
      window.cancelAnimationFrame(draftRenderFrameRef.current);
      draftRenderFrameRef.current = null;
    }
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
    return () => {
      if (momentumFrameRef.current != null) {
        window.cancelAnimationFrame(momentumFrameRef.current);
      }
      if (draftRenderFrameRef.current != null) {
        window.cancelAnimationFrame(draftRenderFrameRef.current);
      }
    };
  }, []);

  function getScrollContainer(): HTMLElement | null {
    const shellNode = shellRef.current;
    if (!shellNode) {
      return null;
    }

    const scrollContainer = shellNode.closest(".page-panel");
    return scrollContainer instanceof HTMLElement ? scrollContainer : null;
  }

  function cancelMomentum(): void {
    if (momentumFrameRef.current != null) {
      window.cancelAnimationFrame(momentumFrameRef.current);
      momentumFrameRef.current = null;
    }
  }

  function startMomentum(scrollContainer: HTMLElement, velocityX: number, velocityY: number): void {
    cancelMomentum();

    let nextVelocityX = velocityX;
    let nextVelocityY = velocityY;
    let lastFrameTime = performance.now();

    const step = (timestamp: number) => {
      const deltaMs = Math.max(1, timestamp - lastFrameTime);
      lastFrameTime = timestamp;

      scrollContainer.scrollLeft -= nextVelocityX * deltaMs;
      scrollContainer.scrollTop -= nextVelocityY * deltaMs;

      const damping = Math.pow(0.995, deltaMs);
      nextVelocityX *= damping;
      nextVelocityY *= damping;

      if (Math.abs(nextVelocityX) < 0.02 && Math.abs(nextVelocityY) < 0.02) {
        momentumFrameRef.current = null;
        return;
      }

      momentumFrameRef.current = window.requestAnimationFrame(step);
    };

    momentumFrameRef.current = window.requestAnimationFrame(step);
  }

  function shouldScrollWithTouchPointer(event: ReactPointerEvent<SVGSVGElement>): boolean {
    return event.pointerType === "touch" && (palmSettings.stylusOnly || tool === "hand");
  }

  function pointFromClient(clientX: number, clientY: number, pressure = 0.5): AnnotationPoint {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) {
      return { x: 0, y: 0, pressure };
    }

    return {
      x: ((clientX - rect.left) / rect.width) * page.width,
      y: ((clientY - rect.top) / rect.height) * page.height,
      pressure
    };
  }

  function collectPointerSamples(event: ReactPointerEvent<SVGSVGElement>): AnnotationPoint[] {
    const nativeEvent = event.nativeEvent as PointerEvent;
    const rawSamples = typeof nativeEvent.getCoalescedEvents === "function" ? nativeEvent.getCoalescedEvents() : [];
    const samples = rawSamples.length ? rawSamples : [nativeEvent];

    return samples.map((sample) => pointFromClient(sample.clientX, sample.clientY, sample.pressure || event.pressure || 0.5));
  }

  function appendStrokePoints(stroke: Extract<Annotation, { type: "stroke" }>, points: AnnotationPoint[]): void {
    points.forEach((point) => {
      const previous = stroke.points.at(-1);
      if (
        previous &&
        Math.abs(previous.x - point.x) < 0.01 &&
        Math.abs(previous.y - point.y) < 0.01 &&
        Math.abs(previous.pressure - point.pressure) < 0.01
      ) {
        return;
      }
      stroke.points.push(point);
    });
  }

  function scheduleDraftStrokeRender(): void {
    if (draftRenderFrameRef.current != null) {
      return;
    }

    draftRenderFrameRef.current = window.requestAnimationFrame(() => {
      draftRenderFrameRef.current = null;
      const currentDraftStroke = draftStrokeRef.current;
      setDraftStroke(currentDraftStroke ? { ...currentDraftStroke, points: [...currentDraftStroke.points] } : null);
    });
  }

  function getPoint(event: ReactPointerEvent<SVGSVGElement>): PointLike {
    return pointFromClient(event.clientX, event.clientY, event.pressure || 0.5);
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
    const bufferedDraftStroke = draftStrokeRef.current ?? draftStroke;
    if (!bufferedDraftStroke) {
      return;
    }

    if (bufferedDraftStroke.points.length === 0) {
      draftStrokeRef.current = null;
      setDraftStroke(null);
      return;
    }

    const weightedWidth =
      (tool === "highlighter" ? strokeWidth * 2.2 : strokeWidth) * (0.72 + averagePressure(bufferedDraftStroke.points) * 0.5);
    onChange([
      ...page.annotations,
      {
        ...bufferedDraftStroke,
        width: Number(weightedWidth.toFixed(2))
      }
    ]);
    draftStrokeRef.current = null;
    if (draftRenderFrameRef.current != null) {
      window.cancelAnimationFrame(draftRenderFrameRef.current);
      draftRenderFrameRef.current = null;
    }
    setDraftStroke(null);
  }

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>): void {
    if (shouldScrollWithTouchPointer(event)) {
      const scrollContainer = getScrollContainer();
      if (!scrollContainer) {
        return;
      }

      cancelMomentum();
      event.preventDefault();
      event.stopPropagation();
      svgRef.current?.setPointerCapture(event.pointerId);
      pointerScrollRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startScrollLeft: scrollContainer.scrollLeft,
        startScrollTop: scrollContainer.scrollTop,
        lastX: event.clientX,
        lastY: event.clientY,
        lastTimestamp: event.timeStamp,
        velocityX: 0,
        velocityY: 0
      };
      return;
    }

    if (shouldIgnorePointer(event, palmSettings)) {
      return;
    }

    if (event.pointerType === "pen") {
      lastPenInteractionAtRef.current = performance.now();
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
    const nextDraftStroke: Extract<Annotation, { type: "stroke" }> = {
      id: createId(),
      type: "stroke",
      tool: tool === "highlighter" ? "highlighter" : "pen",
      color,
      width: strokeWidth,
      points: []
    };
    appendStrokePoints(nextDraftStroke, collectPointerSamples(event));
    if (nextDraftStroke.points.length === 0) {
      nextDraftStroke.points.push(point);
    }
    draftStrokeRef.current = nextDraftStroke;
    setDraftStroke({ ...nextDraftStroke, points: [...nextDraftStroke.points] });
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>): void {
    if (pointerScrollRef.current?.pointerId === event.pointerId) {
      const scrollContainer = getScrollContainer();
      if (!scrollContainer) {
        return;
      }

      event.preventDefault();
      const deltaMs = Math.max(1, event.timeStamp - pointerScrollRef.current.lastTimestamp);
      const deltaX = event.clientX - pointerScrollRef.current.lastX;
      const deltaY = event.clientY - pointerScrollRef.current.lastY;

      scrollContainer.scrollLeft = pointerScrollRef.current.startScrollLeft - (event.clientX - pointerScrollRef.current.startX);
      scrollContainer.scrollTop = pointerScrollRef.current.startScrollTop - (event.clientY - pointerScrollRef.current.startY);
      pointerScrollRef.current.velocityX = deltaX / deltaMs;
      pointerScrollRef.current.velocityY = deltaY / deltaMs;
      pointerScrollRef.current.lastX = event.clientX;
      pointerScrollRef.current.lastY = event.clientY;
      pointerScrollRef.current.lastTimestamp = event.timeStamp;
      return;
    }

    if (drawingRef.current && draftStrokeRef.current) {
      event.preventDefault();
      appendStrokePoints(draftStrokeRef.current, collectPointerSamples(event));
      scheduleDraftStrokeRender();
      return;
    }

    if (erasingRef.current) {
      event.preventDefault();
      eraseAt(getPoint(event));
    }
  }

  function handlePointerUp(event: ReactPointerEvent<SVGSVGElement>): void {
    if (pointerScrollRef.current?.pointerId === event.pointerId) {
      const scrollContainer = getScrollContainer();
      event.preventDefault();
      if (svgRef.current?.hasPointerCapture(event.pointerId)) {
        svgRef.current.releasePointerCapture(event.pointerId);
      }
      if (scrollContainer) {
        startMomentum(scrollContainer, pointerScrollRef.current.velocityX, pointerScrollRef.current.velocityY);
      }
      pointerScrollRef.current = null;
      return;
    }

    if (drawingRef.current) {
      event.preventDefault();
      if (event.pointerType === "pen") {
        lastPenInteractionAtRef.current = performance.now();
      }
      if (draftStrokeRef.current) {
        appendStrokePoints(draftStrokeRef.current, collectPointerSamples(event));
      }
      drawingRef.current = false;
      if (svgRef.current?.hasPointerCapture(event.pointerId)) {
        svgRef.current.releasePointerCapture(event.pointerId);
      }
      commitDraftStroke();
    }

    if (erasingRef.current) {
      event.preventDefault();
      if (event.pointerType === "pen") {
        lastPenInteractionAtRef.current = performance.now();
      }
      erasingRef.current = false;
      if (svgRef.current?.hasPointerCapture(event.pointerId)) {
        svgRef.current.releasePointerCapture(event.pointerId);
      }
    }
  }

  function suppressSyntheticActivation(event: SyntheticEvent<SVGSVGElement>): void {
    if (performance.now() - lastPenInteractionAtRef.current < 500) {
      event.preventDefault();
      event.stopPropagation();
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
          onClick={suppressSyntheticActivation}
          onDoubleClick={suppressSyntheticActivation}
          onContextMenu={suppressSyntheticActivation}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerCancel={handlePointerUp}
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
