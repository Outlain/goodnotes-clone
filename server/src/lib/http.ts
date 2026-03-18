import type { NextFunction, Request, Response } from "express";

type AsyncRoute = (request: Request, response: Response, next: NextFunction) => Promise<void>;

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function asyncRoute(handler: AsyncRoute) {
  return (request: Request, response: Response, next: NextFunction): void => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}
