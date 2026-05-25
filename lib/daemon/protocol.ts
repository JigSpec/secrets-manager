/**
 * IPC protocol shared by the daemon server and the CLI's ipc-client.
 *
 * Line-delimited JSON over a Unix stream socket. One request per line,
 * one response per line. Connection closes after the response.
 */

export type DaemonRequest = {
  cmd: string;
  args?: Record<string, unknown>;
};

export type DaemonOkResponse<T extends Record<string, unknown> = Record<string, unknown>> = {
  ok: true;
} & T;

export type DaemonErrorCode =
  | "DAEMON_LOCKED"
  | "UNKNOWN_COMMAND"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_INPUT"
  | "PERSIST_FAILED"
  | "DEPLOY_FAILED"
  | "COLLISION"
  | "IMPORT_CONFLICT"
  | "KEY_INVALID_AFTER_RELOAD"
  | "AMBIGUOUS";

export type DaemonErrorResponse = {
  ok: false;
  code: DaemonErrorCode;
  message: string;
};

export type DaemonResponse = DaemonOkResponse | DaemonErrorResponse;

export function ok<T extends Record<string, unknown>>(body: T): DaemonOkResponse<T> {
  return { ok: true, ...body };
}

export function err(
  code: DaemonErrorCode,
  message: string,
): DaemonErrorResponse {
  return { ok: false, code, message };
}
