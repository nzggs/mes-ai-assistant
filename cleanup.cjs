// Watch .tmp dir and remove esbuild temp files safely:
// only delete files that haven't been modified in 800ms,
// to avoid deleting a file while esbuild native is still reading it.
const fs = require('fs');
const path = require('path');

const WATCH_DIRS = [
  path.resolve('.tmp'),
  path.resolve('C:/Users/Administrator/AppData/Local/Temp'),
  path.resolve('E:/temp'),
];

function sweep(dir) {
  let files = [];
  try { files = fs.readdirSync(dir); } catch (_) { return; }
  const now = Date.now();
  for (const f of files) {
    if (!f.startsWith('esbuild-')) continue;
    const full = path.join(dir, f);
    try {
      const stat = fs.statSync(full);
      if (stat.isDirectory()) continue;
      if (now - stat.mtimeMs < 800) continue; // skip recently modified
      try { fs.unlinkSync(full); } catch (_) {}
    } catch (_) {}
  }
}

for (const dir of WATCH_DIRS) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  console.log(`[cleanup] watching: ${dir}`);
  setInterval(() => sweep(dir), 400);
}

setInterval(() => {}, 1 << 30);