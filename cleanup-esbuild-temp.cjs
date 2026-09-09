// 后台清理 esbuild 临时文件（多目录）
// Node.js fs 可以删 Temp 文件，esbuild Go 进程的 DeleteFileW 却 Access denied
const fs = require('fs');
const path = require('path');

const WATCH_DIRS = [
  path.join(process.env.LOCALAPPDATA || '', 'Temp'),
  'E:/temp',
].filter(d => { try { return fs.statSync(d).isDirectory(); } catch(_) { return false; } });

console.log(`[cleanup] watching: ${WATCH_DIRS.join(', ')}`);

function scheduleClean(dir, basename) {
  if (!basename.startsWith('esbuild-')) return;
  const abspath = path.join(dir, basename);
  setTimeout(() => {
    try { fs.unlinkSync(abspath); console.log(`[cleanup] removed ${basename}`); }
    catch(e) { /* 已被删或仍在使用 */ }
  }, 500); // 500ms 后删，给 esbuild 足够时间读文件
}

for (const dir of WATCH_DIRS) {
  try {
    fs.watch(dir, (_event, fname) => fname && scheduleClean(dir, fname));
  } catch(e) {
    console.error(`[cleanup] watch ${dir} failed:`, e.message);
  }
}

// 保持进程运行
setInterval(() => {}, 60000);
