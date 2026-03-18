import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { env } from "./env.js";

const SESSION_LIFETIME_MS = 1000 * 60 * 60 * 24 * 30;

function sign(value: string): string {
  return createHmac("sha256", env.sessionSecret).update(value).digest("hex");
}

function buildCookieValue(): string {
  const issuedAt = Date.now().toString();
  return `${issuedAt}.${sign(issuedAt)}`;
}

function verifyCookie(cookieValue: string | undefined): boolean {
  if (!cookieValue) {
    return false;
  }

  const [issuedAt, signature] = cookieValue.split(".");
  if (!issuedAt || !signature) {
    return false;
  }

  const expected = sign(issuedAt);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (signatureBuffer.length !== expectedBuffer.length) {
    return false;
  }

  if (!timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return false;
  }

  const issuedAtMs = Number(issuedAt);
  if (!Number.isFinite(issuedAtMs)) {
    return false;
  }

  return Date.now() - issuedAtMs < SESSION_LIFETIME_MS;
}

export function getSessionStatus(request: Request): { required: boolean; authenticated: boolean } {
  if (!env.appPassword) {
    return { required: false, authenticated: true };
  }

  const cookieValue = request.cookies?.[env.cookieName];
  return {
    required: true,
    authenticated: verifyCookie(cookieValue)
  };
}

export function setSessionCookie(response: Response): void {
  response.cookie(env.cookieName, buildCookieValue(), {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProduction,
    maxAge: SESSION_LIFETIME_MS
  });
}

export function clearSessionCookie(response: Response): void {
  response.clearCookie(env.cookieName);
}

export function requireSession(request: Request, response: Response, next: NextFunction): void {
  const status = getSessionStatus(request);
  if (!status.required || status.authenticated) {
    next();
    return;
  }

  response.status(401).json({ message: "Authentication required." });
}

