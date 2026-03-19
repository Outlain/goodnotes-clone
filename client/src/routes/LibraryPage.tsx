import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties, FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import type { LibraryPayload, PageTemplate, SessionStatus } from "../types";

const folderColors = ["#D56F5A", "#4E7AA1", "#A880C4", "#5D8B75", "#D5A752"];
const coverColors = ["#507DBC", "#9A6D9E", "#A9746E", "#77966D", "#D68C45"];

function randomColor(values: string[]): string {
  return values[Math.floor(Math.random() * values.length)];
}

export function LibraryPage() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [session, setSession] = useState<SessionStatus | null>(null);
  const [library, setLibrary] = useState<LibraryPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [query, setQuery] = useState("");
  const [activeFolderId, setActiveFolderId] = useState<string>("all");
  const [noteTitle, setNoteTitle] = useState("Lecture notebook");
  const [noteTemplate, setNoteTemplate] = useState<PageTemplate>("ruled");
  const [notePages, setNotePages] = useState(4);
  const [noteFolderId, setNoteFolderId] = useState<string>("root");
  const [newFolderTitle, setNewFolderTitle] = useState("");
  const [newFolderColor, setNewFolderColor] = useState(folderColors[0]);
  const [importFolderId, setImportFolderId] = useState<string>("root");
  const [confirmDelete, setConfirmDelete] = useState<{ type: "document" | "folder"; id: string; title: string } | null>(null);

  async function handleDeleteDocument(documentId: string): Promise<void> {
    try {
      await api.deleteDocument(documentId);
      setConfirmDelete(null);
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not delete document.");
    }
  }

  async function handleDeleteFolder(folderId: string): Promise<void> {
    try {
      await api.deleteFolder(folderId);
      setConfirmDelete(null);
      if (activeFolderId === folderId) {
        setActiveFolderId("all");
      }
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not delete folder.");
    }
  }

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      const nextSession = await api.sessionStatus();
      setSession(nextSession);
      if (!nextSession.required || nextSession.authenticated) {
        setLibrary(await api.getLibrary());
      }
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not load your workspace.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await api.login(password);
      setPassword("");
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not sign in.");
    }
  }

  async function handleCreateFolder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newFolderTitle.trim()) {
      return;
    }

    try {
      await api.createFolder(newFolderTitle.trim(), newFolderColor);
      setNewFolderTitle("");
      setNewFolderColor(randomColor(folderColors));
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not create folder.");
    }
  }

  async function handleCreateNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const document = await api.createNote({
        title: noteTitle.trim() || "Untitled notebook",
        folderId: noteFolderId === "root" ? null : noteFolderId,
        template: noteTemplate,
        pageCount: notePages,
        coverColor: randomColor(coverColors)
      });
      navigate(`/documents/${document.document.id}`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not create notebook.");
    }
  }

  async function handlePdfSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      const document = await api.importPdf(file, {
        title: file.name.replace(/\.pdf$/i, ""),
        folderId: importFolderId === "root" ? null : importFolderId,
        coverColor: randomColor(coverColors)
      });
      navigate(`/documents/${document.document.id}`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not import PDF.");
    } finally {
      event.target.value = "";
    }
  }

  const documents =
    library?.documents.filter((document) => {
      const matchesQuery = !query.trim() || document.title.toLowerCase().includes(query.trim().toLowerCase());
      const matchesFolder = activeFolderId === "all" || document.folderId === activeFolderId || (activeFolderId === "root" && document.folderId === null);
      return matchesQuery && matchesFolder;
    }) ?? [];

  const folderNameById = new Map((library?.folders ?? []).map((folder) => [folder.id, folder.title]));

  if (loading) {
    return <main className="loading-screen">Preparing your notebook workspace...</main>;
  }

  if (session?.required && !session.authenticated) {
    return (
      <main className="auth-screen">
        <section className="auth-card">
          <p className="eyebrow">Inkflow</p>
          <h1>Your personal note studio</h1>
          <p>Sign in with the shared deployment password to open the library.</p>
          <form className="stack-form" onSubmit={handleLogin}>
            <input
              className="app-input"
              placeholder="Deployment password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button className="primary-button" type="submit">
              Unlock notes
            </button>
          </form>
          {error ? <p className="error-text">{error}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="library-layout">
      <input accept="application/pdf" hidden onChange={handlePdfSelected} ref={fileInputRef} type="file" />

      <section className="library-sidebar">
        <div className="sidebar-panel hero-panel">
          <p className="eyebrow">Inkflow</p>
          <h1>Paper-first notes for classes, textbooks, and planning.</h1>
          <p>
            Build notebooks, import workbooks, and slide blank pages anywhere you need fresh space between PDF pages.
          </p>
        </div>

        <div className="sidebar-panel">
          <div className="section-heading">
            <h2>Folders</h2>
            <button className="ghost-button" onClick={() => setActiveFolderId("all")} type="button">
              All
            </button>
          </div>
          <div className="folder-list">
            <button
              className={`folder-chip ${activeFolderId === "root" ? "active" : ""}`}
              onClick={() => setActiveFolderId("root")}
              type="button"
            >
              Loose papers
            </button>
            {(library?.folders ?? []).map((folder) => (
              <div className="folder-chip-wrapper" key={folder.id}>
                <button
                  className={`folder-chip ${activeFolderId === folder.id ? "active" : ""}`}
                  onClick={() => setActiveFolderId(folder.id)}
                  style={{ borderColor: folder.color }}
                  type="button"
                >
                  {folder.title}
                </button>
                <button
                  aria-label={`Delete ${folder.title} folder`}
                  className="delete-folder-button"
                  onClick={() => setConfirmDelete({ type: "folder", id: folder.id, title: folder.title })}
                  title="Delete folder"
                  type="button"
                >
                  <svg viewBox="0 0 24 24" width="12" height="12">
                    <path d="M6 6 18 18M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
                  </svg>
                </button>
              </div>
            ))}
          </div>

          <form className="stack-form" onSubmit={handleCreateFolder}>
            <input
              className="app-input"
              placeholder="New folder"
              value={newFolderTitle}
              onChange={(event) => setNewFolderTitle(event.target.value)}
            />
            <div className="inline-fields">
              <select className="app-input" value={newFolderColor} onChange={(event) => setNewFolderColor(event.target.value)}>
                {folderColors.map((color) => (
                  <option key={color} value={color}>
                    {color}
                  </option>
                ))}
              </select>
              <button className="secondary-button" type="submit">
                Add folder
              </button>
            </div>
          </form>
        </div>

        <div className="sidebar-panel">
          <div className="section-heading">
            <h2>New notebook</h2>
          </div>
          <form className="stack-form" onSubmit={handleCreateNote}>
            <input className="app-input" value={noteTitle} onChange={(event) => setNoteTitle(event.target.value)} />
            <div className="inline-fields">
              <select className="app-input" value={noteTemplate} onChange={(event) => setNoteTemplate(event.target.value as PageTemplate)}>
                <option value="blank">Blank paper</option>
                <option value="ruled">Ruled paper</option>
                <option value="grid">Grid paper</option>
                <option value="dot">Dot grid</option>
              </select>
              <input
                className="app-input"
                max={24}
                min={1}
                type="number"
                value={notePages}
                onChange={(event) => setNotePages(Number(event.target.value))}
              />
            </div>
            <select className="app-input" value={noteFolderId} onChange={(event) => setNoteFolderId(event.target.value)}>
              <option value="root">Loose papers</option>
              {(library?.folders ?? []).map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.title}
                </option>
              ))}
            </select>
            <button className="primary-button" type="submit">
              Create notebook
            </button>
          </form>
        </div>

        <div className="sidebar-panel">
          <div className="section-heading">
            <h2>Import PDF</h2>
          </div>
          <select className="app-input" value={importFolderId} onChange={(event) => setImportFolderId(event.target.value)}>
            <option value="root">Loose papers</option>
            {(library?.folders ?? []).map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.title}
              </option>
            ))}
          </select>
          <button className="secondary-button" onClick={() => fileInputRef.current?.click()} type="button">
            Upload textbook or workbook PDF
          </button>
        </div>
      </section>

      <section className="library-content">
        <header className="library-toolbar">
          <div>
            <p className="eyebrow">Library</p>
            <h2>{documents.length} documents ready to open</h2>
          </div>
          <div className="toolbar-actions">
            <input
              className="app-input search-input"
              placeholder="Search titles"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button className="ghost-button" onClick={() => refresh()} type="button">
              Refresh
            </button>
          </div>
        </header>

        {error ? <p className="error-text">{error}</p> : null}

        <section className="document-grid">
          {documents.map((document) => (
            <div className="document-card-wrapper" key={document.id}>
              <button
                className="document-card"
                onClick={() => navigate(`/documents/${document.id}`)}
                style={{ "--card-color": document.coverColor } as CSSProperties}
                type="button"
              >
                <div className="document-cover">
                  <span className="document-kind">{document.kind === "pdf" ? "Imported PDF" : "Notebook"}</span>
                  <strong>{document.title}</strong>
                </div>
                <div className="document-meta">
                  <span>{document.pageCount} pages</span>
                  <span>{document.folderId ? folderNameById.get(document.folderId) : "Loose papers"}</span>
                </div>
              </button>
              <button
                aria-label={`Delete ${document.title}`}
                className="delete-item-button"
                onClick={() => setConfirmDelete({ type: "document", id: document.id, title: document.title })}
                title="Delete"
                type="button"
              >
                <svg viewBox="0 0 24 24" width="16" height="16">
                  <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6h12Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            </div>
          ))}
        </section>

        {!documents.length ? (
          <section className="empty-state">
            <h3>No documents match the current filter.</h3>
            <p>Try a different folder, clear the search field, or import a PDF to begin annotating.</p>
          </section>
        ) : null}
      </section>

      {confirmDelete ? (
        <div className="confirm-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="confirm-dialog" onClick={(event) => event.stopPropagation()}>
            <h3>Delete {confirmDelete.type === "folder" ? "folder" : "document"}?</h3>
            <p>
              {confirmDelete.type === "folder"
                ? `The folder "${confirmDelete.title}" will be deleted. Documents inside it will be moved to Loose papers.`
                : `"${confirmDelete.title}" will be permanently deleted. This cannot be undone.`}
            </p>
            <div className="confirm-actions">
              <button
                className="ghost-button"
                onClick={() => setConfirmDelete(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="primary-button danger-button"
                onClick={() =>
                  confirmDelete.type === "folder"
                    ? handleDeleteFolder(confirmDelete.id)
                    : handleDeleteDocument(confirmDelete.id)
                }
                type="button"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
