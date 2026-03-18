import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { collectAnnotationText, excerptForSearch, getPageSearchText } from "../lib/annotations";
import { EditorCanvas } from "../components/EditorCanvas";
import type { Annotation, DocumentBundle, EditorTool, PageTemplate, PalmSettings } from "../types";

const inkColors = ["#14324E", "#BC412B", "#208B7A", "#8D5A97", "#C87E2A", "#111111"];

function clampZoom(value: number): number {
  return Math.min(2.6, Math.max(0.45, Number(value.toFixed(2))));
}

export function EditorPage() {
  const { documentId = "" } = useParams();
  const navigate = useNavigate();
  const dirtyPagesRef = useRef(new Set<string>());
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
  const [palmSettings, setPalmSettings] = useState<PalmSettings>({
    stylusOnly: true,
    maxTouchArea: 160
  });

  async function loadDocument(): Promise<void> {
    setLoading(true);
    try {
      const nextBundle = await api.getDocument(documentId);
      setBundle(nextBundle);
      setTitleDraft(nextBundle.document.title);
      setActivePageId((current) =>
        nextBundle.pages.some((page) => page.id === current) ? current : nextBundle.pages[0]?.id || ""
      );
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not open the document.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadDocument();
  }, [documentId]);

  useEffect(() => {
    if (!bundle || dirtyPagesRef.current.size === 0) {
      return;
    }

    const timer = window.setTimeout(async () => {
      const pageIds = [...dirtyPagesRef.current];
      dirtyPagesRef.current.clear();

      try {
        for (const pageId of pageIds) {
          const page = bundle.pages.find((entry) => entry.id === pageId);
          if (!page) {
            continue;
          }

          await api.saveAnnotations(page.id, page.annotations, collectAnnotationText(page.annotations));
        }
        setSaveState("All changes saved");
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Could not save annotations.");
        setSaveState("Save failed");
      }
    }, 700);

    return () => {
      window.clearTimeout(timer);
    };
  }, [bundle]);

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

  function updateAnnotations(nextAnnotations: Annotation[]) {
    if (!bundle || !activePageId) {
      return;
    }

    setBundle({
      ...bundle,
      pages: bundle.pages.map((page) =>
        page.id === activePageId
          ? {
              ...page,
              annotations: nextAnnotations,
              annotationText: collectAnnotationText(nextAnnotations)
            }
          : page
      )
    });
    dirtyPagesRef.current.add(activePageId);
    setSaveState("Saving...");
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
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not delete page.");
    }
  }

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
  const searchResults = searchQuery.trim()
    ? bundle.pages.filter((page) => getPageSearchText(page).toLowerCase().includes(searchQuery.trim().toLowerCase()))
    : [];

  return (
    <main className="editor-layout">
      <header className="editor-header">
        <div className="header-group">
          <Link className="ghost-button" to="/">
            Library
          </Link>
          <input
            className="title-input"
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

        <div className="header-group">
          <button className="ghost-button" onClick={() => setZoom((current) => clampZoom(current - 0.1))} type="button">
            -
          </button>
          <span className="save-pill">{Math.round(zoom * 100)}%</span>
          <button className="ghost-button" onClick={() => setZoom((current) => clampZoom(current + 0.1))} type="button">
            +
          </button>
          <a className="primary-button" href={`/api/documents/${bundle.document.id}/export`} target="_blank" rel="noreferrer">
            Export PDF
          </a>
          <button className="secondary-button" onClick={() => navigate("/")} type="button">
            Close
          </button>
        </div>
      </header>

      <section className="editor-toolbar">
        <div className="tool-row">
          {(["pen", "highlighter", "eraser", "text", "hand"] as EditorTool[]).map((candidate) => (
            <button
              className={`tool-button ${tool === candidate ? "active" : ""}`}
              key={candidate}
              onClick={() => setTool(candidate)}
              type="button"
            >
              {candidate}
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

      <section className="editor-body">
        <aside className="thumbnail-rail">
          {bundle.pages.map((page) => (
            <button
              className={`thumbnail-card ${activePage?.id === page.id ? "active" : ""}`}
              key={page.id}
              onClick={() => setActivePageId(page.id)}
              type="button"
            >
              <div className={`thumbnail-preview preview-${page.kind} preview-${page.template ?? "blank"}`}>
                <span>{page.kind === "pdf" ? "PDF" : page.template ?? "blank"}</span>
              </div>
              <span>Page {page.position}</span>
            </button>
          ))}
        </aside>

        <section className="page-panel">
          {activePage ? (
            <EditorCanvas
              color={inkColor}
              fileUrl={activeFile?.url}
              onChange={updateAnnotations}
              page={activePage}
              palmSettings={palmSettings}
              strokeWidth={strokeWidth}
              tool={tool}
              zoom={zoom}
            />
          ) : null}
        </section>

        <aside className="inspector-panel">
          <section className="inspector-card">
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
          </section>

          <section className="inspector-card">
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
          </section>

          <section className="inspector-card">
            <p className="eyebrow">Search this document</p>
            <input
              className="app-input"
              placeholder="Search PDF text and typed annotations"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
            <div className="search-result-list">
              {searchResults.map((page) => (
                <button
                  className="search-result"
                  key={page.id}
                  onClick={() => setActivePageId(page.id)}
                  type="button"
                >
                  <strong>Page {page.position}</strong>
                  <span>{excerptForSearch(page, searchQuery)}</span>
                </button>
              ))}
              {!searchResults.length && searchQuery.trim() ? <p className="muted-copy">No matching text yet.</p> : null}
            </div>
          </section>

          <section className="inspector-card">
            <p className="eyebrow">Document</p>
            <p className="muted-copy">
              {bundle.document.kind === "pdf" ? "Imported PDF with editable annotation layers." : "Blank notebook with reusable paper templates."}
            </p>
            <p className="muted-copy">{bundle.document.pageCount} pages</p>
            {error ? <p className="error-text">{error}</p> : null}
          </section>
        </aside>
      </section>
    </main>
  );
}
