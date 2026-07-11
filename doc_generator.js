import fs from 'fs';
import path from 'path';

const targetDir = process.argv[2] || process.cwd();
console.log(`[Doc Generator] Generating codebase API documentation in ${targetDir}...`);

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
      results.push(fullPath);
    }
  }
  return results;
}

try {
  const srcDir = path.join(targetDir, 'src');
  const files = scanDir(srcDir);
  let docContent = `# Codebase API Documentation\n\nGenerated dynamically on ${new Date().toISOString()}\n\n## Source Files:\n`;
  
  for (const file of files) {
    const rel = path.relative(targetDir, file);
    docContent += `- **${rel}**\n`;
    
    const content = fs.readFileSync(file, 'utf8');
    const funcMatches = content.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g);
    const arrowMatches = content.matchAll(/(?:export\s+)?const\s+(\w+)\s*=\s*(?:\([^)]*\)|_?\w+)\s*=>/g);
    
    const funcs = new Set();
    for (const m of funcMatches) funcs.add(m[1]);
    for (const m of arrowMatches) funcs.add(m[1]);
    
    if (funcs.size > 0) {
      docContent += `  * Exported/Defined Functions: ${Array.from(funcs).map(f => `\`${f}\``).join(', ')}\n`;
    }
  }
  
  const docsDir = path.join(targetDir, 'DOCS');
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }
  
  const docFile = path.join(docsDir, 'API_OVERVIEW.md');
  fs.writeFileSync(docFile, docContent, 'utf8');
  console.log(`[Doc Generator] Successfully generated/updated documentation: ${path.relative(targetDir, docFile)}`);
  process.exit(0);
} catch (e) {
  console.error(`[Doc Generator] Error: ${e.message}`);
  process.exit(1);
}
