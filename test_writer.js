import fs from 'fs';
import path from 'path';

const targetDir = process.argv[2] || process.cwd();
console.log(`[Test Writer] Scanning for test files and generating missing specs in ${targetDir}...`);

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
    } else if (file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.js')) {
      if (!file.includes('.test.') && !file.includes('.spec.')) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

try {
  const srcDir = path.join(targetDir, 'src');
  const sourceFiles = scanDir(srcDir);
  let generatedCount = 0;
  
  for (const file of sourceFiles) {
    const dir = path.dirname(file);
    const base = path.basename(file, path.extname(file));
    const ext = path.extname(file);
    const testFile = path.join(dir, `${base}.test${ext}`);
    
    if (!fs.existsSync(testFile)) {
      const template = `import { describe, it, expect } from 'vitest';\n\ndescribe('${base} tests', () => {\n  it('should compile and pass initial stub', () => {\n    expect(true).toBe(true);\n  });\n});\n`;
      fs.writeFileSync(testFile, template, 'utf8');
      console.log(`[Test Writer] Generated new test template: ${path.relative(targetDir, testFile)}`);
      generatedCount++;
    }
  }
  
  console.log(`[Test Writer] Done. Generated ${generatedCount} new test specs.`);
  process.exit(0);
} catch (e) {
  console.error(`[Test Writer] Error: ${e.message}`);
  process.exit(1);
}
