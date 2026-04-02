const fs = require('fs');
const path = require('path');

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  return filePath;
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function appendJsonl(filePath, entry) {
  ensureParentDir(filePath);
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
  return filePath;
}

function listFilesRecursive(dirPath, extension = null) {
  if (!fs.existsSync(dirPath)) return [];

  const files = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath, extension));
      continue;
    }
    if (!extension || fullPath.endsWith(extension)) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

module.exports = {
  appendJsonl,
  ensureParentDir,
  listFilesRecursive,
  readJson,
  readJsonl,
  writeJson,
};
