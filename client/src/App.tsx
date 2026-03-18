import { BrowserRouter, Route, Routes } from "react-router-dom";
import { LibraryPage } from "./routes/LibraryPage";
import { EditorPage } from "./routes/EditorPage";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<LibraryPage />} path="/" />
        <Route element={<EditorPage />} path="/documents/:documentId" />
      </Routes>
    </BrowserRouter>
  );
}

