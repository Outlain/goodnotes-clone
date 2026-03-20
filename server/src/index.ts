import compression from "compression";
import cookieParser from "cookie-parser";
import express from "express";
import helmet from "helmet";
import multer from "multer";
import { createServer } from "node:http";
import path from "node:path";
import { existsSync } from "node:fs";
import { env } from "./lib/env.js";
import { requireSession } from "./lib/auth.js";
import { HttpError } from "./lib/http.js";
import { setupWebSocketServer } from "./lib/sync.js";
import { libraryRouter } from "./routes/library.js";
import { sessionRouter } from "./routes/session.js";

const app = express();

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.use("/api/session", sessionRouter);
app.use("/api", requireSession, libraryRouter);

if (existsSync(env.publicDir)) {
  app.use(express.static(env.publicDir));
  app.use((request, response, next) => {
    if (request.path.startsWith("/api/")) {
      next();
      return;
    }

    response.sendFile(path.join(env.publicDir, "index.html"));
  });
} else {
  app.use((_request, response) => {
    response
      .status(503)
      .send("The web client has not been built yet. Run the client build or use Docker for production.");
  });
}

app.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error(error);

  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    response.status(413).json({
      message: `PDF exceeds the current upload limit of ${env.pdfUploadLimitMb} MB. Increase PDF_UPLOAD_LIMIT_MB or split the source PDF into sections.`
    });
    return;
  }

  const status = error instanceof HttpError ? error.status : 500;
  response.status(status).json({
    message: error.message || "Unexpected server error."
  });
});

const server = createServer(app);
setupWebSocketServer(server);

server.listen(env.port, () => {
  console.log(`Inkflow server listening on port ${env.port}`);
});
