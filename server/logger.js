const fs = require('fs');
const path = require('path');
const config = require('./config');

const logDir = path.resolve(__dirname, config.logDir);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const appLogStream = fs.createWriteStream(path.join(logDir, 'app.log'), { flags: 'a' });

function ts() {
  return new Date().toISOString();
}

function write(stream, level, scope, msg) {
  const line = `[${ts()}] [${level}] [${scope}] ${msg}\n`;
  stream.write(line);
  const consoleLine = line.trimEnd();
  if (level === 'ERROR') console.error(consoleLine);
  else console.log(consoleLine);
}

// Базовый логгер приложения
const logger = {
  info: (msg, scope = 'app') => write(appLogStream, 'INFO', scope, msg),
  warn: (msg, scope = 'app') => write(appLogStream, 'WARN', scope, msg),
  error: (msg, scope = 'app') => write(appLogStream, 'ERROR', scope, msg),
};

// Логгер конкретной задачи: пишет и в общий app.log, и в отдельный файл задачи.
// Собирает строки в память, чтобы фронт мог их запросить.
function createTaskLogger(taskId) {
  const taskStream = fs.createWriteStream(path.join(logDir, `task-${taskId}.log`), { flags: 'a' });
  const lines = [];
  const scope = `task:${taskId}`;

  function log(level, msg) {
    const line = `[${ts()}] [${level}] ${msg}`;
    lines.push(line);
    taskStream.write(line + '\n');
    write(appLogStream, level, scope, msg);
  }

  return {
    info: (msg) => log('INFO', msg),
    warn: (msg) => log('WARN', msg),
    error: (msg) => log('ERROR', msg),
    getLines: () => lines.slice(),
    close: () => taskStream.end(),
  };
}

module.exports = { logger, createTaskLogger, logDir };
