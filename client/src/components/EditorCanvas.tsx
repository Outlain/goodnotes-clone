import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, SyntheticEvent } from "react";
import { buildStrokePath, hitTestAnnotation } from "../lib/annotations";
import type {
  Annotation,
  AnnotationPoint,
  EditorTool,
  LineStyle,
  PageRecord,
  PalmSettings,
  ShapeAnnotation,
  ShapeKind,
  TextAnnotation
} from "../types";
import { PdfPageLayer } from "./PdfPageLayer";

interface EditorCanvasProps {
  page: PageRecord;
  fileUrl?: string;
  fileSize?: number;
  previewUrl?: string;
  viewportWidthHint?: number;
  zoom: number;
  tool: EditorTool;
  color: string;
  strokeWidth: number;
  lineStyle: LineStyle;
  eraserSize: number;
  shapeKind: ShapeKind;
  shapeFilled: boolean;
  palmSettings: PalmSettings;
  annotationRevision: number;
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

type ShapeHandle = "nw" | "ne" | "sw" | "se";

interface ShapeInteractionState {
  pointerId: number;
  mode: "create" | "move" | "resize";
  shapeId: string;
  originPoint: AnnotationPoint;
  initialShape: ShapeAnnotation;
  handle?: ShapeHandle;
}

const MIN_SHAPE_SIZE = 12;
const SHAPE_HANDLE_RADIUS = 10;

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

function lineDashArray(style: LineStyle | undefined, width: number): string | undefined {
  if (!style || style === "solid") return undefined;
  if (style === "dashed") return `${width * 3} ${width * 2}`;
  if (style === "dotted") return `${width * 0.1} ${width * 2.5}`;
  return undefined;
}

function normalizeShapeRect(startX: number, startY: number, endX: number, endY: number) {
  const width = Math.max(Math.abs(endX - startX), MIN_SHAPE_SIZE);
  const height = Math.max(Math.abs(endY - startY), MIN_SHAPE_SIZE);
  const x = endX >= startX ? startX : startX - width;
  const y = endY >= startY ? startY : startY - height;
  return { x, y, width, height };
}

function clampShapeToPage(shape: ShapeAnnotation, page: PageRecord): ShapeAnnotation {
  const width = Math.max(MIN_SHAPE_SIZE, Math.min(shape.width, page.width));
  const height = Math.max(MIN_SHAPE_SIZE, Math.min(shape.height, page.height));
  const x = Math.max(0, Math.min(shape.x, page.width - width));
  const y = Math.max(0, Math.min(shape.y, page.height - height));
  return { ...shape, x, y, width, height };
}

function shapePoints(annotation: ShapeAnnotation): string {
  const left = annotation.x;
  const right = annotation.x + annotation.width;
  const top = annotation.y;
  const bottom = annotation.y + annotation.height;
  const centerX = annotation.x + annotation.width / 2;
  const centerY = annotation.y + annotation.height / 2;

  switch (annotation.shape) {
    case "triangle":
      return `${centerX},${top} ${right},${bottom} ${left},${bottom}`;
    case "diamond":
      return `${centerX},${top} ${right},${centerY} ${centerX},${bottom} ${left},${centerY}`;
    default:
      return "";
  }
}

function getShapeHandleCoordinates(annotation: ShapeAnnotation): Array<{ handle: ShapeHandle; x: number; y: number }> {
  return [
    { handle: "nw", x: annotation.x, y: annotation.y },
    { handle: "ne", x: annotation.x + annotation.width, y: annotation.y },
    { handle: "sw", x: annotation.x, y: annotation.y + annotation.height },
    { handle: "se", x: annotation.x + annotation.width, y: annotation.y + annotation.height }
  ];
}

function getShapeResizeHandle(annotation: ShapeAnnotation, x: number, y: number): ShapeHandle | null {
  const match = getShapeHandleCoordinates(annotation).find(
    (candidate) => Math.hypot(candidate.x - x, candidate.y - y) <= SHAPE_HANDLE_RADIUS
  );
  return match?.handle ?? null;
}

function findTopShapeAnnotation(annotations: Annotation[], x: number, y: number): ShapeAnnotation | null {
  for (let index = annotations.length - 1; index >= 0; index -= 1) {
    const annotation = annotations[index];
    if (annotation?.type === "shape" && hitTestAnnotation(annotation, x, y, 0)) {
      return annotation;
    }
  }

  return null;
}

function shouldCaptureEditorGesture(
  event: ReactPointerEvent<SVGSVGElement>,
  tool: EditorTool,
  palmSettings: PalmSettings
): boolean {
  return tool !== "hand" && !shouldIgnorePointer(event, palmSettings);
}

function EditorCanvasInner({
  page,
  fileUrl,
  fileSize,
  previewUrl,
  viewportWidthHint,
  zoom,
  tool,
  color,
  strokeWidth,
  lineStyle,
  eraserSize,
  shapeKind,
  shapeFilled,
  palmSettings,
  annotationRevision,
  onChange
}: EditorCanvasProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const annotationsRef = useRef<Annotation[]>(page.annotations);
  const drawingRef = useRef(false);
  const erasingRef = useRef(false);
  const pointerScrollRef = useRef<PointerScrollState | null>(null);
  const momentumFrameRef = useRef<number | null>(null);
  const shapeInteractionRef = useRef<ShapeInteractionState | null>(null);
  const shapePreviewRef = useRef<ShapeAnnotation | null>(null);
  const shapeRenderFrameRef = useRef<number | null>(null);
  const lastPenInteractionAtRef = useRef(0);
  const draftStrokeRef = useRef<Extract<Annotation, { type: "stroke" }> | null>(null);
  const draftRenderFrameRef = useRef<number | null>(null);
  const revisionRef = useRef(annotationRevision);
  const eraserCursorRef = useRef<SVGCircleElement | null>(null);
  const [availableWidth, setAvailableWidth] = useState(() => Math.max(0, viewportWidthHint ?? 0));
  const [localAnnotations, setLocalAnnotations] = useState<Annotation[]>(page.annotations);
  const [draftStroke, setDraftStroke] = useState<Extract<Annotation, { type: "stroke" }> | null>(null);
  const [shapePreview, setShapePreview] = useState<ShapeAnnotation | null>(null);
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);

  useEffect(() => {
    annotationsRef.current = page.annotations;
    setLocalAnnotations(page.annotations);
    draftStrokeRef.current = null;
    if (draftRenderFrameRef.current != null) {
      window.cancelAnimationFrame(draftRenderFrameRef.current);
      draftRenderFrameRef.current = null;
    }
    setDraftStroke(null);
    shapePreviewRef.current = null;
    if (shapeRenderFrameRef.current != null) {
      window.cancelAnimationFrame(shapeRenderFrameRef.current);
      shapeRenderFrameRef.current = null;
    }
    setShapePreview(null);
    setSelectedShapeId(null);
    setEditingTextId(null);
    revisionRef.current = annotationRevision;
  }, [page.id]);

  useEffect(() => {
    // Only accept incoming annotations when the parent explicitly signals a
    // change via the revision counter (undo/redo, page reload, external
    // edits).  Normal drawing never bumps the revision, so save-triggered
    // re-renders can never accidentally overwrite in-progress strokes.
    if (annotationRevision !== revisionRef.current) {
      revisionRef.current = annotationRevision;
      annotationsRef.current = page.annotations;
      setLocalAnnotations(page.annotations);
      if (selectedShapeId && !page.annotations.some((annotation) => annotation.type === "shape" && annotation.id === selectedShapeId)) {
        setSelectedShapeId(null);
      }
    }
  }, [annotationRevision, page.annotations, selectedShapeId]);

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
      if (shapeRenderFrameRef.current != null) {
        window.cancelAnimationFrame(shapeRenderFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (tool !== "shape") {
      shapeInteractionRef.current = null;
      shapePreviewRef.current = null;
      if (shapeRenderFrameRef.current != null) {
        window.cancelAnimationFrame(shapeRenderFrameRef.current);
        shapeRenderFrameRef.current = null;
      }
      setShapePreview(null);
      setSelectedShapeId(null);
    }
  }, [tool]);

  // Defeat iPadOS Scribble — the handwriting-recognition feature intercepts
  // Apple Pencil pointer events at the OS level (WebKit bug #217430), causing
  // pointerdown/pointerup events to be swallowed during rapid stylus input.
  // Calling preventDefault() on touchstart/touchmove tells iPadOS that this
  // element handles its own stylus input, so Scribble backs off.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) {
      return;
    }

    function preventScribble(event: TouchEvent): void {
      // Only block touch defaults when a drawing tool is active.
      // For the hand tool, let the browser handle pan/zoom natively.
      if (tool === "hand") {
        return;
      }
      event.preventDefault();
    }

    svg.addEventListener("touchstart", preventScribble, { passive: false });
    svg.addEventListener("touchmove", preventScribble, { passive: false });

    return () => {
      svg.removeEventListener("touchstart", preventScribble);
      svg.removeEventListener("touchmove", preventScribble);
    };
  }, [tool]);

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
      const previous = stroke.points.length ? stroke.points[stroke.points.length - 1] : undefined;
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

  function scheduleShapePreviewRender(): void {
    if (shapeRenderFrameRef.current != null) {
      return;
    }

    shapeRenderFrameRef.current = window.requestAnimationFrame(() => {
      shapeRenderFrameRef.current = null;
      const currentShapePreview = shapePreviewRef.current;
      setShapePreview(currentShapePreview ? { ...currentShapePreview } : null);
    });
  }

  function getPoint(event: ReactPointerEvent<SVGSVGElement>): PointLike {
    return pointFromClient(event.clientX, event.clientY, event.pressure || 0.5);
  }

  function getSelectedShapeAnnotation(): ShapeAnnotation | null {
    const selectedShape = annotationsRef.current.find(
      (annotation): annotation is ShapeAnnotation => annotation.type === "shape" && annotation.id === selectedShapeId
    );

    if (shapePreviewRef.current && shapePreviewRef.current.id === selectedShapeId) {
      return shapePreviewRef.current;
    }

    return selectedShape ?? null;
  }

  function applyAnnotations(nextAnnotations: Annotation[]): void {
    annotationsRef.current = nextAnnotations;
    setLocalAnnotations(nextAnnotations);
    onChange(nextAnnotations);
  }

  function eraseAt(point: PointLike): void {
    const currentAnnotations = annotationsRef.current;
    for (let index = currentAnnotations.length - 1; index >= 0; index -= 1) {
      if (hitTestAnnotation(currentAnnotations[index], point.x, point.y, eraserSize)) {
        const nextAnnotations = [...currentAnnotations];
        nextAnnotations.splice(index, 1);
        applyAnnotations(nextAnnotations);
        break;
      }
    }
  }

  function updateEraserCursor(event: ReactPointerEvent<SVGSVGElement>): void {
    const circle = eraserCursorRef.current;
    if (!circle) return;
    const point = getPoint(event);
    circle.setAttribute("cx", String(point.x));
    circle.setAttribute("cy", String(point.y));
    circle.setAttribute("r", String(eraserSize / 2));
    circle.style.opacity = "1";
  }

  function hideEraserCursor(): void {
    const circle = eraserCursorRef.current;
    if (circle) circle.style.opacity = "0";
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
    applyAnnotations([...annotationsRef.current, next]);
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
    applyAnnotations([
      ...annotationsRef.current,
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

  function buildInteractiveShape(
    interaction: ShapeInteractionState,
    point: PointLike
  ): ShapeAnnotation {
    if (interaction.mode === "create") {
      return clampShapeToPage(
        {
          ...interaction.initialShape,
          ...normalizeShapeRect(interaction.originPoint.x, interaction.originPoint.y, point.x, point.y)
        },
        page
      );
    }

    if (interaction.mode === "move") {
      return clampShapeToPage(
        {
          ...interaction.initialShape,
          x: interaction.initialShape.x + (point.x - interaction.originPoint.x),
          y: interaction.initialShape.y + (point.y - interaction.originPoint.y)
        },
        page
      );
    }

    const initialShape = interaction.initialShape;
    const oppositeX = interaction.handle === "nw" || interaction.handle === "sw" ? initialShape.x + initialShape.width : initialShape.x;
    const oppositeY = interaction.handle === "nw" || interaction.handle === "ne" ? initialShape.y + initialShape.height : initialShape.y;

    return clampShapeToPage(
      {
        ...initialShape,
        ...normalizeShapeRect(oppositeX, oppositeY, point.x, point.y)
      },
      page
    );
  }

  function commitShapePreview(): void {
    const interaction = shapeInteractionRef.current;
    const nextShape = shapePreviewRef.current;
    shapeInteractionRef.current = null;

    if (shapeRenderFrameRef.current != null) {
      window.cancelAnimationFrame(shapeRenderFrameRef.current);
      shapeRenderFrameRef.current = null;
    }

    shapePreviewRef.current = null;
    setShapePreview(null);

    if (!interaction || !nextShape) {
      return;
    }

    if (interaction.mode === "create") {
      if (nextShape.width < MIN_SHAPE_SIZE && nextShape.height < MIN_SHAPE_SIZE) {
        setSelectedShapeId(null);
        return;
      }

      applyAnnotations([...annotationsRef.current, nextShape]);
      setSelectedShapeId(nextShape.id);
      return;
    }

    const didChange =
      nextShape.x !== interaction.initialShape.x ||
      nextShape.y !== interaction.initialShape.y ||
      nextShape.width !== interaction.initialShape.width ||
      nextShape.height !== interaction.initialShape.height ||
      nextShape.fill !== interaction.initialShape.fill ||
      nextShape.color !== interaction.initialShape.color ||
      nextShape.strokeWidth !== interaction.initialShape.strokeWidth ||
      nextShape.lineStyle !== interaction.initialShape.lineStyle;

    setSelectedShapeId(nextShape.id);
    if (!didChange) {
      return;
    }

    applyAnnotations(
      annotationsRef.current.map((annotation) =>
        annotation.id === nextShape.id ? nextShape : annotation
      )
    );
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
      updateEraserCursor(event);
      eraseAt(point);
      return;
    }

    if (tool === "shape") {
      const selectedShape = getSelectedShapeAnnotation();
      const resizeHandle = selectedShape ? getShapeResizeHandle(selectedShape, point.x, point.y) : null;

      if (resizeHandle && selectedShape) {
        svgRef.current?.setPointerCapture(event.pointerId);
        shapeInteractionRef.current = {
          pointerId: event.pointerId,
          mode: "resize",
          shapeId: selectedShape.id,
          originPoint: point,
          initialShape: { ...selectedShape },
          handle: resizeHandle
        };
        shapePreviewRef.current = { ...selectedShape };
        setShapePreview({ ...selectedShape });
        return;
      }

      const hitShape = findTopShapeAnnotation(annotationsRef.current, point.x, point.y);
      if (hitShape) {
        svgRef.current?.setPointerCapture(event.pointerId);
        setSelectedShapeId(hitShape.id);
        shapeInteractionRef.current = {
          pointerId: event.pointerId,
          mode: "move",
          shapeId: hitShape.id,
          originPoint: point,
          initialShape: { ...hitShape }
        };
        shapePreviewRef.current = { ...hitShape };
        setShapePreview({ ...hitShape });
        return;
      }

      const nextShape: ShapeAnnotation = {
        id: createId(),
        type: "shape",
        shape: shapeKind,
        x: point.x,
        y: point.y,
        width: MIN_SHAPE_SIZE,
        height: MIN_SHAPE_SIZE,
        color,
        strokeWidth,
        lineStyle: lineStyle !== "solid" ? lineStyle : undefined,
        fill: shapeFilled
      };
      svgRef.current?.setPointerCapture(event.pointerId);
      setSelectedShapeId(nextShape.id);
      shapeInteractionRef.current = {
        pointerId: event.pointerId,
        mode: "create",
        shapeId: nextShape.id,
        originPoint: point,
        initialShape: nextShape
      };
      shapePreviewRef.current = nextShape;
      setShapePreview(nextShape);
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
      lineStyle: lineStyle !== "solid" ? lineStyle : undefined,
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
    if (shapeInteractionRef.current?.pointerId === event.pointerId) {
      event.preventDefault();
      const nextShape = buildInteractiveShape(shapeInteractionRef.current, getPoint(event));
      shapePreviewRef.current = nextShape;
      scheduleShapePreviewRender();
      return;
    }

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
      updateEraserCursor(event);
      eraseAt(getPoint(event));
      return;
    }

    if (tool === "eraser" && !drawingRef.current) {
      updateEraserCursor(event);
    }
  }

  function handlePointerUp(event: ReactPointerEvent<SVGSVGElement>): void {
    if (shapeInteractionRef.current?.pointerId === event.pointerId) {
      event.preventDefault();
      if (event.pointerType === "pen") {
        lastPenInteractionAtRef.current = performance.now();
      }
      if (shapePreviewRef.current) {
        shapePreviewRef.current = buildInteractiveShape(shapeInteractionRef.current, getPoint(event));
      }
      if (svgRef.current?.hasPointerCapture(event.pointerId)) {
        svgRef.current.releasePointerCapture(event.pointerId);
      }
      commitShapePreview();
      return;
    }

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
    applyAnnotations(
      annotationsRef.current.map((annotation) =>
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
    const annotation = annotationsRef.current.find((entry) => entry.type === "text" && entry.id === annotationId);
    if (annotation?.type === "text" && !annotation.text.trim()) {
      applyAnnotations(annotationsRef.current.filter((entry) => entry.id !== annotationId));
    }
    setEditingTextId(null);
  }

  const fitScale = availableWidth > 0 ? availableWidth / page.width : 1;
  const renderZoom = Math.max(0.2, fitScale * zoom);
  const renderedAnnotations = shapePreview
    ? (() => {
        const replaced = localAnnotations.map((annotation) => (annotation.id === shapePreview.id ? shapePreview : annotation));
        if (replaced.some((annotation) => annotation.id === shapePreview.id)) {
          return replaced;
        }
        return [...replaced, shapePreview];
      })()
    : localAnnotations;
  const selectedShape = tool === "shape"
    ? renderedAnnotations.find(
        (annotation): annotation is ShapeAnnotation => annotation.type === "shape" && annotation.id === selectedShapeId
      ) ?? null
    : null;
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
            fileSize={fileSize}
            previewUrl={previewUrl}
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
          onPointerLeave={(event) => { handlePointerUp(event); hideEraserCursor(); }}
        >
          {renderedAnnotations.map((annotation) => {
            if (annotation.type === "stroke") {
              return (
                <path
                  key={annotation.id}
                  d={buildStrokePath(annotation)}
                  fill="none"
                  stroke={annotation.color}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeOpacity={annotation.tool === "highlighter" ? 0.22 : 1}
                  strokeWidth={annotation.width}
                  strokeDasharray={lineDashArray(annotation.lineStyle, annotation.width)}
                />
              );
            }

            if (annotation.type === "shape") {
              const sharedProps = {
                key: annotation.id,
                fill: annotation.fill ? annotation.color : "transparent",
                fillOpacity: annotation.fill ? 0.16 : 0,
                stroke: annotation.color,
                strokeWidth: annotation.strokeWidth,
                strokeDasharray: lineDashArray(annotation.lineStyle, annotation.strokeWidth)
              };

              if (annotation.shape === "rectangle") {
                return <rect {...sharedProps} x={annotation.x} y={annotation.y} width={annotation.width} height={annotation.height} rx={10} />;
              }

              if (annotation.shape === "ellipse") {
                return (
                  <ellipse
                    {...sharedProps}
                    cx={annotation.x + annotation.width / 2}
                    cy={annotation.y + annotation.height / 2}
                    rx={annotation.width / 2}
                    ry={annotation.height / 2}
                  />
                );
              }

              return <polygon {...sharedProps} points={shapePoints(annotation)} />;
            }

            return null;
          })}

          {draftStroke ? (
            <path
              d={buildStrokePath(draftStroke)}
              fill="none"
              stroke={draftStroke.color}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeOpacity={draftStroke.tool === "highlighter" ? 0.22 : 1}
              strokeWidth={draftStroke.width}
              strokeDasharray={lineDashArray(draftStroke.lineStyle, draftStroke.width)}
            />
          ) : null}

          {tool === "eraser" && (
            <circle
              ref={eraserCursorRef}
              className="eraser-cursor"
              cx={0}
              cy={0}
              r={eraserSize / 2}
              fill="rgba(255,255,255,0.25)"
              stroke="rgba(50,50,50,0.8)"
              strokeWidth={2}
              strokeDasharray="5 4"
              pointerEvents="none"
            />
          )}
        </svg>

        {selectedShape ? (
          <svg className="shape-selection-layer" viewBox={`0 0 ${page.width} ${page.height}`}>
            <rect
              className="shape-selection-outline"
              x={selectedShape.x}
              y={selectedShape.y}
              width={selectedShape.width}
              height={selectedShape.height}
              rx={selectedShape.shape === "ellipse" ? selectedShape.width / 2 : 10}
            />
            {getShapeHandleCoordinates(selectedShape).map((handle) => (
              <circle
                key={handle.handle}
                className="shape-selection-handle"
                cx={handle.x}
                cy={handle.y}
                r={SHAPE_HANDLE_RADIUS / 2}
              />
            ))}
          </svg>
        ) : null}

        {renderedAnnotations.map((annotation) => {
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

export const EditorCanvas = memo(EditorCanvasInner, (previousProps, nextProps) => {
  return (
    previousProps.page.id === nextProps.page.id &&
    previousProps.annotationRevision === nextProps.annotationRevision &&
    previousProps.page.width === nextProps.page.width &&
    previousProps.page.height === nextProps.page.height &&
    previousProps.page.kind === nextProps.page.kind &&
    previousProps.page.template === nextProps.page.template &&
    previousProps.page.sourcePageIndex === nextProps.page.sourcePageIndex &&
    previousProps.fileUrl === nextProps.fileUrl &&
    previousProps.fileSize === nextProps.fileSize &&
    previousProps.previewUrl === nextProps.previewUrl &&
    previousProps.viewportWidthHint === nextProps.viewportWidthHint &&
    previousProps.zoom === nextProps.zoom &&
    previousProps.tool === nextProps.tool &&
    previousProps.color === nextProps.color &&
    previousProps.strokeWidth === nextProps.strokeWidth &&
    previousProps.lineStyle === nextProps.lineStyle &&
    previousProps.eraserSize === nextProps.eraserSize &&
    previousProps.shapeKind === nextProps.shapeKind &&
    previousProps.shapeFilled === nextProps.shapeFilled &&
    previousProps.palmSettings.stylusOnly === nextProps.palmSettings.stylusOnly &&
    previousProps.palmSettings.maxTouchArea === nextProps.palmSettings.maxTouchArea
  );
});
