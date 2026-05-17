type Level = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

function log(level: Level, tag: string, msg: string, extra?: unknown) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] [${tag}] ${msg}`;
  if (extra !== undefined) {
    console.log(line, typeof extra === 'string' ? extra : JSON.stringify(extra, null, 2));
  } else {
    console.log(line);
  }
}

export const logger = {
  info:  (tag: string, msg: string, extra?: unknown) => log('INFO',  tag, msg, extra),
  warn:  (tag: string, msg: string, extra?: unknown) => log('WARN',  tag, msg, extra),
  error: (tag: string, msg: string, extra?: unknown) => log('ERROR', tag, msg, extra),
  debug: (tag: string, msg: string, extra?: unknown) => log('DEBUG', tag, msg, extra),
};
