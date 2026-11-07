export type RepositoryErrorCode =
  | "signed-out"
  | "forbidden"
  | "not-found"
  | "rate-limited"
  | "server"
  | "network"
  | "compatibility"
  | "cancelled";

export type RepositoryErrorOptions = {
  status?: number;
  retryAfter?: number;
};

export class RepositoryError extends Error {
  readonly code: RepositoryErrorCode;
  declare readonly status?: number;
  declare readonly retryAfter?: number;

  constructor(code: RepositoryErrorCode, options: RepositoryErrorOptions = {}) {
    super(code);
    Object.defineProperty(this, "name", { value: "RepositoryError", configurable: true });
    this.code = code;
    if (options.status !== undefined) {
      this.status = options.status;
    }
    if (options.retryAfter !== undefined) {
      this.retryAfter = options.retryAfter;
    }
  }
}

export function classifyHttpError(status: number): RepositoryError {
  let code: RepositoryErrorCode;
  switch (status) {
    case 401:
      code = "signed-out";
      break;
    case 403:
      code = "forbidden";
      break;
    case 404:
      code = "not-found";
      break;
    case 429:
      code = "rate-limited";
      break;
    default:
      code = status >= 500 && status <= 599 ? "server" : "compatibility";
  }
  return new RepositoryError(code, { status });
}
