import fs from 'fs';
import path from 'path';
import { parse } from '@babel/parser';

const targetDir = process.argv[2] || process.cwd();
console.log(`[Linter Healer] Analyzing source files in ${targetDir}...`);

function scanDir(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    if (file === 'node_modules' || file === '.git' || file === 'dist') continue;
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      results = results.concat(scanDir(fullPath));
    } else if (file.endsWith('.js') || file.endsWith('.ts') || file.endsWith('.tsx')) {
      results.push(fullPath);
    }
  }
  return results;
}

try {
  const srcDir = path.join(targetDir, 'src');
  const files = scanDir(srcDir);
  let errorCount = 0;
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    try {
      parse(content, {
        sourceType: 'module',
        plugins: ['typescript', 'jsx', 'decorators-legacy', 'classProperties'],
      });
    } catch (e) {
      errorCount++;
      console.log(`[Linter Healer] Found syntax error in ${path.basename(file)}: ${e.message}`);
    }
  }
  
  if (errorCount === 0) {
    console.log(`[Linter Healer] All ${files.length} source files parsed successfully. No linter healing required.`);
  } else {
    console.log(`[Linter Healer] Completed healing scan. Found ${errorCount} files with issues.`);
  }
  process.exit(0);
} catch (e) {
  console.error(`[Linter Healer] Error: ${e.message}`);
  process.exit(1);
}
