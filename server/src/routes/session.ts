import { Router } from "express";
import { z } from "zod";
import { clearSessionCookie, getSessionStatus, setSessionCookie } from "../lib/auth.js";
import { env } from "../lib/env.js";

const loginSchema = z.object({
  password: z.string().min(1)
});

export const sessionRouter = Router();

sessionRouter.get("/status", (request, response) => {
  response.json(getSessionStatus(request));
});

sessionRouter.post("/login", (request, response) => {
  const parsed = loginSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ message: "A password is required." });
    return;
  }

  const configuredPassword = env.appPassword;
  if (!configuredPassword) {
    response.status(400).json({ message: "Authentication is not enabled." });
    return;
  }

  if (parsed.data.password !== configuredPassword) {
    response.status(401).json({ message: "Incorrect password." });
    return;
  }

  setSessionCookie(response);
  response.json({ success: true });
});

sessionRouter.post("/logout", (_request, response) => {
  clearSessionCookie(response);
  response.json({ success: true });
});
