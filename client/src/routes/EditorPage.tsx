import { startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { EditorCanvas } from "../components/EditorCanvas";
import { PdfThumbnail } from "../components/PdfThumbnail";
import { api } from "../lib/api";
import { collectAnnotationText } from "../lib/annotations";
import { deleteDraft, getDraftsForDocument, saveDraft } from "../lib/drafts";
import { loadPdfPage, preloadPreviewImage, prewarmPdfPagePreview, resolvePreviewWidthBucket, scaleCachesForDocument } from "../lib/pdf";
import { saveAnnotationsInWorker } from "../lib/saveWorkerClient";
import { SyncClient } from "../lib/syncClient";
import type {
  Annotation,
  DocumentBundle,
  EditorTool,
  FileRecord,
  LineStyle,
  PageRecord,
  PageSearchResult,
  PageTemplate,
  PalmSettings,
  ShapeKind
} from "../types";

const inkColors = ["#14324E", "#BC412B", "#208B7A", "#8D5A97", "#C87E2A", "#111111"];
const HISTORY_LIMIT = 60;
const THUMBNAIL_PREVIEW_RADIUS = 3;
const RENDER_AHEAD_RADIUS = 3;
const PREFETCH_RADIUS = 6;
const HYDRATED_RENDER_RADIUS = 8;
const INITIAL_HYDRATE_RADIUS = 12;
const HYDRATED_PAGE_LIMIT = 28;
const COMPACT_LAYOUT_QUERY = "(max-width: 1100px)";
const LOCAL_DRAFT_DELAY_MS = 3000;
const REMOTE_SAVE_IDLE_MS = 2000;
const REMOTE_SAVE_RETRY_MS = 3000;

const eraserSizes = [10, 20, 36, 56];
const penSizes = [1, 2, 4, 6, 10];
const highlighterSizes = [4, 8, 12, 18];
const lineStyles: { value: LineStyle; label: string }[] = [
  { value: "solid", label: "Solid" },
  { value: "dashed", label: "Dashed" },
  { value: "dotted", label: "Dotted" }
];

const toolDefinitions: Array<{ value: EditorTool; label: string; icon: IconName }> = [
  { value: "pen", label: "Pen", icon: "pen" },
  { value: "highlighter", label: "Highlighter", icon: "highlighter" },
  { value: "eraser", label: "Eraser", icon: "eraser" },
  { value: "text", label: "Text", icon: "text" },
  { value: "shape", label: "Shapes", icon: "shape" },
  { value: "hand", label: "Hand", icon: "hand" }
];

const shapeDefinitions: Array<{ value: ShapeKind; label: string }> = [
  { value: "rectangle", label: "Rectangle" },
  { value: "ellipse", label: "Ellipse" },
  { value: "triangle", label: "Triangle" },
  { value: "diamond", label: "Diamond" }
];

type IconName =
  | "pen"
  | "highlighter"
  | "eraser"
  | "text"
  | "hand"
  | "pages"
  | "plus"
  | "back"
  | "close"
  | "undo"
  | "redo"
  | "search"
  | "export"
  | "shape";

function clampZoom(value: number): number {
  return Math.min(2.6, Math.max(0.45, Number(value.toFixed(2))));
}

function cloneAnnotations(annotations: Annotation[]): Annotation[] {
  return annotations.map((annotation) => {
    if (annotation.type === "stroke") {
      return {
        ...annotation,
        points: annotation.points.map((point) => ({ ...point }))
      };
    }

    return { ...annotation };
  });
}

function IconGlyph({ name }: { name: IconName }) {
  switch (name) {
    case "pen":
      return (
        <svg aria-hidden="true" className="ui-icon" viewBox="0 0 24 24">
          <path d="M6 16.5 16.7 5.8a1.5 1.5 0 0 1 2.1 0l.4.4a1.5 1.5 0 0 1 0 2.1L8.5 19H5v-3.5Z" />
          <path d="M13.5 9.5 18 14" />
        </svg>
      );
    case "highlighter":
      return (
        <svg aria-hidden="true" className="ui-icon" viewBox="0 0 24 24">
          <path d="m7 14 6.8-6.8a1.8 1.8 0 0 1 2.5 0l1.5 1.5a1.8 1.8 0 0 1 0 2.5L11 18H7v-4Z" />
          <path d="M5 19h14" />
        </svg>
      );
    case "eraser":
      return (
        <svg aria-hidden="true" className="ui-icon" viewBox="0 0 24 24">
          <path d="m8 7.5 5-5a2 2 0 0 1 2.8 0l5.7 5.7a2 2 0 0 1 0 2.8L15 17.5H8.8L3.5 12.2a2 2 0 0 1 0-2.8L8 7.5Z" />
          <path d="M6 18h12" />
        </svg>
      );
    case "text":
      return (
        <svg aria-hidden="true" className="ui-icon" viewBox="0 0 24 24">
          <path d="M4 6h16" />
          <path d="M12 6v12" />
          <path d="M8 18h8" />
        </svg>
      );
    case "hand":
      return (
        <svg aria-hidden="true" className="ui-icon" viewBox="0 0 24 24">
          <path d="M8.5 11V5.5a1.5 1.5 0 1 1 3 0V10" />
          <path d="M11.5 10V4.5a1.5 1.5 0 1 1 3 0V10" />
          <path d="M14.5 10V6a1.5 1.5 0 1 1 3 0v7.5c0 3.3-2.7 6-6 6H10a6 6 0 0 1-6-6v-2.5a1.5 1.5 0 1 1 3 0V13" />
        </svg>
      );
    case "shape":
      return (
        <svg aria-hidden="true" className="ui-icon" viewBox="0 0 24 24">
          <rect height="12" rx="2" width="12" x="6" y="6" />
          <circle cx="18" cy="18" r="2" fill="currentColor" stroke="none" />
        </svg>
      );
    case "pages":
      return (
        <svg aria-hidden="true" className="ui-icon" viewBox="0 0 24 24">
          <rect height="12" rx="2" width="10" x="4" y="6" />
          <path d="M10 4h8a2 2 0 0 1 2 2v10" />
        </svg>
      );
    case "plus":
      return (
        <svg aria-hidden="true" className="ui-icon" viewBox="0 0 24 24">
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
      );
    case "back":
      return (
        <svg aria-hidden="true" className="ui-icon" viewBox="0 0 24 24">
          <path d="M15 5 8 12l7 7" />
        </svg>
      );
    case "close":
      return (
        <svg aria-hidden="true" className="ui-icon" viewBox="0 0 24 24">
          <path d="M6 6 18 18" />
          <path d="M18 6 6 18" />
        </svg>
      );
    case "undo":
      return (
        <svg aria-hidden="true" className="ui-icon" viewBox="0 0 24 24">
          <path d="M9 9H5V5" />
          <path d="M5 9c2-3 5-4 8-4 4.4 0 8 3.6 8 8s-3.6 8-8 8c-3 0-5.7-1.4-7.2-3.7" />
        </svg>
      );
    case "redo":
      return (
        <svg aria-hidden="true" className="ui-icon" viewBox="0 0 24 24">
          <path d="M15 9h4V5" />
          <path d="M19 9c-2-3-5-4-8-4-4.4 0-8 3.6-8 8s3.6 8 8 8c3 0 5.7-1.4 7.2-3.7" />
        </svg>
      );
    case "search":
      return (
        <svg aria-hidden="true" className="ui-icon" viewBox="0 0 24 24">
          <circle cx="11" cy="11" r="6" />
          <path d="m20 20-4.2-4.2" />
        </svg>
      );
    case "export":
      return (
        <svg aria-hidden="true" className="ui-icon" viewBox="0 0 24 24">
          <path d="M12 4v11" />
          <path d="m7 9 5-5 5 5" />
          <path d="M5 19h14" />
        </svg>
      );
    default:
      return null;
  }
}

function ShapeKindGlyph({ shape }: { shape: ShapeKind }) {
  if (shape === "rectangle") {
    return (
      <svg aria-hidden="true" className="shape-kind-glyph" viewBox="0 0 24 24">
        <rect height="12" rx="3" width="16" x="4" y="6" />
      </svg>
    );
  }

  if (shape === "ellipse") {
    return (
      <svg aria-hidden="true" className="shape-kind-glyph" viewBox="0 0 24 24">
        <ellipse cx="12" cy="12" rx="8" ry="6" />
      </svg>
    );
  }

  if (shape === "triangle") {
    return (
      <svg aria-hidden="true" className="shape-kind-glyph" viewBox="0 0 24 24">
        <path d="M12 5 20 19H4Z" />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" className="shape-kind-glyph" viewBox="0 0 24 24">
      <path d="M12 4 19 12 12 20 5 12Z" />
    </svg>
  );
}

function ShapeFillGlyph({ filled }: { filled: boolean }) {
  return (
    <svg aria-hidden="true" className="shape-kind-glyph" viewBox="0 0 24 24">
      <rect
        x="5"
        y="5"
        width="14"
        height="14"
        rx="3"
        fill={filled ? "currentColor" : "none"}
        fillOpacity={filled ? 0.22 : 0}
      />
      <path d="M5 19V5h14" />
      <path d="M5 19h14V5" />
    </svg>
  );
}

export function EditorPage() {
  const { documentId = "" } = useParams();
  const navigate = useNavigate();
  const dirtyPagesRef = useRef(new Set<string>());
  const bundleRef = useRef<DocumentBundle | null>(null);
  const historyRef = useRef(new Map<string, { past: Annotation[][]; future: Annotation[][] }>());
  const annotationRevisionRef = useRef(new Map<string, number>());
  const pagePanelRef = useRef<HTMLElement | null>(null);
  const pageElementRefs = useRef(new Map<string, HTMLDivElement>());
  const thumbnailElementRefs = useRef(new Map<string, HTMLButtonElement>());
  const compactThumbnailRailRef = useRef<HTMLDivElement | null>(null);
  const visibleRatiosRef = useRef(new Map<string, number>());
  const hydratedPageOrderRef = useRef<string[]>([]);
  const activePageIdRef = useRef("");
  const pendingActivePageIdRef = useRef<string | null>(null);
  const pendingInitialFocusPageIdRef = useRef<string | null>(null);
  const touchScrollActiveRef = useRef(false);
  const touchScrollEndTimerRef = useRef<number | null>(null);
  const scrollVelocityRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const lastScrollTimeRef = useRef(0);
  const saveTimerRef = useRef<number | null>(null);
  const draftPersistTimerRef = useRef<number | null>(null);
  const bundleFlushTimerRef = useRef<number | null>(null);
  const saveInFlightRef = useRef(false);
  const saveAgainRef = useRef(false);
  const pendingDraftPagesRef = useRef(new Set<string>());
  const pendingPageStateRef = useRef(new Map<string, { annotations: Annotation[]; annotationText: string }>());
  const syncedPageStateRef = useRef(new Map<string, { annotations: Annotation[]; annotationText: string }>());
  const lastEditAtRef = useRef(0);
  const syncClientRef = useRef<SyncClient | null>(null);
  const [bundle, setBundle] = useState<DocumentBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activePageId, setActivePageId] = useState<string>("");
  const [tool, setTool] = useState<EditorTool>("pen");
  const [inkColor, setInkColor] = useState(inkColors[0]);
  const [strokeWidth, setStrokeWidth] = useState(4);
  const [lineStyle, setLineStyle] = useState<LineStyle>("solid");
  const [eraserSize, setEraserSize] = useState(20);
  const [shapeKind, setShapeKind] = useState<ShapeKind>("rectangle");
  const [shapeFilled, setShapeFilled] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PageSearchResult[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [insertTemplate, setInsertTemplate] = useState<PageTemplate>("ruled");
  const [saveState, setSaveState] = useState("All changes saved");
  const [titleDraft, setTitleDraft] = useState("");
  const [pagePanelViewportWidth, setPagePanelViewportWidth] = useState(0);
  const [visiblePageIds, setVisiblePageIds] = useState<string[]>([]);
  const [visibleCompactThumbnailIds, setVisibleCompactThumbnailIds] = useState<string[]>([]);
  const [hydratedPageIds, setHydratedPageIds] = useState<string[]>([]);
  const [isCompactLayout, setIsCompactLayout] = useState(
    () => typeof window !== "undefined" && window.matchMedia(COMPACT_LAYOUT_QUERY).matches
  );
  const [compactPagesOpen, setCompactPagesOpen] = useState(false);
  const [compactActionsOpen, setCompactActionsOpen] = useState(false);
  const [compactHeaderVisible, setCompactHeaderVisible] = useState(false);
  const swipeTouchRef = useRef<{ startX: number; startY: number } | null>(null);
  const [pdfInsertOpen, setPdfInsertOpen] = useState(false);
  const [pdfInsertPlacement, setPdfInsertPlacement] = useState<"before" | "after">("after");
  const [pdfInsertPageRange, setPdfInsertPageRange] = useState("");
  const [pdfInsertFile, setPdfInsertFile] = useState<File | null>(null);
  const [pdfInsertBusy, setPdfInsertBusy] = useState(false);
  const pdfFileInputRef = useRef<HTMLInputElement | null>(null);
  const [palmSettings, setPalmSettings] = useState<PalmSettings>({
    stylusOnly: true,
    maxTouchArea: 160
  });
  const debugEnabled =
    typeof window !== "undefined" &&
    (window.location.search.includes("inkflowDebug=1") || window.localStorage.getItem("inkflow-debug") === "1");
  const pageStructureKey = bundle
    ? bundle.pages
        .map(
          (page) =>
            `${page.id}:${page.position}:${page.kind}:${page.sourceFileId ?? ""}:${page.sourcePageIndex ?? ""}:${page.template ?? ""}`
        )
        .join("|")
    : "";
  const fileStructureKey = bundle ? bundle.files.map((file) => `${file.id}:${file.url}`).join("|") : "";

  function clearSaveTimer(): void {
    if (saveTimerRef.current != null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }

  function clearDraftPersistTimer(): void {
    if (draftPersistTimerRef.current != null) {
      window.clearTimeout(draftPersistTimerRef.current);
      draftPersistTimerRef.current = null;
    }
  }

  function clearBundleFlushTimer(): void {
    if (bundleFlushTimerRef.current != null) {
      window.clearTimeout(bundleFlushTimerRef.current);
      bundleFlushTimerRef.current = null;
    }
  }

  function scheduleBundleFlush(): void {
    if (bundleFlushTimerRef.current != null) {
      return;
    }
    bundleFlushTimerRef.current = window.setTimeout(() => {
      bundleFlushTimerRef.current = null;
      if (touchScrollActiveRef.current) {
        scheduleBundleFlush();
        return;
      }
      startTransition(() => {
        flushPendingPageStateToBundle();
      });
    }, 800);
  }

  function flushPendingActivePage(): void {
    const pendingActivePageId = pendingActivePageIdRef.current;
    if (!pendingActivePageId || pendingActivePageId === activePageIdRef.current) {
      return;
    }

    pendingActivePageIdRef.current = null;
    activePageIdRef.current = pendingActivePageId;
    startTransition(() => {
      setActivePageId(pendingActivePageId);
    });
  }

  function setTouchScrollActive(nextValue: boolean): void {
    touchScrollActiveRef.current = nextValue;
    if (!nextValue) {
      // Batch ALL scroll-end state updates in a single startTransition
      // so React can yield to the browser's scroll handling between frames.
      // Without this, the re-render for 1500 pages blocks the main thread.
      startTransition(() => {
        const sortedVisibleIds = [...visibleRatiosRef.current.entries()]
          .sort((left, right) => right[1] - left[1])
          .map(([pageId]) => pageId);

        setVisiblePageIds((current) => {
          if (current.length === sortedVisibleIds.length && current.every((pageId, index) => pageId === sortedVisibleIds[index])) {
            return current;
          }
          return sortedVisibleIds;
        });

        const pendingActivePageId = pendingActivePageIdRef.current;
        if (pendingActivePageId && pendingActivePageId !== activePageIdRef.current) {
          pendingActivePageIdRef.current = null;
          activePageIdRef.current = pendingActivePageId;
          setActivePageId(pendingActivePageId);
        }
      });
    }
  }

  function getEffectivePage(pageId: string, sourceBundle = bundleRef.current): PageRecord | null {
    if (!sourceBundle) {
      return null;
    }

    const page = sourceBundle.pages.find((entry) => entry.id === pageId);
    if (!page) {
      return null;
    }

    const pendingPageState = pendingPageStateRef.current.get(pageId);
    if (!pendingPageState) {
      return page;
    }

    return {
      ...page,
      annotations: pendingPageState.annotations,
      annotationText: pendingPageState.annotationText
    };
  }

  function flushPendingPageStateToBundle(): void {
    if (pendingPageStateRef.current.size === 0) {
      return;
    }

    setBundle((currentBundle) => {
      if (!currentBundle) {
        return currentBundle;
      }

      let didChange = false;
      const nextPages = currentBundle.pages.map((page) => {
        const pendingPageState = pendingPageStateRef.current.get(page.id);
        if (!pendingPageState) {
          return page;
        }

        if (page.annotations === pendingPageState.annotations && page.annotationText === pendingPageState.annotationText) {
          return page;
        }

        didChange = true;
        return {
          ...page,
          annotations: pendingPageState.annotations,
          annotationText: pendingPageState.annotationText
        };
      });

      if (!didChange) {
        return currentBundle;
      }

      const nextBundle = {
        ...currentBundle,
        pages: nextPages
      };
      bundleRef.current = nextBundle;
      return nextBundle;
    });
  }

  async function flushDraftPersistence(): Promise<void> {
    const currentBundle = bundleRef.current;
    if (!currentBundle || pendingDraftPagesRef.current.size === 0) {
      return;
    }

    const pageIds = [...pendingDraftPagesRef.current];
    pendingDraftPagesRef.current.clear();

    try {
      await Promise.all(
        pageIds.map(async (pageId) => {
          const page = getEffectivePage(pageId, currentBundle);
          if (!page) {
            return;
          }

          await saveDraft({
            documentId: currentBundle.document.id,
            pageId,
            annotations: page.annotations,
            annotationText: page.annotationText
          });
        })
      );
    } catch {
      pageIds.forEach((pageId) => pendingDraftPagesRef.current.add(pageId));
    }
  }

  function scheduleDraftPersistence(delay = LOCAL_DRAFT_DELAY_MS): void {
    clearDraftPersistTimer();
    draftPersistTimerRef.current = window.setTimeout(() => {
      draftPersistTimerRef.current = null;
      void flushDraftPersistence();
    }, delay);
  }

  async function flushDirtyPages(): Promise<void> {
    const currentBundle = bundleRef.current;
    if (!currentBundle || dirtyPagesRef.current.size === 0) {
      return;
    }

    if (saveInFlightRef.current) {
      saveAgainRef.current = true;
      return;
    }

    const msSinceLastEdit = performance.now() - lastEditAtRef.current;
    if (msSinceLastEdit < REMOTE_SAVE_IDLE_MS) {
      scheduleSave(Math.max(REMOTE_SAVE_IDLE_MS - msSinceLastEdit, 250));
      return;
    }

    // Flush any deferred bundle updates before saving so that the bundle
    // reflects the latest annotations (for thumbnails, etc.) after save.
    clearBundleFlushTimer();
    flushPendingPageStateToBundle();

    saveInFlightRef.current = true;
    const pageIds = [...dirtyPagesRef.current];
    dirtyPagesRef.current.clear();

    try {
      startTransition(() => {
        setSaveState("Syncing...");
      });

      for (const pageId of pageIds) {
        const page = getEffectivePage(pageId, currentBundle);
        if (!page) {
          continue;
        }

        const syncedPageState = syncedPageStateRef.current.get(page.id) ?? {
          annotations: [],
          annotationText: ""
        };
        // Use annotation IDs to detect append-safe saves.  Reference equality
        // (===) breaks when another client's update replaces syncedPageState
        // with deserialized annotations.  ID comparison is reliable across clients.
        const canAppend =
          page.annotations.length >= syncedPageState.annotations.length &&
          syncedPageState.annotations.every((annotation, index) => page.annotations[index]?.id === annotation.id);
        const nextAnnotations = canAppend ? page.annotations.slice(syncedPageState.annotations.length) : page.annotations;
        const saveMode = canAppend && nextAnnotations.length > 0 ? "append" : "replace";

        const startedAt = performance.now();
        await saveAnnotationsInWorker(page.id, nextAnnotations, page.annotationText, saveMode, syncClientRef.current?.getClientId() ?? "");
        if (debugEnabled) {
          console.info("[Inkflow] Save settled", {
            pageId: page.id,
            mode: saveMode,
            durationMs: performance.now() - startedAt,
            annotationCount: nextAnnotations.length
          });
        }
        syncedPageStateRef.current.set(page.id, {
          annotations: page.annotations,
          annotationText: page.annotationText
        });
      }

      // Only delete drafts for pages that have no further pending changes.
      // If the user drew new strokes while the save was in flight, the page
      // is still dirty and the draft must be kept as a crash-recovery safety net.
      const fullyFlushedPageIds = pageIds.filter((pageId) => !dirtyPagesRef.current.has(pageId));
      if (fullyFlushedPageIds.length > 0) {
        await Promise.all(fullyFlushedPageIds.map((pageId) => deleteDraft(currentBundle.document.id, pageId)));
      }

      if (dirtyPagesRef.current.size === 0) {
        startTransition(() => {
          setSaveState("All changes saved");
        });
      }
    } catch (nextError) {
      pageIds.forEach((pageId) => dirtyPagesRef.current.add(pageId));
      setError(nextError instanceof Error ? nextError.message : "Could not save annotations.");
      startTransition(() => {
        setSaveState("Saved locally");
      });
    } finally {
      saveInFlightRef.current = false;
      if (dirtyPagesRef.current.size > 0 || saveAgainRef.current) {
        saveAgainRef.current = false;
        const nextDelay = Math.max(REMOTE_SAVE_IDLE_MS - (performance.now() - lastEditAtRef.current), REMOTE_SAVE_RETRY_MS);
        scheduleSave(nextDelay);
      }
    }
  }

  function scheduleSave(delay = REMOTE_SAVE_IDLE_MS): void {
    clearSaveTimer();
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void flushDirtyPages();
    }, delay);
  }

  async function loadDocument(options?: { skipDrafts?: boolean }): Promise<void> {
    // Only show the full loading screen on initial load (no existing bundle).
    // For refreshes (WebSocket sync, visibility change), keep the current view
    // alive so rendered PDF pages aren't unmounted and re-created from scratch.
    if (!bundleRef.current) {
      setLoading(true);
    }
    try {
      const serverBundle = await api.getDocument(documentId, { lite: true });
      const skipDrafts = options?.skipDrafts ?? false;
      const localDrafts = skipDrafts ? new Map() : await getDraftsForDocument(documentId);
      pendingPageStateRef.current.clear();
      syncedPageStateRef.current = new Map(
        serverBundle.pages.map((page) => [
          page.id,
          {
            annotations: page.annotations,
            annotationText: page.annotationText
          }
        ])
      );

      // Only apply drafts that are actually newer than the server page.
      // This prevents stale local drafts from overwriting changes that another
      // client has already saved to the server.
      const applicableDrafts = new Map<string, typeof localDrafts extends Map<string, infer V> ? V : never>();
      if (localDrafts.size > 0) {
        for (const [pageId, draftRecord] of localDrafts) {
          const serverPage = serverBundle.pages.find((p) => p.id === pageId);
          if (!serverPage) {
            // Page no longer exists on server — discard stale draft
            void deleteDraft(documentId, pageId);
            continue;
          }
          const serverUpdatedAt = new Date(serverPage.updatedAt).getTime();
          if (draftRecord.updatedAt > serverUpdatedAt) {
            applicableDrafts.set(pageId, draftRecord);
          } else {
            // Server is newer — discard stale draft
            void deleteDraft(documentId, pageId);
          }
        }
      }

      const nextBundle =
        applicableDrafts.size > 0
          ? {
              ...serverBundle,
              pages: serverBundle.pages.map((page) => {
                const draftRecord = applicableDrafts.get(page.id);
                if (!draftRecord) {
                  return page;
                }

                return {
                  ...page,
                  annotations: draftRecord.annotations,
                  annotationText: draftRecord.annotationText
                };
              })
            }
          : serverBundle;

      bundleRef.current = nextBundle;
      scaleCachesForDocument(nextBundle.pages.length);
      setBundle(nextBundle);
      setTitleDraft(nextBundle.document.title);
      const bookmarkPageId =
        nextBundle.document.bookmarkPageId && nextBundle.pages.some((page) => page.id === nextBundle.document.bookmarkPageId)
          ? nextBundle.document.bookmarkPageId
          : null;
      const nextActivePageId = nextBundle.pages.some((page) => page.id === activePageIdRef.current)
        ? activePageIdRef.current
        : bookmarkPageId ?? nextBundle.pages[0]?.id ?? "";
      pendingInitialFocusPageIdRef.current =
        !activePageIdRef.current && bookmarkPageId && bookmarkPageId === nextActivePageId ? nextActivePageId : null;
      activePageIdRef.current = nextActivePageId;
      setActivePageId(nextActivePageId);
      dirtyPagesRef.current.clear();
      pendingDraftPagesRef.current.clear();
      if (applicableDrafts.size > 0) {
        applicableDrafts.forEach((draftRecord, pageId) => {
          dirtyPagesRef.current.add(pageId);
          pendingPageStateRef.current.set(pageId, {
            annotations: draftRecord.annotations,
            annotationText: draftRecord.annotationText
          });
        });
        lastEditAtRef.current = performance.now();
        startTransition(() => {
          setSaveState("Saved locally");
        });
        scheduleSave();
      } else {
        startTransition(() => {
          setSaveState("All changes saved");
        });
      }
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not open the document.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    bundleRef.current = bundle;
  }, [bundle]);

  useEffect(() => {
    let cancelled = false;
    const trimmedQuery = searchQuery.trim();

    if (!trimmedQuery) {
      setSearchResults([]);
      setSearchBusy(false);
      return;
    }

    setSearchBusy(true);
    const timer = window.setTimeout(() => {
      void api
        .searchDocument(documentId, trimmedQuery)
        .then((payload) => {
          if (!cancelled) {
            setSearchResults(payload.results);
          }
        })
        .catch((nextError) => {
          console.error("[Inkflow] Document search failed.", nextError);
          if (!cancelled) {
            setSearchResults([]);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setSearchBusy(false);
          }
        });
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [documentId, searchQuery]);

  useEffect(() => {
    loadDocument();
    return () => {
      clearSaveTimer();
      clearDraftPersistTimer();
      clearBundleFlushTimer();
      flushPendingPageStateToBundle();
      void flushDraftPersistence();
    };
  }, [documentId]);

  // ── Real-time sync via WebSocket ───────────────────────
  useEffect(() => {
    if (!documentId) return;

    const sync = new SyncClient(documentId, {
      onAnnotationUpdate(pageId, annotations, annotationText) {
        // Another client saved annotations for this page.
        // Update the "last-known server state" so our next save can diff correctly.
        syncedPageStateRef.current.set(pageId, { annotations, annotationText });

        // Only apply remote annotations to the UI if the local user has NOT
        // made unsaved edits on this page.  If dirtyPagesRef includes this page
        // the user's local work takes priority and will be saved & broadcast
        // to the other client shortly.
        if (!dirtyPagesRef.current.has(pageId)) {
          pendingPageStateRef.current.delete(pageId);
          bumpAnnotationRevision(pageId);
          setBundle((currentBundle) => {
            if (!currentBundle) return currentBundle;
            const nextPages = currentBundle.pages.map((p) =>
              p.id === pageId ? { ...p, annotations, annotationText } : p
            );
            const nextBundle = { ...currentBundle, pages: nextPages };
            bundleRef.current = nextBundle;
            return nextBundle;
          });
        }
      },
      onDocumentChanged(_changedDocumentId) {
        // Structural change (page added/deleted/renamed) — reload full bundle.
        // Skip drafts: the server just changed, so server state is authoritative.
        void loadDocument({ skipDrafts: true });
      }
    });
    syncClientRef.current = sync;

    return () => {
      sync.dispose();
      syncClientRef.current = null;
    };
  }, [documentId]);

  useEffect(() => {
    function flushDraftsBeforeBackgrounding(): void {
      void flushDraftPersistence();
    }

    function handleVisibilityChange(): void {
      if (document.visibilityState === "hidden") {
        flushDraftsBeforeBackgrounding();
      } else if (document.visibilityState === "visible") {
        // Coming back from background — only reload if we have NO dirty local
        // edits.  If there are dirty pages the user was mid-edit; a full reload
        // would clobber their unsaved work.  The WebSocket will reconnect and
        // pick up remote changes via the annotationUpdate handler.
        if (dirtyPagesRef.current.size === 0) {
          void loadDocument();
        }
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", flushDraftsBeforeBackgrounding);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", flushDraftsBeforeBackgrounding);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia(COMPACT_LAYOUT_QUERY);
    const syncLayout = (nextMatch?: boolean) => {
      setIsCompactLayout(nextMatch ?? mediaQuery.matches);
    };

    syncLayout();

    const handleChange = (event: MediaQueryListEvent) => {
      syncLayout(event.matches);
    };

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => {
        mediaQuery.removeEventListener("change", handleChange);
      };
    }

    mediaQuery.addListener(handleChange);
    return () => {
      mediaQuery.removeListener(handleChange);
    };
  }, []);

  useLayoutEffect(() => {
    const pagePanelNode = pagePanelRef.current;
    if (!pagePanelNode || typeof ResizeObserver === "undefined") {
      return;
    }

    const updateWidth = (nextWidth?: number) => {
      const measuredWidth = nextWidth ?? pagePanelNode.clientWidth;
      const styles = window.getComputedStyle(pagePanelNode);
      const horizontalPadding = Number.parseFloat(styles.paddingLeft) + Number.parseFloat(styles.paddingRight);
      setPagePanelViewportWidth(Math.max(0, measuredWidth - horizontalPadding));
    };

    updateWidth();

    const observer = new ResizeObserver((entries) => {
      updateWidth(entries[0]?.contentRect.width);
    });

    observer.observe(pagePanelNode);

    return () => {
      observer.disconnect();
    };
  }, [documentId, isCompactLayout]);

  useEffect(() => {
    const pagePanelNode = pagePanelRef.current;
    if (!pagePanelNode) {
      return;
    }

    const markScrollActivity = () => {
      if (touchScrollEndTimerRef.current != null) {
        window.clearTimeout(touchScrollEndTimerRef.current);
        touchScrollEndTimerRef.current = null;
      }
      setTouchScrollActive(true);
      touchScrollEndTimerRef.current = window.setTimeout(() => {
        touchScrollEndTimerRef.current = null;
        setTouchScrollActive(false);
        scrollVelocityRef.current = 0;
      }, 300);
    };

    const trackScrollVelocity = () => {
      const now = performance.now();
      const dt = now - lastScrollTimeRef.current;
      if (dt > 0 && dt < 500) {
        scrollVelocityRef.current = (pagePanelNode.scrollTop - lastScrollTopRef.current) / dt;
      }
      lastScrollTopRef.current = pagePanelNode.scrollTop;
      lastScrollTimeRef.current = now;
    };

    pagePanelNode.addEventListener("touchstart", markScrollActivity, { passive: true });
    pagePanelNode.addEventListener("touchend", markScrollActivity, { passive: true });
    pagePanelNode.addEventListener("touchcancel", markScrollActivity, { passive: true });
    pagePanelNode.addEventListener("scroll", markScrollActivity, { passive: true });
    pagePanelNode.addEventListener("scroll", trackScrollVelocity, { passive: true });

    return () => {
      if (touchScrollEndTimerRef.current != null) {
        window.clearTimeout(touchScrollEndTimerRef.current);
        touchScrollEndTimerRef.current = null;
      }
      pagePanelNode.removeEventListener("touchstart", markScrollActivity);
      pagePanelNode.removeEventListener("touchend", markScrollActivity);
      pagePanelNode.removeEventListener("touchcancel", markScrollActivity);
      pagePanelNode.removeEventListener("scroll", markScrollActivity);
      pagePanelNode.removeEventListener("scroll", trackScrollVelocity);
      setTouchScrollActive(false);
    };
  }, [documentId, loading, isCompactLayout]);

  useEffect(() => {
    historyRef.current.clear();
    visibleRatiosRef.current.clear();
    hydratedPageOrderRef.current = [];
    setVisiblePageIds([]);
    setVisibleCompactThumbnailIds([]);
    setHydratedPageIds([]);
  }, [documentId]);

  useEffect(() => {
    activePageIdRef.current = activePageId;
  }, [activePageId]);

  useEffect(() => {
    const pendingPageId = pendingInitialFocusPageIdRef.current;
    if (!pendingPageId || loading) {
      return;
    }

    const pageNode = pageElementRefs.current.get(pendingPageId);
    if (!pageNode) {
      return;
    }

    pendingInitialFocusPageIdRef.current = null;
    window.requestAnimationFrame(() => {
      pageNode.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: "auto"
      });
    });
  }, [activePageId, loading, pageStructureKey]);

  function rememberHydratedPages(nextPageIds: string[]): void {
    const currentBundle = bundleRef.current;
    if (!currentBundle || nextPageIds.length === 0) {
      return;
    }

    const validPageIdSet = new Set(currentBundle.pages.map((page) => page.id));
    const dedupedTargets = [...new Set(nextPageIds.filter((pageId) => validPageIdSet.has(pageId)))];
    if (dedupedTargets.length === 0) {
      return;
    }

    const remaining = hydratedPageOrderRef.current.filter(
      (pageId) => validPageIdSet.has(pageId) && !dedupedTargets.includes(pageId)
    );
    const nextOrder = [...remaining, ...dedupedTargets].slice(-HYDRATED_PAGE_LIMIT);

    hydratedPageOrderRef.current = nextOrder;
    setHydratedPageIds((current) =>
      current.length === nextOrder.length && current.every((pageId, index) => pageId === nextOrder[index])
        ? current
        : nextOrder
    );
  }

  useEffect(() => {
    if (!isCompactLayout) {
      setCompactActionsOpen(false);
      setCompactPagesOpen(false);
    }
  }, [isCompactLayout]);

  async function commitTitle() {
    if (!bundle) {
      return;
    }

    const trimmedTitle = titleDraft.trim() || "Untitled notebook";
    if (trimmedTitle === bundle.document.title) {
      return;
    }

    try {
      const nextBundle = await api.renameDocument(bundle.document.id, trimmedTitle);
      setBundle(nextBundle);
      setTitleDraft(nextBundle.document.title);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not rename document.");
    }
  }

  async function updateDocumentBookmark(pageId: string | null): Promise<void> {
    if (!bundle) {
      return;
    }

    try {
      const nextBundle = await api.setDocumentBookmark(bundle.document.id, pageId);
      applyBundleUpdate(nextBundle);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not update bookmark.");
    }
  }

  function bumpAnnotationRevision(pageId: string): void {
    annotationRevisionRef.current.set(pageId, (annotationRevisionRef.current.get(pageId) ?? 0) + 1);
  }

  function setPageAnnotations(pageId: string, nextAnnotations: Annotation[], options?: { recordHistory?: boolean; bumpRevision?: boolean }) {
    if (!pageId) {
      return;
    }

    const recordHistory = options?.recordHistory ?? true;
    const nextAnnotationText = collectAnnotationText(nextAnnotations);
    const currentPage = getEffectivePage(pageId);
    if (!currentPage) {
      return;
    }

    if (currentPage.annotations === nextAnnotations) {
      return;
    }

    if (recordHistory) {
      const historyEntry = historyRef.current.get(pageId) ?? { past: [], future: [] };
      historyEntry.past.push(cloneAnnotations(currentPage.annotations));
      if (historyEntry.past.length > HISTORY_LIMIT) {
        historyEntry.past.shift();
      }
      historyEntry.future = [];
      historyRef.current.set(pageId, historyEntry);
    }

    pendingPageStateRef.current.set(pageId, {
      annotations: nextAnnotations,
      annotationText: nextAnnotationText
    });

    if (options?.bumpRevision) {
      // Undo/redo or explicit external change — update the bundle and
      // revision immediately so EditorCanvas picks up the new annotations.
      bumpAnnotationRevision(pageId);
      setBundle((currentBundle) => {
        if (!currentBundle) {
          return currentBundle;
        }

        const nextPages = currentBundle.pages.map((p) =>
          p.id === pageId ? { ...p, annotations: nextAnnotations, annotationText: nextAnnotationText } : p
        );
        const nextBundle = { ...currentBundle, pages: nextPages };
        bundleRef.current = nextBundle;
        return nextBundle;
      });
    } else {
      // Normal drawing — DO NOT call setBundle synchronously.  With a large
      // document (1000+ pages) the resulting React re-render blocks the main
      // thread long enough to drop Apple Pencil pointer events, causing
      // strokes to be lost.  Instead, schedule a deferred bundle flush so
      // thumbnails / search catch up later without blocking drawing.
      scheduleBundleFlush();
    }

    dirtyPagesRef.current.add(pageId);
    pendingDraftPagesRef.current.add(pageId);
    lastEditAtRef.current = performance.now();
    scheduleDraftPersistence();
    scheduleSave();
  }

  function setPageNode(pageId: string, node: HTMLDivElement | null): void {
    if (node) {
      pageElementRefs.current.set(pageId, node);
      return;
    }

    pageElementRefs.current.delete(pageId);
  }

  function setThumbnailNode(pageId: string, node: HTMLButtonElement | null): void {
    if (node) {
      thumbnailElementRefs.current.set(pageId, node);
      return;
    }

    thumbnailElementRefs.current.delete(pageId);
  }

  function focusPage(pageId: string, behavior: ScrollBehavior = "smooth"): void {
    flushPendingPageStateToBundle();
    setActivePageId(pageId);
    if (isCompactLayout) {
      setCompactPagesOpen(false);
    }
    pageElementRefs.current.get(pageId)?.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior
    });
  }

  function goToRelativePage(direction: number): void {
    if (!bundle || !activePageId) {
      return;
    }

    const currentIndex = bundle.pages.findIndex((page) => page.id === activePageId);
    if (currentIndex < 0) {
      return;
    }

    const nextPage = bundle.pages[currentIndex + direction];
    if (nextPage) {
      focusPage(nextPage.id);
    }
  }

  function undoPageChange(): void {
    if (!bundle || !activePageId) {
      return;
    }

    const currentPage = getEffectivePage(activePageId);
    if (!currentPage) {
      return;
    }

    const historyEntry = historyRef.current.get(activePageId);
    const previous = historyEntry?.past.pop();
    if (!previous) {
      return;
    }

    historyEntry?.future.push(cloneAnnotations(currentPage.annotations));
    if (historyEntry) {
      historyRef.current.set(activePageId, historyEntry);
    }

    setPageAnnotations(activePageId, previous, { recordHistory: false, bumpRevision: true });
  }

  function redoPageChange(): void {
    if (!bundle || !activePageId) {
      return;
    }

    const currentPage = getEffectivePage(activePageId);
    if (!currentPage) {
      return;
    }

    const historyEntry = historyRef.current.get(activePageId);
    const next = historyEntry?.future.pop();
    if (!next) {
      return;
    }

    historyEntry?.past.push(cloneAnnotations(currentPage.annotations));
    if (historyEntry) {
      historyRef.current.set(activePageId, historyEntry);
    }

    setPageAnnotations(activePageId, next, { recordHistory: false, bumpRevision: true });
  }

  function applyBundleUpdate(nextBundle: DocumentBundle): void {
    bundleRef.current = nextBundle;
    syncedPageStateRef.current = new Map(
      nextBundle.pages.map((page) => [
        page.id,
        { annotations: page.annotations, annotationText: page.annotationText }
      ])
    );
    setBundle(nextBundle);
  }

  async function insertBlankPage(placement: "before" | "after") {
    if (!bundle || !activePageId) {
      return;
    }

    const previousIds = new Set(bundle.pages.map((page) => page.id));
    try {
      const nextBundle = await api.insertBlankPage(bundle.document.id, {
        anchorPageId: activePageId,
        placement,
        template: insertTemplate
      });
      const insertedPage = nextBundle.pages.find((page) => !previousIds.has(page.id));
      applyBundleUpdate(nextBundle);
      setActivePageId(insertedPage?.id ?? activePageId);
      setCompactActionsOpen(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not insert page.");
    }
  }

  function openPdfInsert(placement: "before" | "after"): void {
    setPdfInsertPlacement(placement);
    setPdfInsertPageRange("");
    setPdfInsertFile(null);
    setPdfInsertOpen(true);
  }

  async function submitPdfInsert(): Promise<void> {
    if (!bundle || !activePageId || !pdfInsertFile) {
      return;
    }

    setPdfInsertBusy(true);
    const previousIds = new Set(bundle.pages.map((page) => page.id));
    try {
      const nextBundle = await api.insertPdfPages(bundle.document.id, {
        file: pdfInsertFile,
        anchorPageId: activePageId,
        placement: pdfInsertPlacement,
        pageRange: pdfInsertPageRange
      });
      const firstInserted = nextBundle.pages.find((page) => !previousIds.has(page.id));
      applyBundleUpdate(nextBundle);
      setActivePageId(firstInserted?.id ?? activePageId);
      setPdfInsertOpen(false);
      setCompactActionsOpen(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not insert PDF pages.");
    } finally {
      setPdfInsertBusy(false);
    }
  }

  async function deleteCurrentPage() {
    if (!bundle || !activePageId) {
      return;
    }

    const currentIndex = bundle.pages.findIndex((page) => page.id === activePageId);

    try {
      const nextBundle = await api.deletePage(activePageId);
      const nextPage = nextBundle.pages[currentIndex] ?? nextBundle.pages[currentIndex - 1] ?? nextBundle.pages[0];
      applyBundleUpdate(nextBundle);
      setActivePageId(nextPage?.id ?? "");
      setCompactActionsOpen(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not delete page.");
    }
  }

  useEffect(() => {
    if (!activePageId || (isCompactLayout && !compactPagesOpen)) {
      return;
    }

    const selectedThumbnail = thumbnailElementRefs.current.get(activePageId);
    selectedThumbnail?.scrollIntoView({
      block: "nearest",
      inline: "nearest"
    });
  }, [activePageId, compactPagesOpen, isCompactLayout]);

  useEffect(() => {
    if (!bundle || !isCompactLayout || !compactPagesOpen || !compactThumbnailRailRef.current) {
      return;
    }

    let frameId = 0;
    const visibleThumbnailRatios = new Map<string, number>();
    const flushVisibleThumbnails = () => {
      frameId = 0;
      const sortedIds = [...visibleThumbnailRatios.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([pageId]) => pageId);

      setVisibleCompactThumbnailIds((current) => {
        if (current.length === sortedIds.length && current.every((pageId, index) => pageId === sortedIds[index])) {
          return current;
        }
        return sortedIds;
      });
    };

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const pageId = (entry.target as HTMLElement).dataset.pageId;
          if (!pageId) {
            return;
          }

          if (entry.isIntersecting) {
            visibleThumbnailRatios.set(pageId, entry.intersectionRatio);
            return;
          }

          visibleThumbnailRatios.delete(pageId);
        });

        if (frameId === 0) {
          frameId = window.requestAnimationFrame(flushVisibleThumbnails);
        }
      },
      {
        root: compactThumbnailRailRef.current,
        rootMargin: "0px 240px 0px 240px",
        threshold: [0.01, 0.35, 0.7]
      }
    );

    thumbnailElementRefs.current.forEach((node) => observer.observe(node));

    return () => {
      if (frameId !== 0) {
        window.cancelAnimationFrame(frameId);
      }
      observer.disconnect();
    };
  }, [compactPagesOpen, isCompactLayout, pageStructureKey]);

  useEffect(() => {
    if (!bundle || !pagePanelRef.current) {
      return;
    }

    let frameId = 0;
    const flushVisiblePages = () => {
      frameId = 0;

      // Skip ALL state updates while the user is actively scrolling.
      // This prevents the expensive hydration/prefetch cascade from
      // firing mid-scroll which causes the 2-second freeze.
      if (touchScrollActiveRef.current) {
        const sortedVisibleIds = [...visibleRatiosRef.current.entries()]
          .sort((left, right) => right[1] - left[1])
          .map(([pageId]) => pageId);
        const mostVisiblePageId = sortedVisibleIds[0];
        if (mostVisiblePageId) {
          pendingActivePageIdRef.current = mostVisiblePageId;
        }
        return;
      }

      const sortedVisibleIds = [...visibleRatiosRef.current.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([pageId]) => pageId);

      setVisiblePageIds((current) => {
        if (current.length === sortedVisibleIds.length && current.every((pageId, index) => pageId === sortedVisibleIds[index])) {
          return current;
        }
        return sortedVisibleIds;
      });

      const mostVisiblePageId = sortedVisibleIds[0];
      if (mostVisiblePageId && mostVisiblePageId !== activePageIdRef.current) {
        activePageIdRef.current = mostVisiblePageId;
        startTransition(() => {
          setActivePageId(mostVisiblePageId);
        });
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        const nextRatios = new Map(visibleRatiosRef.current);

        entries.forEach((entry) => {
          const pageId = (entry.target as HTMLElement).dataset.pageId;
          if (!pageId) {
            return;
          }

          if (entry.isIntersecting && entry.intersectionRatio > 0.08) {
            nextRatios.set(pageId, entry.intersectionRatio);
            return;
          }

          nextRatios.delete(pageId);
        });

        visibleRatiosRef.current = nextRatios;
        if (frameId === 0) {
          frameId = window.requestAnimationFrame(flushVisiblePages);
        }
      },
      {
        root: pagePanelRef.current,
        threshold: [0.12, 0.55]
      }
    );

    pageElementRefs.current.forEach((node) => observer.observe(node));

    return () => {
      if (frameId !== 0) {
        window.cancelAnimationFrame(frameId);
      }
      observer.disconnect();
    };
  }, [documentId, pageStructureKey]);

  useEffect(() => {
    if (!bundle || bundle.pages.length === 0) {
      return;
    }

    const visiblePageIdSet = new Set(visiblePageIds);
    const visiblePositions = bundle.pages
      .filter((page) => visiblePageIdSet.has(page.id))
      .map((page) => page.position);
    const anchorPage = bundle.pages.find((page) => page.id === activePageId) ?? bundle.pages[0];
    if (!anchorPage) {
      return;
    }

    const minPosition = visiblePositions.length ? Math.min(...visiblePositions) : anchorPage.position;
    const maxPosition = visiblePositions.length ? Math.max(...visiblePositions) : anchorPage.position;
    const baseRadius = visiblePositions.length ? HYDRATED_RENDER_RADIUS : INITIAL_HYDRATE_RADIUS;

    // Bias hydration toward scroll direction for smoother fast scrolling
    const velocity = scrollVelocityRef.current;
    const scrollDir = velocity > 0.15 ? 1 : velocity < -0.15 ? -1 : 0;
    const forwardBias = scrollDir !== 0 ? 3 : 0;
    const backwardPenalty = scrollDir !== 0 ? 2 : 0;

    rememberHydratedPages(
      bundle.pages
        .filter((page) => {
          if (scrollDir > 0) {
            return page.position >= minPosition - (baseRadius - backwardPenalty) && page.position <= maxPosition + (baseRadius + forwardBias);
          }
          if (scrollDir < 0) {
            return page.position >= minPosition - (baseRadius + forwardBias) && page.position <= maxPosition + (baseRadius - backwardPenalty);
          }
          return page.position >= minPosition - baseRadius && page.position <= maxPosition + baseRadius;
        })
        .map((page) => page.id)
    );
  }, [activePageId, bundle, pageStructureKey, visiblePageIds]);

  useEffect(() => {
    if (!bundle) {
      return;
    }

    // Debounce prefetch to avoid firing a burst of renders on every scroll tick
    const prefetchTimer = window.setTimeout(() => {
      const currentPage = bundle.pages.find((page) => page.id === activePageId) ?? bundle.pages[0];
      if (!currentPage) {
        return;
      }

      const hydratedPageIdSet = new Set(hydratedPageIds);
      const warmPages = bundle.pages.filter(
        (page) =>
          page.kind === "pdf" &&
          page.sourceFileId &&
          (hydratedPageIdSet.has(page.id) || Math.abs(page.position - currentPage.position) <= PREFETCH_RADIUS)
      );

      const localFileMap = new Map(bundle!.files.map((f) => [f.id, f]));

      function warmPage(page: PageRecord): void {
        const sourceFile = page.sourceFileId ? localFileMap.get(page.sourceFileId) : undefined;
        if (!sourceFile) {
          return;
        }

        const pagePreviewUrl = getPagePreviewUrl(sourceFile.id, page.sourcePageIndex, getPageRenderMetrics(page).stageWidth);
        const thumbnailPreviewUrl = getThumbnailPreviewUrl(sourceFile.id, page.sourcePageIndex);

        void preloadPreviewImage(pagePreviewUrl);
        void preloadPreviewImage(thumbnailPreviewUrl);
        loadPdfPage(sourceFile.url, (page.sourcePageIndex ?? 0) + 1, sourceFile.size).catch(() => {
          // Best-effort warm cache only.
        });
        void prewarmPdfPagePreview(
          sourceFile.url,
          (page.sourcePageIndex ?? 0) + 1,
          page.width,
          page.height,
          sourceFile.size
        );
      }

      // Urgent: pages within 2 positions — warm immediately
      const urgent: PageRecord[] = [];
      const deferred: PageRecord[] = [];
      for (const page of warmPages) {
        if (Math.abs(page.position - currentPage.position) <= 2) {
          urgent.push(page);
        } else {
          deferred.push(page);
        }
      }

      urgent.forEach(warmPage);

      // Deferred: warm during idle time to avoid blocking scroll
      deferred.forEach((page, i) => {
        if (typeof requestIdleCallback === "function") {
          requestIdleCallback(() => warmPage(page));
        } else {
          window.setTimeout(() => warmPage(page), 50 * (i + 1));
        }
      });
    }, 200);

    return () => {
      window.clearTimeout(prefetchTimer);
    };
  }, [activePageId, fileStructureKey, hydratedPageIds, pageStructureKey]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      const isTypingTarget =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;

      if (isTypingTarget) {
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          redoPageChange();
        } else {
          undoPageChange();
        }
        return;
      }

      if (event.ctrlKey && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redoPageChange();
        return;
      }

      if (["ArrowRight", "ArrowDown", "PageDown"].includes(event.key)) {
        event.preventDefault();
        goToRelativePage(1);
        return;
      }

      if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) {
        event.preventDefault();
        goToRelativePage(-1);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [activePageId, bundle]);

  // Swipe-left to reveal header, swipe-right to hide on compact layout
  useEffect(() => {
    if (!isCompactLayout) {
      return;
    }

    function handleTouchStart(event: TouchEvent): void {
      const touch = event.touches[0];
      if (touch) {
        swipeTouchRef.current = { startX: touch.clientX, startY: touch.clientY };
      }
    }

    function handleTouchEnd(event: TouchEvent): void {
      const startTouch = swipeTouchRef.current;
      const endTouch = event.changedTouches[0];
      if (!startTouch || !endTouch) {
        return;
      }

      const deltaX = endTouch.clientX - startTouch.startX;
      const deltaY = endTouch.clientY - startTouch.startY;
      swipeTouchRef.current = null;

      // Only trigger if horizontal swipe is dominant and exceeds threshold
      if (Math.abs(deltaX) < 60 || Math.abs(deltaY) > Math.abs(deltaX) * 0.7) {
        return;
      }

      if (deltaX < 0) {
        // Swipe left: show header
        setCompactHeaderVisible(true);
      } else {
        // Swipe right: hide header
        setCompactHeaderVisible(false);
        setCompactPagesOpen(false);
        setCompactActionsOpen(false);
      }
    }

    window.addEventListener("touchstart", handleTouchStart, { passive: true });
    window.addEventListener("touchend", handleTouchEnd, { passive: true });

    return () => {
      window.removeEventListener("touchstart", handleTouchStart);
      window.removeEventListener("touchend", handleTouchEnd);
    };
  }, [isCompactLayout]);

  // Hooks must be called before any early returns (React rules of hooks)
  const bundleFiles = bundle?.files;
  const fileMap = useMemo(() => {
    const map = new Map<string, FileRecord>();
    if (bundleFiles) {
      for (const file of bundleFiles) {
        map.set(file.id, file);
      }
    }
    return map;
  }, [bundleFiles]);

  const bundlePages = bundle?.pages ?? [];
  const activePage = bundlePages.find((page) => page.id === activePageId) ?? bundlePages[0] ?? null;

  const renderedPageIdSet = useMemo(() => {
    if (!bundlePages.length) return new Set<string>();
    const visibleSet = new Set(visiblePageIds);
    const hydratedSet = new Set(hydratedPageIds);

    let minPos = activePage?.position ?? bundlePages[0]?.position ?? 1;
    let maxPos = minPos;
    for (const page of bundlePages) {
      if (visibleSet.has(page.id)) {
        if (page.position < minPos) minPos = page.position;
        if (page.position > maxPos) maxPos = page.position;
      }
    }

    const result = new Set<string>();
    for (const page of bundlePages) {
      if (
        hydratedSet.has(page.id) ||
        visibleSet.has(page.id) ||
        (page.position >= minPos - RENDER_AHEAD_RADIUS && page.position <= maxPos + RENDER_AHEAD_RADIUS)
      ) {
        result.add(page.id);
      }
    }
    return result;
  }, [activePage, bundlePages, hydratedPageIds, visiblePageIds]);

  const previewWindow = useMemo(() => {
    if (!activePage || !bundlePages.length) return new Set<string>();
    const set = new Set<string>();
    for (const page of bundlePages) {
      if (Math.abs(page.position - activePage.position) <= THUMBNAIL_PREVIEW_RADIUS) {
        set.add(page.id);
      }
    }
    return set;
  }, [activePage, bundlePages]);

  if (loading) {
    return <main className="loading-screen">Opening document...</main>;
  }

  if (!bundle) {
    return (
      <main className="loading-screen">
        <p>{error || "Document not found."}</p>
        <Link className="secondary-button" to="/">
          Back to library
        </Link>
      </main>
    );
  }

  const activeFile = activePage?.sourceFileId ? fileMap.get(activePage.sourceFileId) : undefined;
  const bookmarkPage = bundle.document.bookmarkPageId
    ? bundle.pages.find((page) => page.id === bundle.document.bookmarkPageId) ?? null
    : null;
  const isCurrentPageBookmarked = Boolean(activePage && bookmarkPage?.id === activePage.id);
  const historyEntry = activePageId ? historyRef.current.get(activePageId) : undefined;
  const canUndo = Boolean(historyEntry?.past.length);
  const canRedo = Boolean(historyEntry?.future.length);

  const compactSaveLabel = saveState === "All changes saved" ? "Saved" : saveState;
  const compactInkColors = inkColors.filter(
    (candidate) => candidate === inkColors[0] || candidate === inkColors[1] || candidate === inkColors[5] || candidate === inkColor
  );
  const visibleCompactThumbnailIdSet = new Set(visibleCompactThumbnailIds);
  const shouldBuildThumbnails = !isCompactLayout || compactPagesOpen;
  const pageShellPaddingPx = isCompactLayout ? 0 : 32;

  function getThumbnailPreviewUrl(fileId: string, sourcePageIndex: number | null): string {
    return `/api/files/${fileId}/pages/${(sourcePageIndex ?? 0) + 1}/preview?width=${resolvePreviewWidthBucket(240)}`;
  }

  function getPagePreviewUrl(fileId: string, sourcePageIndex: number | null, stageWidth: number): string {
    const bucketedWidth = resolvePreviewWidthBucket(stageWidth);
    return `/api/files/${fileId}/pages/${(sourcePageIndex ?? 0) + 1}/preview?width=${bucketedWidth}`;
  }

  function getPageRenderMetrics(page: PageRecord): { stageWidth: number; stageHeight: number; renderZoom: number; viewportWidth: number } {
    const viewportWidth = pagePanelViewportWidth > 0 ? Math.max(0, pagePanelViewportWidth - pageShellPaddingPx) : page.width;
    const fitScale = viewportWidth > 0 ? viewportWidth / page.width : 1;
    const renderZoom = Math.max(0.2, fitScale * zoom);
    return {
      stageWidth: page.width * renderZoom,
      stageHeight: page.height * renderZoom,
      renderZoom,
      viewportWidth
    };
  }

  const thumbnailRailContent = shouldBuildThumbnails
    ? bundle.pages.map((page) => {
        const thumbnailFile = page.sourceFileId ? fileMap.get(page.sourceFileId) : undefined;
        const thumbnailFileUrl = thumbnailFile?.url;
        const shouldRenderPreview = previewWindow.has(page.id) || visibleCompactThumbnailIdSet.has(page.id);

        return (
          <button
            className={`thumbnail-card ${activePage?.id === page.id ? "active" : ""}`}
            data-page-id={page.id}
            key={page.id}
            onClick={() => focusPage(page.id)}
            ref={(node) => setThumbnailNode(page.id, node)}
            type="button"
          >
            <div className={`thumbnail-preview preview-${page.kind} preview-${page.template ?? "blank"}`}>
              {page.kind === "pdf" && thumbnailFileUrl ? (
                shouldRenderPreview ? (
                  <PdfThumbnail
                    fileSize={thumbnailFile?.size}
                    height={page.height}
                    pageIndex={page.sourcePageIndex ?? 0}
                    previewUrl={thumbnailFile ? getThumbnailPreviewUrl(thumbnailFile.id, page.sourcePageIndex) : undefined}
                    url={thumbnailFileUrl}
                    width={page.width}
                  />
                ) : (
                  <span>Page {page.position}</span>
                )
              ) : (
                <span>{page.kind === "pdf" ? "PDF" : page.template ?? "blank"}</span>
              )}
            </div>
            <span>Page {page.position}</span>
          </button>
        );
      })
    : null;

  const pageActionsPanel = (
    <>
      <p className="eyebrow">Page actions</p>
      <div className="stack-form">
        <select className="app-input" value={insertTemplate} onChange={(event) => setInsertTemplate(event.target.value as PageTemplate)}>
          <option value="blank">Blank paper</option>
          <option value="ruled">Ruled paper</option>
          <option value="grid">Grid paper</option>
          <option value="dot">Dot grid</option>
        </select>
        <button className="secondary-button" onClick={() => insertBlankPage("before")} type="button">
          Insert blank page before
        </button>
        <button className="secondary-button" onClick={() => insertBlankPage("after")} type="button">
          Insert blank page after
        </button>
      </div>

      <p className="eyebrow" style={{ marginTop: 16 }}>Insert from PDF</p>
      <div className="stack-form">
        <button className="secondary-button" onClick={() => openPdfInsert("before")} type="button">
          Insert PDF pages before
        </button>
        <button className="secondary-button" onClick={() => openPdfInsert("after")} type="button">
          Insert PDF pages after
        </button>
      </div>

      {pdfInsertOpen && (
        <div className="pdf-insert-dialog">
          <p className="eyebrow">
            Insert {pdfInsertPlacement === "before" ? "before" : "after"} current page
          </p>
          <div className="stack-form">
            <input
              ref={pdfFileInputRef}
              accept="application/pdf"
              className="app-input"
              type="file"
              onChange={(event) => setPdfInsertFile(event.target.files?.[0] ?? null)}
            />
            <label className="stack-form" style={{ gap: 4 }}>
              <span className="muted-copy">
                Page range <span style={{ opacity: 0.6 }}>(e.g. 1-3 or 2,5,8-10 — blank for all)</span>
              </span>
              <input
                className="app-input"
                placeholder="All pages"
                type="text"
                value={pdfInsertPageRange}
                onChange={(event) => setPdfInsertPageRange(event.target.value)}
              />
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="primary-button"
                disabled={!pdfInsertFile || pdfInsertBusy}
                style={{ flex: 1 }}
                type="button"
                onClick={submitPdfInsert}
              >
                {pdfInsertBusy ? "Inserting..." : "Insert"}
              </button>
              <button
                className="ghost-button"
                disabled={pdfInsertBusy}
                type="button"
                onClick={() => setPdfInsertOpen(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <p className="eyebrow" style={{ marginTop: 16 }}>Bookmark</p>
      <div className="stack-form">
        <p className="muted-copy">
          {bookmarkPage ? `Current bookmark: Page ${bookmarkPage.position}` : "No bookmark set yet."}
        </p>
        <button
          className={`secondary-button ${isCurrentPageBookmarked ? "active" : ""}`}
          disabled={!activePage || isCurrentPageBookmarked}
          onClick={() => void updateDocumentBookmark(activePage?.id ?? null)}
          type="button"
        >
          {isCurrentPageBookmarked ? "Current page is bookmarked" : "Bookmark this page"}
        </button>
        {bookmarkPage && !isCurrentPageBookmarked ? (
          <button className="secondary-button" onClick={() => focusPage(bookmarkPage.id)} type="button">
            Jump to bookmark
          </button>
        ) : null}
        {bookmarkPage ? (
          <button className="ghost-button" onClick={() => void updateDocumentBookmark(null)} type="button">
            Clear bookmark
          </button>
        ) : null}
      </div>

      <div className="stack-form" style={{ marginTop: 16 }}>
        <button className="ghost-button danger-button" onClick={deleteCurrentPage} type="button">
          Delete current page
        </button>
      </div>
    </>
  );

  const palmPanel = (
    <>
      <p className="eyebrow">Palm rejection</p>
      <label className="toggle-row">
        <input
          checked={palmSettings.stylusOnly}
          type="checkbox"
          onChange={(event) =>
            setPalmSettings({
              ...palmSettings,
              stylusOnly: event.target.checked
            })
          }
        />
        <span>Stylus-only writing</span>
      </label>
      <label className="stack-form">
        <span>Touch contact sensitivity</span>
        <input
          max={320}
          min={40}
          type="range"
          value={palmSettings.maxTouchArea}
          onChange={(event) =>
            setPalmSettings({
              ...palmSettings,
              maxTouchArea: Number(event.target.value)
            })
          }
        />
      </label>
      <p className="muted-copy">
        On iPad browsers this works best with Apple Pencil because the editor can ignore touch input and accept pen input only.
      </p>
      <p className="muted-copy">Switch to Hand mode to scroll through the document. Arrow keys and Page Up/Page Down also navigate.</p>
    </>
  );

  const searchPanel = (
    <>
      <p className="eyebrow">Search this document</p>
      <div className="compact-search-field">
        {isCompactLayout ? <IconGlyph name="search" /> : null}
        <input
          className="app-input"
          placeholder="Search PDF text and typed annotations"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
        />
      </div>
      <div className="search-result-list">
        {searchResults.map((page) => (
          <button
            className="search-result"
            key={page.pageId}
            onClick={() => {
              focusPage(page.pageId);
              setCompactActionsOpen(false);
            }}
            type="button"
          >
            <strong>Page {page.position}</strong>
            <span>{page.excerpt}</span>
          </button>
        ))}
        {searchBusy ? <p className="muted-copy">Searching document...</p> : null}
        {!searchBusy && !searchResults.length && searchQuery.trim() ? <p className="muted-copy">No matching text yet.</p> : null}
      </div>
    </>
  );

  const documentPanel = (
    <>
      <p className="eyebrow">Document</p>
      <p className="muted-copy">
        {bundle.document.kind === "pdf" ? "Imported PDF with editable annotation layers." : "Blank notebook with reusable paper templates."}
      </p>
      <p className="muted-copy">{bundle.document.pageCount} pages</p>
      {activeFile ? <p className="muted-copy">{Math.max(1, Math.round(activeFile.size / (1024 * 1024)))} MB source PDF</p> : null}
      <p className="muted-copy">Eraser removes whole strokes or text boxes right now. Undo and Redo are available in the toolbar.</p>
      {error ? <p className="error-text">{error}</p> : null}
    </>
  );

  return (
    <main className={`editor-layout ${isCompactLayout ? "compact-layout" : ""}`}>
      <header className={`editor-header ${isCompactLayout ? "compact-editor-header" : ""} ${isCompactLayout && !compactHeaderVisible ? "compact-header-hidden" : ""}`}>
        <div className="header-group header-leading">
          <Link
            aria-label={isCompactLayout ? "Back to library" : undefined}
            className={isCompactLayout ? "ghost-button icon-only-button" : "ghost-button"}
            to="/"
          >
            {isCompactLayout ? <IconGlyph name="back" /> : "Library"}
          </Link>
          <input
            className={`title-input ${isCompactLayout ? "compact-title-input" : ""}`}
            value={titleDraft}
            onBlur={commitTitle}
            onChange={(event) => setTitleDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                commitTitle();
              }
            }}
          />
        </div>

        <div className="header-group header-desktop-actions">
          <button className="ghost-button" disabled={!canUndo} onClick={undoPageChange} type="button">
            Undo
          </button>
          <button className="ghost-button" disabled={!canRedo} onClick={redoPageChange} type="button">
            Redo
          </button>
          <button className="ghost-button" onClick={() => setZoom((current) => clampZoom(current - 0.1))} type="button">
            -
          </button>
          <span className="save-pill">{Math.round(zoom * 100)}%</span>
          <button className="ghost-button" onClick={() => setZoom((current) => clampZoom(current + 0.1))} type="button">
            +
          </button>
          <a className="primary-button" href={`/api/documents/${bundle.document.id}/export`} rel="noreferrer" target="_blank">
            Export PDF
          </a>
          <button className="secondary-button" onClick={() => navigate("/")} type="button">
            Close
          </button>
        </div>

        <div className="compact-header-actions">
          <button
            aria-label="Toggle page thumbnails"
            className={`ghost-button icon-only-button ${compactPagesOpen ? "active" : ""}`}
            onClick={() => {
              setCompactPagesOpen((current) => !current);
              setCompactActionsOpen(false);
            }}
            type="button"
          >
            <IconGlyph name="pages" />
          </button>
          <button
            aria-label="Open document actions"
            className={`primary-button icon-only-button compact-plus-button ${compactActionsOpen ? "active" : ""}`}
            onClick={() => {
              setCompactActionsOpen((current) => !current);
              setCompactPagesOpen(false);
            }}
            type="button"
          >
            <IconGlyph name="plus" />
          </button>
        </div>
      </header>

      {isCompactLayout ? (
        <section className={`compact-tool-dock ${!compactHeaderVisible ? "compact-dock-top" : ""}`}>
          <div className="compact-tool-scroll">
            <button aria-label="Undo" className="compact-tool-button" disabled={!canUndo} onClick={undoPageChange} type="button">
              <IconGlyph name="undo" />
            </button>
            <button aria-label="Redo" className="compact-tool-button" disabled={!canRedo} onClick={redoPageChange} type="button">
              <IconGlyph name="redo" />
            </button>
            {toolDefinitions.map((candidate) => (
              <button
                aria-label={candidate.label}
                className={`compact-tool-button ${tool === candidate.value ? "active" : ""}`}
                key={candidate.value}
                onClick={() => setTool(candidate.value)}
                type="button"
              >
                <IconGlyph name={candidate.icon} />
              </button>
            ))}
            <div className="compact-color-strip">
              {compactInkColors.map((candidate) => (
                <button
                  aria-label={`Choose ${candidate}`}
                  className={`color-button compact-color-button ${inkColor === candidate ? "active" : ""}`}
                  key={candidate}
                  onClick={() => setInkColor(candidate)}
                  style={{ backgroundColor: candidate }}
                  type="button"
                />
              ))}
            </div>
            {tool === "eraser" ? (
              <div className="eraser-size-popup">
                {eraserSizes.map((size) => (
                  <button
                    key={size}
                    className={`eraser-size-button ${eraserSize === size ? "active" : ""}`}
                    onClick={() => setEraserSize(size)}
                    type="button"
                  >
                    <svg viewBox="0 0 40 40" width="28" height="28">
                      <circle cx="20" cy="20" r={size / 2} fill="rgba(100,100,100,0.2)" stroke="rgba(100,100,100,0.6)" strokeWidth="1.5" strokeDasharray="3 2" />
                    </svg>
                  </button>
                ))}
              </div>
            ) : tool === "shape" ? (
              <>
                <div className="shape-kind-popup">
                  {shapeDefinitions.map((shape) => (
                    <button
                      key={shape.value}
                      className={`shape-kind-button ${shapeKind === shape.value ? "active" : ""}`}
                      onClick={() => setShapeKind(shape.value)}
                      aria-label={shape.label}
                      title={shape.label}
                      type="button"
                    >
                      <ShapeKindGlyph shape={shape.value} />
                    </button>
                  ))}
                </div>
                <button
                  className={`compact-tool-button compact-fill-button ${shapeFilled ? "active" : ""}`}
                  onClick={() => setShapeFilled((current) => !current)}
                  aria-label={shapeFilled ? "Filled shapes" : "Outline only"}
                  title={shapeFilled ? "Filled shapes" : "Outline only"}
                  type="button"
                >
                  <ShapeFillGlyph filled={shapeFilled} />
                </button>
                <div className="stroke-size-popup">
                  {penSizes.map((size) => (
                    <button
                      key={size}
                      className={`stroke-size-button ${strokeWidth === size ? "active" : ""}`}
                      onClick={() => setStrokeWidth(size)}
                      type="button"
                    >
                      <svg viewBox="0 0 28 28" width="24" height="24">
                        <rect x="6" y="6" width="16" height="16" rx="4" fill="none" stroke="currentColor" strokeWidth={size} />
                      </svg>
                    </button>
                  ))}
                </div>
                <div className="line-style-popup">
                  {lineStyles.map((ls) => (
                    <button
                      key={ls.value}
                      className={`line-style-button ${lineStyle === ls.value ? "active" : ""}`}
                      onClick={() => setLineStyle(ls.value)}
                      type="button"
                      aria-label={ls.label}
                    >
                      <svg viewBox="0 0 32 8" width="32" height="8">
                        <line
                          x1="2" y1="4" x2="30" y2="4"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeDasharray={ls.value === "dashed" ? "6 4" : ls.value === "dotted" ? "0.5 5" : undefined}
                        />
                      </svg>
                    </button>
                  ))}
                </div>
              </>
            ) : (tool === "pen" || tool === "highlighter") ? (
              <>
                <div className="stroke-size-popup">
                  {(tool === "pen" ? penSizes : highlighterSizes).map((size) => (
                    <button
                      key={size}
                      className={`stroke-size-button ${strokeWidth === size ? "active" : ""}`}
                      onClick={() => setStrokeWidth(size)}
                      type="button"
                    >
                      <svg viewBox="0 0 28 28" width="24" height="24">
                        <line x1="4" y1="24" x2="24" y2="4" stroke="currentColor" strokeWidth={size} strokeLinecap="round" />
                      </svg>
                    </button>
                  ))}
                </div>
                <div className="line-style-popup">
                  {lineStyles.map((ls) => (
                    <button
                      key={ls.value}
                      className={`line-style-button ${lineStyle === ls.value ? "active" : ""}`}
                      onClick={() => setLineStyle(ls.value)}
                      type="button"
                      aria-label={ls.label}
                    >
                      <svg viewBox="0 0 32 8" width="32" height="8">
                        <line
                          x1="2" y1="4" x2="30" y2="4"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeDasharray={ls.value === "dashed" ? "6 4" : ls.value === "dotted" ? "0.5 5" : undefined}
                        />
                      </svg>
                    </button>
                  ))}
                </div>
              </>
            ) : null}
            <div className="compact-zoom-group">
              <button aria-label="Zoom out" className="compact-tool-button compact-zoom-button" onClick={() => setZoom((current) => clampZoom(current - 0.1))} type="button">
                -
              </button>
              <span className="save-pill compact-zoom-pill">{Math.round(zoom * 100)}%</span>
              <button aria-label="Zoom in" className="compact-tool-button compact-zoom-button" onClick={() => setZoom((current) => clampZoom(current + 0.1))} type="button">
                +
              </button>
            </div>
            <span className="save-pill compact-save-pill">{compactSaveLabel}</span>
          </div>
        </section>
      ) : (
        <section className="editor-toolbar">
          <div className="tool-row">
            {toolDefinitions.map((candidate) => (
              <button
                className={`tool-button ${tool === candidate.value ? "active" : ""}`}
                key={candidate.value}
                onClick={() => setTool(candidate.value)}
                type="button"
              >
                {candidate.label}
              </button>
            ))}
          </div>

          <div className="tool-row">
            {inkColors.map((candidate) => (
              <button
                aria-label={`Choose ${candidate}`}
                className={`color-button ${inkColor === candidate ? "active" : ""}`}
                key={candidate}
                onClick={() => setInkColor(candidate)}
                style={{ backgroundColor: candidate }}
                type="button"
              />
            ))}
          </div>

          {tool === "eraser" ? (
            <div className="tool-row eraser-size-row">
              <label>Eraser</label>
              <div className="eraser-size-popup">
                {eraserSizes.map((size) => (
                  <button
                    key={size}
                    className={`eraser-size-button ${eraserSize === size ? "active" : ""}`}
                    onClick={() => setEraserSize(size)}
                    type="button"
                  >
                    <svg viewBox="0 0 40 40" width="32" height="32">
                      <circle cx="20" cy="20" r={size / 2} fill="rgba(100,100,100,0.2)" stroke="rgba(100,100,100,0.6)" strokeWidth="1.5" strokeDasharray="3 2" />
                    </svg>
                  </button>
                ))}
              </div>
            </div>
          ) : tool === "shape" ? (
            <>
              <div className="tool-row shape-options-row">
                <label>Shape</label>
                <div className="shape-kind-popup">
                  {shapeDefinitions.map((shape) => (
                    <button
                      key={shape.value}
                      className={`shape-kind-button ${shapeKind === shape.value ? "active" : ""}`}
                      onClick={() => setShapeKind(shape.value)}
                      aria-label={shape.label}
                      title={shape.label}
                      type="button"
                    >
                      <ShapeKindGlyph shape={shape.value} />
                    </button>
                  ))}
                </div>
              </div>
              <div className="tool-row shape-options-row">
                <label>Fill</label>
                <button
                  className={`ghost-button shape-fill-toggle ${shapeFilled ? "active" : ""}`}
                  onClick={() => setShapeFilled((current) => !current)}
                  aria-label={shapeFilled ? "Shaded shapes" : "Outline only"}
                  title={shapeFilled ? "Shaded shapes" : "Outline only"}
                  type="button"
                >
                  <ShapeFillGlyph filled={shapeFilled} />
                  <span>{shapeFilled ? "Shaded" : "Outline only"}</span>
                </button>
              </div>
              <div className="tool-row stroke-options-row">
                <label>Border</label>
                <div className="stroke-size-popup">
                  {penSizes.map((size) => (
                    <button
                      key={size}
                      className={`stroke-size-button ${strokeWidth === size ? "active" : ""}`}
                      onClick={() => setStrokeWidth(size)}
                      type="button"
                    >
                      <svg viewBox="0 0 28 28" width="28" height="28">
                        <rect x="5" y="5" width="18" height="18" rx="4" fill="none" stroke="currentColor" strokeWidth={size} />
                      </svg>
                    </button>
                  ))}
                </div>
              </div>
              <div className="tool-row line-style-row">
                <label>Style</label>
                <div className="line-style-popup">
                  {lineStyles.map((ls) => (
                    <button
                      key={ls.value}
                      className={`line-style-button ${lineStyle === ls.value ? "active" : ""}`}
                      onClick={() => setLineStyle(ls.value)}
                      type="button"
                    >
                      <svg viewBox="0 0 40 8" width="40" height="8">
                        <line
                          x1="2" y1="4" x2="38" y2="4"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeDasharray={ls.value === "dashed" ? "6 4" : ls.value === "dotted" ? "0.5 5" : undefined}
                        />
                      </svg>
                      <span>{ls.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : (tool === "pen" || tool === "highlighter") ? (
            <>
              <div className="tool-row stroke-options-row">
                <label>Size</label>
                <div className="stroke-size-popup">
                  {(tool === "pen" ? penSizes : highlighterSizes).map((size) => (
                    <button
                      key={size}
                      className={`stroke-size-button ${strokeWidth === size ? "active" : ""}`}
                      onClick={() => setStrokeWidth(size)}
                      type="button"
                    >
                      <svg viewBox="0 0 28 28" width="28" height="28">
                        <line x1="4" y1="24" x2="24" y2="4" stroke="currentColor" strokeWidth={size} strokeLinecap="round" />
                      </svg>
                    </button>
                  ))}
                </div>
              </div>
              <div className="tool-row line-style-row">
                <label>Style</label>
                <div className="line-style-popup">
                  {lineStyles.map((ls) => (
                    <button
                      key={ls.value}
                      className={`line-style-button ${lineStyle === ls.value ? "active" : ""}`}
                      onClick={() => setLineStyle(ls.value)}
                      type="button"
                    >
                      <svg viewBox="0 0 40 8" width="40" height="8">
                        <line
                          x1="2" y1="4" x2="38" y2="4"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeDasharray={ls.value === "dashed" ? "6 4" : ls.value === "dotted" ? "0.5 5" : undefined}
                        />
                      </svg>
                      <span>{ls.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : null}

          <div className="tool-row save-row">
            <span className="save-pill">{saveState}</span>
          </div>
        </section>
      )}

      <section className={`editor-body ${isCompactLayout ? "compact-editor-body" : ""}`}>
        {!isCompactLayout ? <aside className="thumbnail-rail">{thumbnailRailContent}</aside> : null}

        <section className={`page-panel ${isCompactLayout ? "compact-page-panel" : ""} ${isCompactLayout && !compactHeaderVisible ? "compact-page-panel-full" : ""}`} ref={pagePanelRef}>
          <div className="page-stack">
            {bundle.pages.map((page) => {
              const pageFile = page.sourceFileId ? fileMap.get(page.sourceFileId) : undefined;
              const pageFileUrl = pageFile?.url;
              const shouldRenderPage = renderedPageIdSet.has(page.id);
              const pageRenderMetrics = getPageRenderMetrics(page);
              const pagePreviewUrl = pageFile ? getPagePreviewUrl(pageFile.id, page.sourcePageIndex, pageRenderMetrics.stageWidth) : undefined;

              // Fixed-height wrapper prevents ANY layout shift when transitioning
              // between placeholder and EditorCanvas. The height is the stage height
              // plus shell padding (same as what EditorCanvas will measure).
              const shellPadding = isCompactLayout ? 5.6 : 32; // 0.35rem*2 or 1rem*2
              const itemHeight = pageRenderMetrics.stageHeight + shellPadding;

              return (
                <div
                  className={`page-stack-item ${activePage?.id === page.id ? "active" : ""}`}
                  data-page-id={page.id}
                  key={page.id}
                  ref={(node) => setPageNode(page.id, node)}
                  style={{ height: `${itemHeight}px` }}
                >
                  {shouldRenderPage ? (
                    <EditorCanvas
                      annotationRevision={annotationRevisionRef.current.get(page.id) ?? 0}
                      color={inkColor}
                      fileSize={pageFile?.size}
                      fileUrl={pageFileUrl}
                      previewUrl={pagePreviewUrl}
                      onChange={(nextAnnotations) => setPageAnnotations(page.id, nextAnnotations)}
                      page={page}
                      palmSettings={palmSettings}
                      strokeWidth={strokeWidth}
                    lineStyle={lineStyle}
                    eraserSize={eraserSize}
                    shapeKind={shapeKind}
                    shapeFilled={shapeFilled}
                    tool={tool}
                    viewportWidthHint={pageRenderMetrics.viewportWidth}
                    zoom={zoom}
                    />
                  ) : (
                    <div className="page-stage-shell">
                      <div
                        className="page-stage"
                        style={{
                          width: `${pageRenderMetrics.stageWidth}px`,
                          height: `${pageRenderMetrics.stageHeight}px`
                        }}
                      >
                        {pagePreviewUrl ? (
                          <img
                            alt=""
                            className="page-preview-image"
                            decoding="async"
                            loading="lazy"
                            src={pagePreviewUrl}
                          />
                        ) : (
                          <div className="page-fallback page-skeleton">
                            <span>Page {page.position}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <div className={`editor-page-indicator ${isCompactLayout && compactPagesOpen ? "tray-open" : ""}`}>
          {activePage?.position ?? 1} of {bundle.document.pageCount}
        </div>

        {isCompactLayout && !compactHeaderVisible ? (
          <button
            className="compact-swipe-hint"
            aria-label="Show toolbar"
            onClick={() => setCompactHeaderVisible(true)}
            type="button"
          >
            <svg width="20" height="14" viewBox="0 0 20 14" fill="none" aria-hidden="true">
              <path d="M12 1L6 7l6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : null}

        {!isCompactLayout ? (
          <aside className="inspector-panel">
            <section className="inspector-card">{pageActionsPanel}</section>
            <section className="inspector-card">{palmPanel}</section>
            <section className="inspector-card">{searchPanel}</section>
            <section className="inspector-card">{documentPanel}</section>
          </aside>
        ) : null}

        {isCompactLayout && (compactActionsOpen || compactPagesOpen) ? (
          <button
            aria-label="Dismiss open panels"
            className="compact-overlay-dismiss"
            onClick={() => {
              setCompactActionsOpen(false);
              setCompactPagesOpen(false);
            }}
            type="button"
          />
        ) : null}

        {isCompactLayout ? (
          <aside className={`compact-thumbnail-sheet ${compactPagesOpen ? "open" : ""}`}>
            <div className="compact-sheet-header">
              <strong>Pages</strong>
              <span>{bundle.document.pageCount} total</span>
            </div>
            <div className="compact-thumbnail-row" ref={compactThumbnailRailRef}>
              {thumbnailRailContent}
            </div>
          </aside>
        ) : null}

        {isCompactLayout ? (
          <aside className={`compact-actions-sheet ${compactActionsOpen ? "open" : ""}`}>
            <section className="compact-sheet-card">
              <div className="compact-sheet-header">
                <strong>Notebook actions</strong>
                <button
                  aria-label="Close actions"
                  className="ghost-button icon-only-button"
                  onClick={() => setCompactActionsOpen(false)}
                  type="button"
                >
                  <IconGlyph name="close" />
                </button>
              </div>

              <section className="compact-sheet-section">
                <p className="eyebrow">View</p>
                <div className="compact-view-grid">
                  <button className="ghost-button" onClick={() => setZoom((current) => clampZoom(current - 0.1))} type="button">
                    Zoom out
                  </button>
                  <span className="save-pill">{Math.round(zoom * 100)}%</span>
                  <button className="ghost-button" onClick={() => setZoom((current) => clampZoom(current + 0.1))} type="button">
                    Zoom in
                  </button>
                </div>
                <a className="primary-button compact-export-button" href={`/api/documents/${bundle.document.id}/export`} rel="noreferrer" target="_blank">
                  <IconGlyph name="export" />
                  <span>Export PDF</span>
                </a>
              </section>

              <section className="compact-sheet-section">{pageActionsPanel}</section>
              <section className="compact-sheet-section">{searchPanel}</section>
              <section className="compact-sheet-section">{palmPanel}</section>
              <section className="compact-sheet-section">{documentPanel}</section>
            </section>
          </aside>
        ) : null}
      </section>
    </main>
  );
}
