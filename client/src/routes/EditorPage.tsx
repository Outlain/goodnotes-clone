import { startTransition, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { EditorCanvas } from "../components/EditorCanvas";
import { PdfThumbnail } from "../components/PdfThumbnail";
import { api } from "../lib/api";
import { collectAnnotationText, excerptForSearch, getPageSearchText } from "../lib/annotations";
import { deleteDraft, getDraftsForDocument, saveDraft } from "../lib/drafts";
import { loadPdfPage } from "../lib/pdf";
import { saveAnnotationsInWorker } from "../lib/saveWorkerClient";
import type { Annotation, DocumentBundle, EditorTool, PageRecord, PageTemplate, PalmSettings } from "../types";

const inkColors = ["#14324E", "#BC412B", "#208B7A", "#8D5A97", "#C87E2A", "#111111"];
const HISTORY_LIMIT = 60;
const THUMBNAIL_PREVIEW_RADIUS = 3;
const RENDER_AHEAD_RADIUS = 2;
const PREFETCH_RADIUS = 6;
const COMPACT_LAYOUT_QUERY = "(max-width: 1100px)";
const LOCAL_DRAFT_DELAY_MS = 15000;
const REMOTE_SAVE_IDLE_MS = 15000;
const REMOTE_SAVE_RETRY_MS = 4000;

const toolDefinitions: Array<{ value: EditorTool; label: string; icon: IconName }> = [
  { value: "pen", label: "Pen", icon: "pen" },
  { value: "highlighter", label: "Highlighter", icon: "highlighter" },
  { value: "eraser", label: "Eraser", icon: "eraser" },
  { value: "text", label: "Text", icon: "text" },
  { value: "hand", label: "Hand", icon: "hand" }
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
  | "export";

function clampZoom(value: number): number {
  return Math.min(2.6, Math.max(0.45, Number(value.toFixed(2))));
}

function cloneAnnotations(annotations: Annotation[]): Annotation[] {
  return annotations;
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

export function EditorPage() {
  const { documentId = "" } = useParams();
  const navigate = useNavigate();
  const dirtyPagesRef = useRef(new Set<string>());
  const bundleRef = useRef<DocumentBundle | null>(null);
  const historyRef = useRef(new Map<string, { past: Annotation[][]; future: Annotation[][] }>());
  const pagePanelRef = useRef<HTMLElement | null>(null);
  const pageElementRefs = useRef(new Map<string, HTMLDivElement>());
  const thumbnailElementRefs = useRef(new Map<string, HTMLButtonElement>());
  const compactThumbnailRailRef = useRef<HTMLDivElement | null>(null);
  const visibleRatiosRef = useRef(new Map<string, number>());
  const activePageIdRef = useRef("");
  const saveTimerRef = useRef<number | null>(null);
  const draftPersistTimerRef = useRef<number | null>(null);
  const saveInFlightRef = useRef(false);
  const saveAgainRef = useRef(false);
  const pendingDraftPagesRef = useRef(new Set<string>());
  const pendingPageStateRef = useRef(new Map<string, { annotations: Annotation[]; annotationText: string }>());
  const syncedPageStateRef = useRef(new Map<string, { annotations: Annotation[]; annotationText: string }>());
  const lastEditAtRef = useRef(0);
  const [bundle, setBundle] = useState<DocumentBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activePageId, setActivePageId] = useState<string>("");
  const [tool, setTool] = useState<EditorTool>("pen");
  const [inkColor, setInkColor] = useState(inkColors[0]);
  const [strokeWidth, setStrokeWidth] = useState(4);
  const [zoom, setZoom] = useState(1);
  const [searchQuery, setSearchQuery] = useState("");
  const [insertTemplate, setInsertTemplate] = useState<PageTemplate>("ruled");
  const [saveState, setSaveState] = useState("All changes saved");
  const [titleDraft, setTitleDraft] = useState("");
  const [pagePanelViewportWidth, setPagePanelViewportWidth] = useState(0);
  const [visiblePageIds, setVisiblePageIds] = useState<string[]>([]);
  const [visibleCompactThumbnailIds, setVisibleCompactThumbnailIds] = useState<string[]>([]);
  const [isCompactLayout, setIsCompactLayout] = useState(
    () => typeof window !== "undefined" && window.matchMedia(COMPACT_LAYOUT_QUERY).matches
  );
  const [compactPagesOpen, setCompactPagesOpen] = useState(false);
  const [compactActionsOpen, setCompactActionsOpen] = useState(false);
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
        const canAppend =
          page.annotations.length >= syncedPageState.annotations.length &&
          syncedPageState.annotations.every((annotation, index) => page.annotations[index] === annotation);
        const nextAnnotations = canAppend ? page.annotations.slice(syncedPageState.annotations.length) : page.annotations;
        const saveMode = canAppend && nextAnnotations.length > 0 ? "append" : "replace";

        const startedAt = performance.now();
        await saveAnnotationsInWorker(page.id, nextAnnotations, page.annotationText, saveMode);
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

      await Promise.all(pageIds.map((pageId) => deleteDraft(currentBundle.document.id, pageId)));

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

  async function loadDocument(): Promise<void> {
    setLoading(true);
    try {
      const serverBundle = await api.getDocument(documentId);
      const localDrafts = await getDraftsForDocument(documentId);
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
      const nextBundle =
        localDrafts.size > 0
          ? {
              ...serverBundle,
              pages: serverBundle.pages.map((page) => {
                const draftRecord = localDrafts.get(page.id);
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
      setBundle(nextBundle);
      setTitleDraft(nextBundle.document.title);
      setActivePageId((current) =>
        nextBundle.pages.some((page) => page.id === current) ? current : nextBundle.pages[0]?.id || ""
      );
      dirtyPagesRef.current.clear();
      pendingDraftPagesRef.current.clear();
      if (localDrafts.size > 0) {
        localDrafts.forEach((draftRecord, pageId) => {
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
    loadDocument();
    return () => {
      clearSaveTimer();
      clearDraftPersistTimer();
      flushPendingPageStateToBundle();
      void flushDraftPersistence();
    };
  }, [documentId]);

  useEffect(() => {
    function flushDraftsBeforeBackgrounding(): void {
      void flushDraftPersistence();
    }

    function handleVisibilityChange(): void {
      if (document.visibilityState === "hidden") {
        flushDraftsBeforeBackgrounding();
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

  useEffect(() => {
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
    historyRef.current.clear();
    visibleRatiosRef.current.clear();
    setVisiblePageIds([]);
    setVisibleCompactThumbnailIds([]);
  }, [documentId]);

  useEffect(() => {
    activePageIdRef.current = activePageId;
  }, [activePageId]);

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

  function setPageAnnotations(pageId: string, nextAnnotations: Annotation[], options?: { recordHistory?: boolean }) {
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

    setPageAnnotations(activePageId, previous, { recordHistory: false });
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

    setPageAnnotations(activePageId, next, { recordHistory: false });
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
      setBundle(nextBundle);
      setActivePageId(insertedPage?.id ?? activePageId);
      setCompactActionsOpen(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not insert page.");
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
      setBundle(nextBundle);
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
        setActivePageId(mostVisiblePageId);
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
    if (!bundle) {
      return;
    }

    const currentPage = bundle.pages.find((page) => page.id === activePageId) ?? bundle.pages[0];
    if (!currentPage) {
      return;
    }

    const warmPages = bundle.pages.filter(
      (page) => page.kind === "pdf" && Math.abs(page.position - currentPage.position) <= PREFETCH_RADIUS && page.sourceFileId
    );

    warmPages.forEach((page) => {
      const sourceFile = bundle.files.find((file) => file.id === page.sourceFileId);
      if (!sourceFile) {
        return;
      }

      loadPdfPage(sourceFile.url, (page.sourcePageIndex ?? 0) + 1).catch(() => {
        // Best-effort warm cache only.
      });
    });
  }, [activePageId, fileStructureKey, pageStructureKey]);

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

  const activePage = bundle.pages.find((page) => page.id === activePageId) ?? bundle.pages[0];
  const activeFile = bundle.files.find((file) => file.id === activePage?.sourceFileId);
  const historyEntry = activePageId ? historyRef.current.get(activePageId) : undefined;
  const canUndo = Boolean(historyEntry?.past.length);
  const canRedo = Boolean(historyEntry?.future.length);
  const searchResults = searchQuery.trim()
    ? bundle.pages.filter((page) => getPageSearchText(page).toLowerCase().includes(searchQuery.trim().toLowerCase()))
    : [];
  const visiblePageIdSet = new Set(visiblePageIds);
  const previewWindow = new Set(
    activePage
      ? bundle.pages
          .filter((page) => Math.abs(page.position - activePage.position) <= THUMBNAIL_PREVIEW_RADIUS)
          .map((page) => page.id)
      : []
  );
  const renderedPageIdSet = new Set(
    activePage
      ? bundle.pages
          .filter((page) => visiblePageIdSet.has(page.id) || Math.abs(page.position - activePage.position) <= RENDER_AHEAD_RADIUS)
          .map((page) => page.id)
      : bundle.pages.slice(0, 3).map((page) => page.id)
  );
  const compactSaveLabel = saveState === "All changes saved" ? "Saved" : saveState;
  const compactInkColors = inkColors.filter(
    (candidate) => candidate === inkColors[0] || candidate === inkColors[1] || candidate === inkColors[5] || candidate === inkColor
  );
  const visibleCompactThumbnailIdSet = new Set(visibleCompactThumbnailIds);
  const shouldBuildThumbnails = !isCompactLayout || compactPagesOpen;

  const thumbnailRailContent = shouldBuildThumbnails
    ? bundle.pages.map((page) => {
        const thumbnailFileUrl = page.sourceFileId ? bundle.files.find((file) => file.id === page.sourceFileId)?.url : undefined;
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
                    height={page.height}
                    pageIndex={page.sourcePageIndex ?? 0}
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
            key={page.id}
            onClick={() => {
              focusPage(page.id);
              setCompactActionsOpen(false);
            }}
            type="button"
          >
            <strong>Page {page.position}</strong>
            <span>{excerptForSearch(page, searchQuery)}</span>
          </button>
        ))}
        {!searchResults.length && searchQuery.trim() ? <p className="muted-copy">No matching text yet.</p> : null}
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
      <header className={`editor-header ${isCompactLayout ? "compact-editor-header" : ""}`}>
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
        <section className="compact-tool-dock">
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
            <label className="compact-stroke-control">
              <span>{strokeWidth}px</span>
              <input
                max={14}
                min={1}
                type="range"
                value={strokeWidth}
                onChange={(event) => setStrokeWidth(Number(event.target.value))}
              />
            </label>
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

          <div className="tool-row slider-row">
            <label htmlFor="stroke-width">Stroke</label>
            <input
              id="stroke-width"
              max={14}
              min={1}
              type="range"
              value={strokeWidth}
              onChange={(event) => setStrokeWidth(Number(event.target.value))}
            />
            <span>{strokeWidth}px</span>
          </div>

          <div className="tool-row save-row">
            <span className="save-pill">{saveState}</span>
          </div>
        </section>
      )}

      <section className={`editor-body ${isCompactLayout ? "compact-editor-body" : ""}`}>
        {!isCompactLayout ? <aside className="thumbnail-rail">{thumbnailRailContent}</aside> : null}

        <section className={`page-panel ${isCompactLayout ? "compact-page-panel" : ""}`} ref={pagePanelRef}>
          <div className="page-stack">
            {bundle.pages.map((page) => {
              const pageFileUrl = page.sourceFileId ? bundle.files.find((file) => file.id === page.sourceFileId)?.url : undefined;
              const shouldRenderPage = renderedPageIdSet.has(page.id);

              return (
                <div
                  className={`page-stack-item ${activePage?.id === page.id ? "active" : ""}`}
                  data-page-id={page.id}
                  key={page.id}
                  ref={(node) => setPageNode(page.id, node)}
                >
                  {shouldRenderPage ? (
                    <EditorCanvas
                      color={inkColor}
                      fileUrl={pageFileUrl}
                      onChange={(nextAnnotations) => setPageAnnotations(page.id, nextAnnotations)}
                      page={page}
                      palmSettings={palmSettings}
                      strokeWidth={strokeWidth}
                      tool={tool}
                      viewportWidthHint={pagePanelViewportWidth}
                      zoom={zoom}
                    />
                  ) : (
                    <div className="page-stage-shell">
                      <div
                        className="page-placeholder"
                        style={{
                          width: `${(pagePanelViewportWidth > 0 ? pagePanelViewportWidth : page.width) * zoom}px`,
                          height: `${
                            ((pagePanelViewportWidth > 0 ? pagePanelViewportWidth : page.width) / page.width) * page.height * zoom
                          }px`
                        }}
                      >
                        <span>Page {page.position}</span>
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
