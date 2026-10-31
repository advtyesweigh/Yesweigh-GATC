const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

export function createLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(severity, message, meta) {
    if ((LEVELS[severity] ?? 99) > threshold) return;
    const entry = {
      ts: new Date().toISOString(),
      level: severity,
      message,
      ...(meta && Object.keys(meta).length ? { meta } : {}),
    };
    const line = JSON.stringify(entry);
    if (severity === 'error') {
      console.error(line);
    } else if (severity === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  return {
    error: (message, meta) => write('error', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    info: (message, meta) => write('info', message, meta),
    debug: (message, meta) => write('debug', message, meta),
  };
}
