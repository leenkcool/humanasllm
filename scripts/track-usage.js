const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const markerFile = path.join(projectRoot, '.usage-tracked');
const indexLog = path.join('G:', 'dev', 'claude-templates', 'index.log');
const templateNameFile = path.join(projectRoot, '.template-name');

if (fs.existsSync(markerFile)) {
  process.exit(0);
}

const projectName = path.basename(projectRoot);
let templateName = 'node-express';
try {
  if (fs.existsSync(templateNameFile)) {
    templateName = fs.readFileSync(templateNameFile, 'utf8').trim();
  }
} catch (e) {}

const timestamp = new Date().toISOString();
const logEntry = `[${timestamp}] ${projectName} <- ${templateName}\n`;

try {
  fs.appendFileSync(indexLog, logEntry);
  fs.writeFileSync(markerFile, timestamp);
} catch (e) {}

process.exit(0);
