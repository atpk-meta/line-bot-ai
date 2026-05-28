type LogLevel = "info" | "warn" | "error";

type LogValue = string | number | boolean | undefined;

interface LogContext {
  [key: string]: LogValue;
}

function logToConsole(level: LogLevel, event: string, ctx?: LogContext) {
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...ctx,
  };

  console.log(JSON.stringify(line));
}

export const log = {
  info: (event: string, ctx?: LogContext) => logToConsole("info", event, ctx),
  warn: (event: string, ctx?: LogContext) => logToConsole("warn", event, ctx),
  error: (event: string, ctx?: LogContext) => logToConsole("error", event, ctx),
};
