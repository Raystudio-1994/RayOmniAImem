import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import { exec, fork } from 'child_process';
import { promisify } from 'util';

const traverse = _traverse.default || _traverse;
const execPromise = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -------------------------------------------------------------
// Storage Pools for Tiered Context Cache
// -------------------------------------------------------------

const documentIndex = {};
let vectorCache = {};
const CACHE_PATH = path.join(app.getPath('userData'), 'vector_cache.json');

// Memory Tiers
const sessionCache = {};
const dependencyGraph = {};
const vectorWeights = {};

const ORG_CACHE_PATH = path.join(app.getPath('userData'), 'organization_cache.json');
let organizationCache = {};

// -------------------------------------------------------------
// Mathematical Vector & Similarity Helpers
// -------------------------------------------------------------

function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function shannonEntropy(str) {
  const len = str.length;
  if (len === 0) return 0;
  const freq = {};
  for (let i = 0; i < len; i++) {
    const char = str[i];
    freq[char] = (freq[char] || 0) + 1;
  }
  let entropy = 0;
  for (const char in freq) {
    const p = freq[char] / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// -------------------------------------------------------------
// Embedding APIs (Gemini Cloud + Ollama Local)
// -------------------------------------------------------------

async function getGeminiEmbedding(text, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'models/text-embedding-004',
      content: { parts: [{ text }] }
    })
  });
  if (!response.ok) {
    throw new Error(`Gemini API returned status ${response.status}`);
  }
  const data = await response.json();
  return data.embedding.values;
}

async function getOllamaEmbedding(text) {
  const response = await fetch('http://localhost:11434/api/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'nomic-embed-text',
      prompt: text
    })
  });
  if (!response.ok) {
    throw new Error(`Ollama returned status ${response.status}`);
  }
  const data = await response.json();
  return data.embedding;
}

// -------------------------------------------------------------
// Cache loaders and savers
// -------------------------------------------------------------

async function loadVectorCache() {
  try {
    if (existsSync(CACHE_PATH)) {
      const data = await fs.readFile(CACHE_PATH, 'utf8');
      vectorCache = JSON.parse(data);
    }
  } catch (e) {
    console.error('[RAG Cache] Load failed:', e.message);
  }
}

async function saveVectorCache() {
  try {
    await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
    await fs.writeFile(CACHE_PATH, JSON.stringify(vectorCache, null, 2), 'utf8');
  } catch (e) {
    console.error('[RAG Cache] Save failed:', e.message);
  }
}

async function loadOrgCache() {
  try {
    if (existsSync(ORG_CACHE_PATH)) {
      const data = await fs.readFile(ORG_CACHE_PATH, 'utf8');
      organizationCache = JSON.parse(data);
    } else {
      organizationCache = {
        'global_standards.md': {
          content: `# Enterprise Quality Standards\n- Keep code complexity low.\n- All database queries must use prepared statements.\n- Use structured logs for system audits.\n`,
          embedding: null
        }
      };
      await fs.mkdir(path.dirname(ORG_CACHE_PATH), { recursive: true });
      await fs.writeFile(ORG_CACHE_PATH, JSON.stringify(organizationCache, null, 2), 'utf8');
    }
  } catch (e) {
    console.error('[Org Cache] Load failed:', e.message);
  }
}

// -------------------------------------------------------------
// Graph-RAG Import Topology Mapper
// -------------------------------------------------------------

function resolveDependencyPath(currentFilePath, importStr, rootPath) {
  if (path.isAbsolute(importStr)) return importStr;

  // 1. Handle TS module path alias (e.g., @/components/Navbar)
  let aliasResolved = importStr;
  if (importStr.startsWith('@/')) {
    aliasResolved = path.join(rootPath, 'src', importStr.slice(2));
  }

  // 2. Resolve relative imports
  let resolvedPath = aliasResolved;
  if (importStr.startsWith('.') || importStr.startsWith('..')) {
    resolvedPath = path.resolve(path.dirname(currentFilePath), importStr);
  } else if (!path.isAbsolute(resolvedPath)) {
    // Bare module imports or fallback
    resolvedPath = path.resolve(rootPath, resolvedPath);
  }

  // 3. Resolve extensions (.ts, .tsx, .js, .jsx, .json)
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.json'];
  try {
    if (existsSync(resolvedPath)) {
      const stat = fs.statSync(resolvedPath);
      if (stat.isDirectory()) {
        for (const ext of extensions) {
          const indexFile = path.join(resolvedPath, 'index' + ext);
          if (existsSync(indexFile)) {
            return indexFile;
          }
        }
      }
      return resolvedPath;
    }
  } catch {}

  for (const ext of extensions) {
    const fileWithExt = resolvedPath + ext;
    try {
      if (existsSync(fileWithExt)) {
        return fileWithExt;
      }
    } catch {}
  }

  return resolvedPath;
}

function buildDependencies(filePath, content, rootPath = app.getAppPath()) {
  const lines = content.split('\n');
  const imports = [];
  for (const line of lines) {
    const match = line.match(/(?:import|require|from)\s+['"]([^'"]+)['"]/);
    if (match) {
      let dep = match[1];
      const resolved = resolveDependencyPath(filePath, dep, rootPath);
      imports.push(resolved);
    }
  }
  dependencyGraph[filePath] = imports;
}

// -------------------------------------------------------------
// Directory Scanner & Compactor
// -------------------------------------------------------------

async function scanDir(dirPath, rootPath = dirPath) {
  let results = [];
  try {
    const list = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of list) {
      const res = path.resolve(dirPath, entry.name);
      const rel = path.relative(rootPath, res);
      
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === '.oxlint-cache') {
        continue;
      }
      
      if (entry.isDirectory()) {
        results = results.concat(await scanDir(res, rootPath));
      } else {
        results.push({
          name: entry.name,
          path: res,
          relPath: rel,
          size: (await fs.stat(res)).size,
        });
      }
    }
  } catch (e) {
    console.error('Error scanning folder:', e.message);
  }
  return results;
}

function compactRegex(filePath, code) {
  const lines = code.split('\n');
  let result = `### Structure of ${path.basename(filePath)} (Compacted)\n`;
  let count = 0;
  
  for (let line of lines) {
    const trimmed = line.trim();
    if (count++ > 80) {
      result += `  ... [File Truncated at 80 lines]\n`;
      break;
    }
    if (trimmed.startsWith('def ') && trimmed.endsWith(':')) {
      const indent = line.indexOf('def');
      const prefix = indent > 0 ? '    ' : '  ';
      result += `${prefix}- def ${trimmed.substring(4, trimmed.length - 1)} [REDUCED]\n`;
    } else if (trimmed.startsWith('class ') && trimmed.endsWith(':')) {
      result += `  - class ${trimmed.substring(6, trimmed.length - 1)}\n`;
    } else if (trimmed.startsWith('function ') || (trimmed.includes('function') && trimmed.includes('('))) {
      result += `  - function ${trimmed.replace('{', '').trim()} [REDUCED]\n`;
    } else if (trimmed.startsWith('class ') && trimmed.includes('{')) {
      result += `  - class ${trimmed.replace('{', '').trim()}\n`;
    } else if (trimmed.startsWith('pub fn ') || trimmed.startsWith('fn ')) {
      result += `  - fn ${trimmed.replace('{', '').trim()} [REDUCED]\n`;
    }
  }
  return result;
}

const JS_TS_KEYWORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof',
  'new', 'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while',
  'with', 'yield', 'let', 'static', 'async', 'await', 'of', 'null', 'undefined', 'true', 'false'
]);

function extractSeedIdentifiers(prompt) {
  const matches = prompt.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) || [];
  const seeds = new Set();
  matches.forEach(m => {
    if (!JS_TS_KEYWORDS.has(m) && m.length > 2) {
      seeds.add(m);
    }
  });
  return seeds;
}

function compactCode(filePath, code, promptText = '') {
  const ext = path.extname(filePath).toLowerCase();
  
  if (ext === '.js' || ext === '.jsx' || ext === '.ts' || ext === '.tsx') {
    try {
      const ast = parse(code, {
        sourceType: 'module',
        plugins: ['typescript', 'jsx', 'decorators-legacy', 'classProperties'],
      });
      
      const definedFunctionNodes = new Map();
      const callGraph = {};
      
      // 1. First pass: Map defined functions
      traverse(ast, {
        FunctionDeclaration(path) {
          const name = path.node.id ? path.node.id.name : null;
          if (name) {
            definedFunctionNodes.set(name, path.node);
            callGraph[name] = new Set();
          }
        },
        ClassMethod(path) {
          const name = path.node.key && path.node.key.type === 'Identifier' ? path.node.key.name : null;
          if (name) {
            definedFunctionNodes.set(name, path.node);
            callGraph[name] = new Set();
          }
        },
        VariableDeclarator(path) {
          if (path.node.init && (path.node.init.type === 'ArrowFunctionExpression' || path.node.init.type === 'FunctionExpression')) {
            const name = path.node.id && path.node.id.type === 'Identifier' ? path.node.id.name : null;
            if (name) {
              definedFunctionNodes.set(name, path.node.init);
              callGraph[name] = new Set();
            }
          }
        }
      });
      
      // 2. Second pass: Extract call dependencies
      let currentCaller = null;
      const callerStack = [];
      
      traverse(ast, {
        enter(path) {
          let matched = false;
          let name = null;
          if (path.isFunctionDeclaration()) {
            name = path.node.id ? path.node.id.name : null;
            matched = !!name;
          } else if (path.isClassMethod()) {
            name = path.node.key && path.node.key.type === 'Identifier' ? path.node.key.name : null;
            matched = !!name;
          } else if (path.isVariableDeclarator() && path.node.init && 
                     (path.node.init.type === 'ArrowFunctionExpression' || path.node.init.type === 'FunctionExpression')) {
            name = path.node.id && path.node.id.type === 'Identifier' ? path.node.id.name : null;
            matched = !!name;
          }
          
          if (matched) {
            if (currentCaller) {
              callerStack.push(currentCaller);
            }
            currentCaller = name;
          }
          
          if (currentCaller && path.isIdentifier()) {
            const idName = path.node.name;
            if (idName !== currentCaller && definedFunctionNodes.has(idName)) {
              callGraph[currentCaller].add(idName);
            }
          }
        },
        exit(path) {
          let matched = false;
          let name = null;
          if (path.isFunctionDeclaration()) {
            name = path.node.id ? path.node.id.name : null;
            matched = !!name;
          } else if (path.isClassMethod()) {
            name = path.node.key && path.node.key.type === 'Identifier' ? path.node.key.name : null;
            matched = !!name;
          } else if (path.isVariableDeclarator() && path.node.init && 
                     (path.node.init.type === 'ArrowFunctionExpression' || path.node.init.type === 'FunctionExpression')) {
            name = path.node.id && path.node.id.type === 'Identifier' ? path.node.id.name : null;
            matched = !!name;
          }
          
          if (matched && currentCaller === name) {
            currentCaller = callerStack.length > 0 ? callerStack.pop() : null;
          }
        }
      });

      // 3. Find reachable nodes starting from seeds
      const visited = new Set();
      
      if (promptText && promptText.trim().length > 0) {
        const seeds = extractSeedIdentifiers(promptText);
        const activeSeeds = new Set();
        
        definedFunctionNodes.forEach((node, name) => {
          const nameLower = name.toLowerCase();
          seeds.forEach(seed => {
            const seedLower = seed.toLowerCase();
            if (nameLower.includes(seedLower) || seedLower.includes(nameLower)) {
              activeSeeds.add(name);
            }
          });
        });
        
        const queue = Array.from(activeSeeds);
        queue.forEach(s => visited.add(s));
        
        while (queue.length > 0) {
          const current = queue.shift();
          const targets = callGraph[current];
          if (targets) {
            for (const target of targets) {
              if (!visited.has(target)) {
                visited.add(target);
                queue.push(target);
              }
            }
          }
        }
      }

      // 4. Non-destructive Compaction: Find ranges of function bodies that should be pruned
      const replacements = [];
      definedFunctionNodes.forEach((node, name) => {
        if (!visited.has(name)) {
          const bodyNode = node.body;
          if (bodyNode && typeof bodyNode.start === 'number' && typeof bodyNode.end === 'number') {
            let replacementText = '{\n  /* ... [Signature Only: Body Pruned for Token Optimization] ... */\n}';
            if (bodyNode.type !== 'BlockStatement') {
              replacementText = '/* ... [Signature Only: Body Pruned for Token Optimization] ... */ null';
            }
            replacements.push({
              start: bodyNode.start,
              end: bodyNode.end,
              value: replacementText
            });
          }
        }
      });

      // Filter out nested replacements to avoid overlapping/redundant mutations
      const finalReplacements = [];
      replacements.sort((a, b) => (a.start - b.start) || (b.end - a.end));
      
      let lastEnd = -1;
      for (const r of replacements) {
        if (r.start >= lastEnd) {
          finalReplacements.push(r);
          lastEnd = r.end;
        }
      }

      // Sort descending by start offset to modify the string from right to left
      finalReplacements.sort((a, b) => b.start - a.start);
      
      let compactedCode = code;
      for (const r of finalReplacements) {
        compactedCode = compactedCode.slice(0, r.start) + r.value + compactedCode.slice(r.end);
      }
      
      return compactedCode;
    } catch (err) {
      console.warn(`[AST Call-Graph Pruner] Babel failed for ${filePath}, using regex:`, err.message);
    }
  }
  return compactRegex(filePath, code);
}

// -------------------------------------------------------------
// Semantic Git-Diff History Chunker
// -------------------------------------------------------------

async function indexGitDiffsInternal(dirPath) {
  const gitPath = path.join(dirPath, '.git');
  if (!existsSync(gitPath)) return;
  
  try {
    const { stdout } = await execPromise('git log -n 5 --stat', { cwd: dirPath });
    if (stdout) {
      sessionCache['git_history_diffs.txt'] = {
        content: `### Git Commit History & Stat Summaries\n\n${stdout}`,
        mtime: Date.now()
      };
      
      try {
        const embedding = await getOllamaEmbedding(stdout.substring(0, 1500));
        if (embedding) {
          sessionCache['git_history_diffs.txt'].embedding = embedding;
        }
      } catch {}
    }
  } catch (err) {
    console.error('Git log command failed:', err.message);
  }
}

// -------------------------------------------------------------
// Security Scanner (Gitleaks + JS Fallback)
// -------------------------------------------------------------

async function runSecurityAudit(dirPath) {
  const secrets = [];
  const gitleaksPaths = [
    path.join(app.getAppPath(), 'assets', 'bin', process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks'),
    '/usr/local/bin/gitleaks',
    'gitleaks'
  ];
  
  let binaryPath = null;
  for (const p of gitleaksPaths) {
    try {
      if (p === 'gitleaks' || existsSync(p)) {
        binaryPath = p;
        break;
      }
    } catch {}
  }
  
  if (binaryPath) {
    try {
      const cmd = `"${binaryPath}" detect --source="${dirPath}" --no-git --report-format=json --report-path="report.json"`;
      await execPromise(cmd);
      
      if (existsSync('report.json')) {
        const rawReport = await fs.readFile('report.json', 'utf-8');
        await fs.unlink('report.json').catch(() => {});
        const report = JSON.parse(rawReport);
        return report.map(r => ({
          file: r.File,
          line: r.StartLine,
          rule: r.RuleID,
          secret: r.Secret,
          desc: `Exposed ${r.RuleID} credentials detected by Gitleaks.`
        }));
      }
    } catch (err) {
      if (existsSync('report.json')) {
        try {
          const rawReport = await fs.readFile('report.json', 'utf-8');
          await fs.unlink('report.json').catch(() => {});
          const report = JSON.parse(rawReport);
          return report.map(r => ({
            file: r.File,
            line: r.StartLine,
            rule: r.RuleID,
            secret: r.Secret,
            desc: `Exposed ${r.RuleID} credentials detected by Gitleaks.`
          }));
        } catch {}
      }
      console.warn('[Security Guard] Gitleaks runner failed, using JS entropy fallback:', err.message);
    }
  }
  
  const files = await scanDir(dirPath);
  for (const file of files) {
    if (file.name === '.env' || file.name === '.gitignore' || file.name === 'vector_cache.json') continue;
    
    try {
      const content = await fs.readFile(file.path, 'utf8');
      const lines = content.split('\n');
      
      lines.forEach((line, idx) => {
        if (line.includes('-----BEGIN PRIVATE KEY-----') || line.includes('-----BEGIN RSA PRIVATE KEY-----')) {
          secrets.push({
            file: file.path,
            line: idx + 1,
            rule: 'Private SSL Key',
            secret: 'PEM Header',
            desc: 'PEM private key block exposed.'
          });
        }
        if (line.includes('mongodb://') || line.includes('postgres://') || line.includes('mysql://')) {
          secrets.push({
            file: file.path,
            line: idx + 1,
            rule: 'DB Credentials',
            secret: 'Database URI',
            desc: 'Exposed database connection credentials in active file.'
          });
        }
        
        const quotes = line.match(/['"]([A-Za-z0-9\-_+=/]{16,80})['"]/g);
        if (quotes) {
          for (const q of quotes) {
            const val = q.substring(1, q.length - 1);
            const ent = shannonEntropy(val);
            
            if (val.length >= 24 && ent > 4.5) {
              if (line.includes('=') || line.includes(':')) {
                secrets.push({
                  file: file.path,
                  line: idx + 1,
                  rule: 'High-Entropy Secret Key',
                  secret: val,
                  desc: `Shannon entropy score: ${ent.toFixed(2)} (High probability of API Token)`
                });
              }
            }
          }
        }
      });
    } catch {}
  }
  
  return secrets;
}

// -------------------------------------------------------------
// Electron Window Creation
// -------------------------------------------------------------

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    backgroundColor: '#120b1c',
  });

  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist/index.html'));
  }
}

// -------------------------------------------------------------
// Electron IPC Listeners
// -------------------------------------------------------------

function getSemanticChunks(filePath, code) {
  const ext = path.extname(filePath).toLowerCase();
  const chunks = [];
  const lines = code.split('\n');
  const totalLines = lines.length;

  if (ext === '.js' || ext === '.jsx' || ext === '.ts' || ext === '.tsx') {
    try {
      const ast = parse(code, {
        sourceType: 'module',
        plugins: ['typescript', 'jsx', 'decorators-legacy', 'classProperties'],
      });

      const boundaries = [];

      traverse(ast, {
        FunctionDeclaration(path) {
          if (path.parentPath.isProgram() && path.node.loc) {
            boundaries.push({
              start: path.node.loc.start.line,
              end: path.node.loc.end.line,
              name: path.node.id ? path.node.id.name : 'anonymous'
            });
          }
        },
        ClassDeclaration(path) {
          if (path.parentPath.isProgram() && path.node.loc) {
            boundaries.push({
              start: path.node.loc.start.line,
              end: path.node.loc.end.line,
              name: path.node.id ? path.node.id.name : 'anonymous'
            });
          }
        },
        VariableDeclaration(path) {
          if (path.parentPath.isProgram() && path.node.loc) {
            boundaries.push({
              start: path.node.loc.start.line,
              end: path.node.loc.end.line,
              name: 'variable'
            });
          }
        },
        ExportNamedDeclaration(path) {
          if (path.parentPath.isProgram() && path.node.loc) {
            boundaries.push({
              start: path.node.loc.start.line,
              end: path.node.loc.end.line,
              name: 'export'
            });
          }
        }
      });

      boundaries.sort((a, b) => a.start - b.start);

      let currentStart = 1;
      while (currentStart <= totalLines) {
        let currentEnd = Math.min(currentStart + 59, totalLines);

        const overlappingBoundary = boundaries.find(b => b.start <= currentEnd && b.end > currentEnd);
        if (overlappingBoundary) {
          if (overlappingBoundary.start > currentStart) {
            currentEnd = overlappingBoundary.start - 1;
          } else {
            currentEnd = overlappingBoundary.end;
          }
        }

        const chunkLines = lines.slice(currentStart - 1, currentEnd);
        const chunkText = chunkLines.join('\n');
        
        if (chunkText.trim().length > 0) {
          chunks.push({
            startLine: currentStart,
            endLine: currentEnd,
            content: `// File: ${path.basename(filePath)} (Lines ${currentStart}-${currentEnd})\n\n${chunkText}`
          });
        }

        currentStart = currentEnd + 1;
      }

      if (chunks.length > 0) {
        return chunks;
      }
    } catch (err) {
      console.warn(`[Semantic Chunker] Babel parsing failed for ${filePath}, falling back to sliding window:`, err.message);
    }
  }

  const chunkSize = 50;
  const overlap = 10;
  let start = 1;

  while (start <= totalLines) {
    const end = Math.min(start + chunkSize - 1, totalLines);
    const chunkLines = lines.slice(start - 1, end);
    const chunkText = chunkLines.join('\n');
    
    if (chunkText.trim().length > 0) {
      chunks.push({
        startLine: start,
        endLine: end,
        content: `// File: ${path.basename(filePath)} (Lines ${start}-${end})\n\n${chunkText}`
      });
    }
    
    start += chunkSize - overlap;
  }

  return chunks;
}

ipcMain.handle('read-workspace-files', async (event, dirPath) => {
  try {
    if (!existsSync(dirPath)) {
      return { success: false, error: 'Directory does not exist' };
    }
    const files = await scanDir(dirPath);
    
    await loadVectorCache();
    await loadOrgCache();
    let hasNewEmbeddings = false;

    for (const file of files) {
      try {
        const stats = await fs.stat(file.path);
        const mtime = stats.mtimeMs;
        const content = await fs.readFile(file.path, 'utf8');
        documentIndex[file.path] = content;
        
        buildDependencies(file.path, content, dirPath);
        
        const cached = vectorCache[file.path];
        if (cached && cached.mtime === mtime) {
          continue;
        }

        const chunks = getSemanticChunks(file.path, content);
        let hasEmbeddings = false;

        for (const chunk of chunks) {
          try {
            chunk.embedding = await getOllamaEmbedding(chunk.content.substring(0, 1500));
            hasEmbeddings = true;
          } catch {
            // ignore chunk embedding failures
          }
        }

        if (hasEmbeddings) {
          vectorCache[file.path] = {
            mtime,
            chunks: chunks.map(c => ({
              startLine: c.startLine,
              endLine: c.endLine,
              content: c.content,
              embedding: c.embedding
            }))
          };
          hasNewEmbeddings = true;
        }
      } catch (err) {
        console.warn(`[Index Workspace] Failed to index ${file.path}:`, err.message);
      }
    }

    try {
      await indexGitDiffsInternal(dirPath);
    } catch {}

    if (hasNewEmbeddings) {
      await saveVectorCache();
    }

    return { success: true, files };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

async function requestDeveloperPermission(actionName, details) {
  const activeWindow = BrowserWindow.getFocusedWindow();
  
  const options = {
    type: 'warning',
    title: 'OmniSync Security Guard - Permission Request',
    message: `An agent is attempting a disk modification:`,
    detail: `Action: ${actionName}\nTarget: ${details}\n\nDo you want to allow this operation?`,
    buttons: ['Allow', 'Deny'],
    defaultId: 1,
    cancelId: 1
  };

  const result = activeWindow 
    ? await dialog.showMessageBox(activeWindow, options)
    : await dialog.showMessageBox(options);

  return result.response === 0;
}

ipcMain.handle('install-git-hook', async (event, workspaceId, dirPath) => {
  try {
    const approved = await requestDeveloperPermission('Install Git Hook', `Create pre-commit, post-commit, post-merge, and post-checkout hooks in ${dirPath}`);
    if (!approved) {
      return { success: false, error: 'Permission denied by developer.' };
    }

    const gitPath = path.join(dirPath, '.git');
    if (!existsSync(gitPath)) {
      return { success: false, error: 'Not a Git repository (no .git folder found)' };
    }
    
    const hooksPath = path.join(gitPath, 'hooks');
    if (!existsSync(hooksPath)) {
      await fs.mkdir(hooksPath, { recursive: true });
    }
    
    const hookContent = `#!/bin/bash\n# OmniSync Auto-Sync Git Hook\nREPO_DIR=$(git rev-parse --show-toplevel)\ncd "$REPO_DIR"\nif [ -d .agents ]; then\n  echo "Syncing local Antigravity customizations..."\n  node /home/shaanafshan2/omnisync-app/omnisyncd.js --sync-trigger "$REPO_DIR"\nfi\n`;
    
    await fs.writeFile(path.join(hooksPath, 'pre-commit'), hookContent, { mode: 0o755 });
    await fs.writeFile(path.join(hooksPath, 'post-commit'), hookContent, { mode: 0o755 });
    await fs.writeFile(path.join(hooksPath, 'post-merge'), hookContent, { mode: 0o755 });
    await fs.writeFile(path.join(hooksPath, 'post-checkout'), hookContent, { mode: 0o755 });
    
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('ast-compact', async (event, filePath, codeContent, promptText) => {
  try {
    let content = codeContent;
    if (!content && existsSync(filePath)) {
      content = await fs.readFile(filePath, 'utf8');
    }
    const compacted = compactCode(filePath, content || '', promptText || '');
    return { success: true, compacted };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Helper functions for Dense/Sparse Hybrid Search RAG
function getDocumentsForTier(tier) {
  const documents = [];
  
  // 1. Organization Tier
  if (tier === 'all' || tier === 'organization') {
    for (const [key, cacheEntry] of Object.entries(organizationCache)) {
      documents.push({
        id: `org://${key}`,
        filePath: `org://${key}`,
        relPath: `[Org Standards] ${key}`,
        content: cacheEntry.content || '',
        embedding: cacheEntry.embedding,
        tier: 'Organization'
      });
    }
  }

  // 2. Session Tier
  if (tier === 'all' || tier === 'session') {
    for (const [key, cacheEntry] of Object.entries(sessionCache)) {
      documents.push({
        id: `session://${key}`,
        filePath: `session://${key}`,
        relPath: `[Session State] ${key}`,
        content: cacheEntry.content || '',
        embedding: cacheEntry.embedding,
        tier: 'Session'
      });
    }
  }

  // 3. Workspace Tier
  if (tier === 'all' || tier === 'workspace') {
    for (const [filePath, content] of Object.entries(documentIndex)) {
      const cached = vectorCache[filePath];
      if (cached && cached.chunks) {
        cached.chunks.forEach(chunk => {
          documents.push({
            id: `${filePath}#L${chunk.startLine}-${chunk.endLine}`,
            filePath,
            relPath: `${path.basename(filePath)} (Lines ${chunk.startLine}-${chunk.endLine})`,
            content: chunk.content || '',
            embedding: chunk.embedding,
            tier: 'Workspace',
            startLine: chunk.startLine,
            endLine: chunk.endLine
          });
        });
      } else {
        documents.push({
          id: filePath,
          filePath,
          relPath: path.basename(filePath),
          content: content || '',
          embedding: cached ? cached.embedding : null,
          tier: 'Workspace',
          startLine: 1,
          endLine: content ? content.split('\n').length : 1
        });
      }
    }
  }

  return documents;
}

function tokenize(text) {
  if (!text) return [];
  
  // Split on non-alphanumeric to find words
  const rawWords = text.split(/[^a-zA-Z0-9]+/).filter(w => w.length > 2);
  const tokens = new Set();
  
  for (const word of rawWords) {
    tokens.add(word.toLowerCase());
    
    // Split camelCase and PascalCase
    let processed = word.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    processed = processed.replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
    
    const parts = processed.split(/\s+/).filter(w => w.length > 2);
    if (parts.length > 1) {
      parts.forEach(part => tokens.add(part.toLowerCase()));
    }
  }
  
  return Array.from(tokens);
}

function computeSparseTfIdf(queryText, documents) {
  const queryTerms = tokenize(queryText);
  if (queryTerms.length === 0) return [];

  const N = documents.length;
  const df = {};
  
  // Pre-tokenize documents for matching
  const docTokens = documents.map(doc => ({
    doc,
    tokens: tokenize(doc.content)
  }));

  queryTerms.forEach(term => {
    df[term] = 0;
    docTokens.forEach(dt => {
      if (dt.tokens.includes(term)) {
        df[term]++;
      }
    });
  });

  const idf = {};
  queryTerms.forEach(term => {
    const docFreq = df[term] || 0;
    idf[term] = Math.log(1 + (N - docFreq + 0.5) / (docFreq + 0.5));
  });

  const scores = [];
  docTokens.forEach(dt => {
    const termsInDoc = dt.tokens;
    const docLength = termsInDoc.length || 1;
    
    const tf = {};
    termsInDoc.forEach(term => {
      if (df[term] !== undefined) {
        tf[term] = (tf[term] || 0) + 1;
      }
    });

    let score = 0;
    queryTerms.forEach(term => {
      if (tf[term]) {
        const tfVal = tf[term] / docLength;
        score += tfVal * idf[term];
      }
    });

    if (score > 0) {
      const snippet = dt.doc.content.split('\n').slice(0, 4).join('\n');
      scores.push({
        ...dt.doc,
        score: parseFloat(score.toFixed(6)),
        snippet
      });
    }
  });

  return scores.sort((a, b) => b.score - a.score);
}

function computeDenseCosine(queryEmbedding, documents) {
  const scores = [];
  
  documents.forEach(doc => {
    if (!doc.embedding) return;
    
    let score = cosineSimilarity(queryEmbedding, doc.embedding);
    const weight = vectorWeights[doc.filePath] || 1.0;
    score = score * weight;

    if (score > 0) {
      const snippet = doc.content.split('\n').slice(0, 4).join('\n');
      scores.push({
        ...doc,
        score: parseFloat(score.toFixed(6)),
        snippet
      });
    }
  });

  return scores.sort((a, b) => b.score - a.score);
}

function reciprocalRankFusion(denseMatches, sparseMatches, k = 60) {
  const rrfScores = {};
  const docDetails = {};

  const addToDetails = (match) => {
    const id = match.id || match.filePath;
    if (!docDetails[id]) {
      docDetails[id] = match;
    }
  };

  denseMatches.forEach(addToDetails);
  sparseMatches.forEach(addToDetails);

  const denseRankMap = new Map();
  denseMatches.forEach((match, index) => {
    denseRankMap.set(match.id || match.filePath, index + 1);
  });

  const sparseRankMap = new Map();
  sparseMatches.forEach((match, index) => {
    sparseRankMap.set(match.id || match.filePath, index + 1);
  });

  const allDocIds = new Set([...denseRankMap.keys(), ...sparseRankMap.keys()]);

  allDocIds.forEach(id => {
    const rDense = denseRankMap.get(id) || 10000;
    const rSparse = sparseRankMap.get(id) || 10000;
    
    rrfScores[id] = (1 / (k + rDense)) + (1 / (k + rSparse));
  });

  const sortedIds = Object.keys(rrfScores).sort((a, b) => rrfScores[b] - rrfScores[a]);

  return sortedIds.map(id => {
    const details = docDetails[id];
    return {
      ...details,
      score: parseFloat(rrfScores[id].toFixed(6))
    };
  });
}

ipcMain.handle('query-vector-rag', async (event, promptText, useCloud, selectedTier) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    let queryEmbedding = null;
    let mode = 'Local TF-IDF Cache Router';
    
    if (useCloud && apiKey) {
      try {
        queryEmbedding = await getGeminiEmbedding(promptText, apiKey);
        mode = 'Gemini Dense/Sparse Hybrid Router (RRF Fused)';
      } catch (err) {
        console.warn('[RAG] Gemini embeddings request failed, using local fallback:', err.message);
      }
    }
    
    if (!queryEmbedding) {
      try {
        queryEmbedding = await getOllamaEmbedding(promptText);
        mode = 'Ollama Dense/Sparse Hybrid Router (RRF Fused)';
      } catch {
        console.warn('[RAG] Local Ollama embeddings request failed, falling back to sparse TF-IDF.');
      }
    }
    
    const tier = selectedTier || 'all';
    const documents = getDocumentsForTier(tier);
    
    // Compute sparse matching
    const sparseMatches = computeSparseTfIdf(promptText, documents);
    let matches = [];

    if (queryEmbedding) {
      // Compute dense matching
      const denseMatches = computeDenseCosine(queryEmbedding, documents);
      // Fuse with Reciprocal Rank Fusion
      matches = reciprocalRankFusion(denseMatches, sparseMatches);
    } else {
      matches = sparseMatches;
      mode = 'Local Sparse TF-IDF Search';
    }

    // Graph-RAG Topology Expansion
    if (matches.length > 0) {
      const topMatch = matches[0];
      const deps = dependencyGraph[topMatch.filePath] || [];
      
      deps.forEach(resolvedPath => {
        if (resolvedPath && resolvedPath !== topMatch.filePath && existsSync(resolvedPath)) {
          const existingMatch = matches.find(m => m.filePath === resolvedPath);
          if (existingMatch) {
            existingMatch.score = parseFloat((existingMatch.score * 1.15).toFixed(6));
            existingMatch.relPath = `🕸️ [Graph Boosted] ${existingMatch.relPath}`;
          } else {
            const cached = vectorCache[resolvedPath];
            const content = documentIndex[resolvedPath] || '';
            const doc = documents.find(d => d.filePath === resolvedPath) || {
              filePath: resolvedPath,
              relPath: `🕸️ [Graph Adjacency] ${path.basename(resolvedPath)}`,
              tier: 'Workspace',
              content
            };
            let baseScore = 0.5;
            if (cached && queryEmbedding) {
              baseScore = cosineSimilarity(queryEmbedding, cached.embedding) || 0.5;
            }
            matches.push({
              ...doc,
              filePath: resolvedPath,
              relPath: `🕸️ [Graph Adjacency] ${path.basename(resolvedPath)}`,
              score: parseFloat((baseScore * 0.9).toFixed(6)),
              snippet: content.split('\n').slice(0, 3).join('\n'),
              tier: 'Workspace'
            });
          }
        }
      });
      matches.sort((a, b) => b.score - a.score);
    }
    
    return {
      success: true,
      matches: matches.slice(0, 5),
      mode
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('auto-fix-secrets', async (event, workspaceId, dirPath) => {
  try {
    const approved = await requestDeveloperPermission('Auto-Fix Secrets', `Modify keys and credentials inside files of ${dirPath}`);
    if (!approved) {
      return { success: false, error: 'Permission denied by developer.' };
    }

    const leaks = await runSecurityAudit(dirPath);
    let secretsFixed = false;
    let envContent = '';
    
    const filesToFix = [...new Set(leaks.map(l => l.file))];
    for (const filePath of filesToFix) {
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        let modified = false;
        
        const newLines = lines.map(line => {
          if (line.includes('AWS_SECRET_ACCESS_KEY') && !line.includes('process.env')) {
            const match = line.match(/AWS_SECRET_ACCESS_KEY\s*=\s*['"]([^'"]+)['"]/);
            if (match) {
              envContent += `AWS_SECRET_ACCESS_KEY="${match[1]}"\n`;
              secretsFixed = true;
              modified = true;
              return line.replace(/=['"]([^'"]+)['"]/, '= process.env.AWS_SECRET_ACCESS_KEY');
            }
          }
          if (line.includes('API_TOKEN') && !line.includes('process.env')) {
            const match = line.match(/API_TOKEN\s*=\s*['"]([^'"]+)['"]/);
            if (match) {
              envContent += `API_TOKEN="${match[1]}"\n`;
              secretsFixed = true;
              modified = true;
              return line.replace(/=['"]([^'"]+)['"]/, '= process.env.API_TOKEN');
            }
          }
          return line;
        });
        
        if (modified) {
          await fs.writeFile(filePath, newLines.join('\n'), 'utf8');
        }
      } catch {
        // skip read-only files
      }
    }
    
    if (secretsFixed) {
      const envPath = path.join(dirPath, '.env');
      await fs.writeFile(envPath, envContent, { flag: 'a' });
      
      const gitignorePath = path.join(dirPath, '.gitignore');
      let gitignore = '';
      if (existsSync(gitignorePath)) {
        gitignore = await fs.readFile(gitignorePath, 'utf8');
      }
      if (!gitignore.includes('.env')) {
        const separator = (gitignore.endsWith('\n') || gitignore.length === 0) ? '' : '\n';
        await fs.writeFile(gitignorePath, gitignore + separator + '.env\n', 'utf8');
      }
    }
    
    return { success: true, fixed: secretsFixed };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('log-feedback', async (event, filePath, type) => {
  try {
    const current = vectorWeights[filePath] || 1.0;
    if (type === 'positive') {
      vectorWeights[filePath] = Math.min(current + 0.1, 1.5);
    } else if (type === 'negative') {
      vectorWeights[filePath] = Math.max(current - 0.2, 0.4);
    }
    console.log(`[Feedback Loop] Weight for ${filePath} adjusted to ${vectorWeights[filePath]}`);
    return { success: true, weight: vectorWeights[filePath] };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('index-git-diffs', async (event, dirPath) => {
  try {
    await indexGitDiffsInternal(dirPath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('reconcile-chat-history', async (event, transcriptText) => {
  try {
    const lines = transcriptText.split('\n');
    const rules = [];
    
    lines.forEach(line => {
      const trimmed = line.trim();
      if (trimmed.match(/^(?:always|do not|never|should|must|make sure|guideline|rule|prefer)\s+/i) && trimmed.length > 15) {
        rules.push(`- ${trimmed}`);
      }
    });
    
    const uniqueRules = [...new Set(rules)];
    if (uniqueRules.length === 0) {
      return { success: false, error: 'No structured coding guidelines found in transcript.' };
    }
    
    const formatted = `\n## Reconciled Chat Rules\n${uniqueRules.join('\n')}\n`;
    return { success: true, rules: formatted };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// -------------------------------------------------------------
// Validation & Self-Healing Utilities
// -------------------------------------------------------------

async function queryLLMText(promptText, useCloud) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  
  if (useCloud && apiKey) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }]
        })
      });
      if (response.ok) {
        const data = await response.json();
        if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts[0]) {
          return data.candidates[0].content.parts[0].text;
        }
      }
    } catch (err) {
      console.warn('[LLM Query] Gemini generateContent failed:', err.message);
    }
  }

  // Fallback to Ollama local
  try {
    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3',
        prompt: promptText,
        stream: false
      })
    });
    if (response.ok) {
      const data = await response.json();
      return data.response;
    }
  } catch (err) {
    console.warn('[LLM Query] Local Ollama generate failed:', err.message);
  }

  throw new Error('No LLM engine responded. Please check your Gemini API key or local Ollama daemon.');
}

function extractCodeFromMarkdown(text) {
  const matches = text.match(/```(?:[a-zA-Z0-9_\-\+]+)?\n([\s\S]*?)\n```/);
  if (matches && matches[1]) {
    return matches[1];
  }
  return text.trim();
}

async function runLinterEvaluation(filePath, codeContent) {
  const ext = path.extname(filePath).toLowerCase();
  const tempPath = path.join(path.dirname(filePath), `temp_eval_${Date.now()}${ext}`);
  
  let errors = 0;
  let warnings = 0;
  let details = [];

  try {
    await fs.writeFile(tempPath, codeContent, 'utf8');

    if (ext === '.js' || ext === '.jsx' || ext === '.ts' || ext === '.tsx') {
      try {
        const { stdout } = await execPromise(`npx oxlint --format=json "${tempPath}"`);
        const parsed = JSON.parse(stdout);
        parsed.forEach(fileResult => {
          fileResult.messages.forEach(msg => {
            if (msg.severity === 'error') {
              errors++;
              details.push(`[Error] ${msg.message}`);
            } else {
              warnings++;
              details.push(`[Warning] ${msg.message}`);
            }
          });
        });
      } catch (err) {
        if (err.stdout) {
          try {
            const parsed = JSON.parse(err.stdout);
            parsed.forEach(fileResult => {
              fileResult.messages.forEach(msg => {
                if (msg.severity === 'error') {
                  errors++;
                  details.push(`[Error] ${msg.message}`);
                } else {
                  warnings++;
                  details.push(`[Warning] ${msg.message}`);
                }
              });
            });
          } catch (e) {
            try {
              parse(codeContent, {
                sourceType: 'module',
                plugins: ['typescript', 'jsx', 'decorators-legacy', 'classProperties'],
              });
            } catch (babelErr) {
              errors++;
              details.push(`[Syntax Error] ${babelErr.message}`);
            }
          }
        } else {
          try {
            parse(codeContent, {
              sourceType: 'module',
              plugins: ['typescript', 'jsx', 'decorators-legacy', 'classProperties'],
            });
          } catch (babelErr) {
            errors++;
            details.push(`[Syntax Error] ${babelErr.message}`);
          }
        }
      }
    }
  } catch (outerErr) {
    errors++;
    details.push(`[Evaluation Failed] ${outerErr.message}`);
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }

  const confidence = Math.max(0, 100 - (errors * 20) - (warnings * 5));
  return { confidence, errors, warnings, details };
}

// -------------------------------------------------------------
// Self-Healing & Heuristic Evaluator IPC Handlers
// -------------------------------------------------------------

function getReferencedFiles(trace, mainFilePath) {
  const referenced = new Set();
  referenced.add(mainFilePath);
  
  for (const filePath of Object.keys(documentIndex)) {
    const relPath = path.relative(path.dirname(mainFilePath), filePath);
    const baseName = path.basename(filePath);
    if (trace.includes(filePath) || 
        (relPath && trace.includes(relPath)) || 
        (baseName && trace.includes(baseName) && (trace.includes('/' + baseName) || trace.includes('\\' + baseName)))) {
      referenced.add(filePath);
    }
  }
  return Array.from(referenced);
}

function parseLLMJSONOutput(response) {
  try {
    let jsonText = response.trim();
    if (jsonText.startsWith('```')) {
      const match = jsonText.match(/^```(?:json)?\s*([\s\S]*?)\s*```/);
      if (match) {
        jsonText = match[1];
      }
    }
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

ipcMain.handle('run-self-healing-tests', async (event, { filePath, initialCode, testCmd = 'npm test', maxRetries = 3, useCloud = true }) => {
  const approved = await requestDeveloperPermission('Self-Healing Tests', `Write code and execute tests on: ${filePath}`);
  if (!approved) {
    return { success: false, error: 'Permission denied by developer.' };
  }

  let currentCodes = { [filePath]: initialCode };
  let attempt = 0;
  let logs = [];
  let success = false;

  while (attempt <= maxRetries) {
    for (const [fp, code] of Object.entries(currentCodes)) {
      await fs.writeFile(fp, code, 'utf8');
    }

    logs.push(`[Self-Healing] Attempt ${attempt}: Running "${testCmd}"...`);
    try {
      const { stdout } = await execPromise(testCmd, { cwd: path.dirname(filePath), timeout: 15000 });
      logs.push(`[Self-Healing] Test passed! Output:\n${stdout}`);
      success = true;
      break;
    } catch (err) {
      const trace = (err.stdout || '') + '\n' + (err.stderr || '') + '\n' + err.message;
      logs.push(`[Self-Healing] Test failed. Trace:\n${trace}`);

      if (attempt === maxRetries) {
        break;
      }

      attempt++;
      
      const referencedFiles = getReferencedFiles(trace, filePath);
      logs.push(`[Self-Healing] Identified ${referencedFiles.length} file(s) in trace: ${referencedFiles.map(f => path.basename(f)).join(', ')}`);
      logs.push(`[Self-Healing] Querying LLM for fix (Attempt ${attempt}/${maxRetries})...`);

      const fileContexts = referencedFiles.map(fp => {
        const content = currentCodes[fp] || documentIndex[fp] || '';
        return `File Path: ${fp}\nContent:\n\`\`\`\n${content}\n\`\`\``;
      }).join('\n\n');

      const healPrompt = `You are an expert programmer. A compilation or test failure has occurred.
Below is the content of the files involved:

${fileContexts}

Test Command: ${testCmd}
Test Failure/Trace Output:
\`\`\`
${trace}
\`\`\`

Please analyze the trace and determine the required fixes across all the files. Fix the caller and called dependencies simultaneously to resolve all compilation/test failures.
Return a JSON object containing the corrected code for each file you choose to modify.
Use the following format exactly:
\`\`\`json
{
  "files": [
    {
      "path": "/absolute/path/to/file1",
      "content": "corrected code content..."
    }
  ]
}
\`\`\`
Return ONLY the JSON block, and no other text or explanation.`;

      try {
        const response = await queryLLMText(healPrompt, useCloud);
        const parsed = parseLLMJSONOutput(response);
        if (parsed && parsed.files && Array.isArray(parsed.files)) {
          parsed.files.forEach(f => {
            if (f.path && f.content !== undefined) {
              currentCodes[f.path] = f.content;
              logs.push(`[Self-Healing] Received fix suggestion for: ${path.basename(f.path)}`);
            }
          });
        } else {
          const extracted = extractCodeFromMarkdown(response);
          currentCodes[filePath] = extracted;
        }
      } catch (queryErr) {
        logs.push(`[Self-Healing] LLM query failed: ${queryErr.message}`);
        break;
      }
    }
  }

  return { success, code: currentCodes[filePath], logs };
});

ipcMain.handle('run-linter-healing', async (event, { filePath, initialCode, maxRetries = 3, useCloud = true }) => {
  const approved = await requestDeveloperPermission('Linter Quality Healing', `Analyze, validate, and write code to: ${filePath}`);
  if (!approved) {
    return { success: false, error: 'Permission denied by developer.' };
  }

  let currentCodes = { [filePath]: initialCode };
  let attempt = 0;
  let logs = [];
  let success = false;
  let finalConfidence = 0;

  while (attempt <= maxRetries) {
    for (const [fp, code] of Object.entries(currentCodes)) {
      await fs.writeFile(fp, code, 'utf8');
    }

    logs.push(`[Heuristic Evaluator] Attempt ${attempt}: Evaluating code quality for ${path.basename(filePath)}...`);
    const { confidence, errors, warnings, details } = await runLinterEvaluation(filePath, currentCodes[filePath]);
    
    logs.push(`[Heuristic Evaluator] Confidence Score: ${confidence}% (Errors: ${errors}, Warnings: ${warnings})`);
    if (details.length > 0) {
      logs.push(`[Heuristic Evaluator] Linter feedback:\n${details.join('\n')}`);
    }

    finalConfidence = confidence;

    if (confidence >= 85) {
      logs.push(`[Heuristic Evaluator] Quality threshold passed!`);
      success = true;
      break;
    }

    if (attempt === maxRetries) {
      break;
    }

    attempt++;
    
    const detailsText = details.join('\n');
    const referencedFiles = getReferencedFiles(detailsText, filePath);
    logs.push(`[Heuristic Evaluator] Identified ${referencedFiles.length} file(s) in linter trace: ${referencedFiles.map(f => path.basename(f)).join(', ')}`);
    logs.push(`[Heuristic Evaluator] Querying LLM for code improvement (Attempt ${attempt}/${maxRetries})...`);

    const fileContexts = referencedFiles.map(fp => {
      const content = currentCodes[fp] || documentIndex[fp] || '';
      return `File Path: ${fp}\nContent:\n\`\`\`\n${content}\n\`\`\``;
    }).join('\n\n');

    const lintPrompt = `You are an expert programmer. The code generated has lint errors or quality issues.
Below is the content of the files involved:

${fileContexts}

Lint / Syntax Errors & Feedback:
${detailsText}

Please fix the lint errors, ensure clean code structure, and rewrite the complete file content for each file. Return a JSON object containing the corrected code for each file you choose to modify.
Use the following format exactly:
\`\`\`json
{
  "files": [
    {
      "path": "/absolute/path/to/file1",
      "content": "corrected code content..."
    }
  ]
}
\`\`\`
Return ONLY the JSON block, and no other text or explanation.`;

    try {
      const response = await queryLLMText(lintPrompt, useCloud);
      const parsed = parseLLMJSONOutput(response);
      if (parsed && parsed.files && Array.isArray(parsed.files)) {
        parsed.files.forEach(f => {
          if (f.path && f.content !== undefined) {
            currentCodes[f.path] = f.content;
            logs.push(`[Heuristic Evaluator] Received fix suggestion for: ${path.basename(f.path)}`);
          }
        });
      } else {
        const extracted = extractCodeFromMarkdown(response);
        currentCodes[filePath] = extracted;
      }
    } catch (queryErr) {
      logs.push(`[Heuristic Evaluator] LLM query failed: ${queryErr.message}`);
      break;
    }
  }

  return { success, confidence: finalConfidence, code: currentCodes[filePath], logs };
});

ipcMain.handle('distill-chat-history', async (event, chatTurns, maxContextTurns = 4) => {
  try {
    if (!chatTurns || chatTurns.length <= maxContextTurns) {
      return { success: true, summary: '', activeTurns: chatTurns || [] };
    }
    
    const olderTurns = chatTurns.slice(0, chatTurns.length - maxContextTurns);
    const activeTurns = chatTurns.slice(chatTurns.length - maxContextTurns);
    
    const prompt = `You are an AI assistant. Please summarize the following conversation history turns into a single, concise paragraph of system instructions. Focus only on design decisions, rules, and preferences agreed upon, ignoring general chat noise.

Conversation turns:
${olderTurns.map(t => `${t.role}: ${t.content}`).join('\n')}`;

    const summary = await queryLLMText(prompt, true);
    return { success: true, summary: summary.trim(), activeTurns };
  } catch (err) {
  }
});

ipcMain.handle('route-model-prompt', async (event, promptText, codeContent = '') => {
  try {
    const complexKeywords = ['refactor', 'architect', 'deadlock', 'memory leak', 'scale', 'optimize', 'performance', 'concurrency', 'crdt', 'race condition', 'asynchronous', 'security', 'leak', 'conflict'];
    const simpleKeywords = ['how to', 'explain', 'create', 'generate', 'write a', 'what is', 'helper', 'simple', 'basic', 'todo'];
    
    const promptLower = promptText.toLowerCase();
    let score = 0;

    // 1. Length complexity
    score += Math.min(promptText.length / 100, 10);

    // 2. Keyword density
    complexKeywords.forEach(kw => {
      if (promptLower.includes(kw)) {
        score += 5;
      }
    });

    simpleKeywords.forEach(kw => {
      if (promptLower.includes(kw)) {
        score -= 2;
      }
    });

    // 3. Code content complexity (if provided)
    if (codeContent) {
      const lineCount = codeContent.split('\n').length;
      score += Math.min(lineCount / 50, 10);
    }

    let decision = 'LOCAL';
    let engineName = 'Local Ollama (Llama-3)';
    
    if (score >= 20) {
      decision = 'CLOUD_PRO';
      engineName = 'Gemini 1.5 Pro';
    } else if (score >= 10) {
      decision = 'CLOUD_FAST';
      engineName = 'Gemini 1.5 Flash';
    }

    const reason = `Complexity index is ${score.toFixed(1)}. Routed to ${engineName}.`;

    return { decision, score, reason };
  } catch (err) {
    return { decision: 'LOCAL', score: 0, reason: `Router error: ${err.message}. Defaulting to Local.` };
  }
});

ipcMain.handle('execute-swarm-pipeline', async (event, promptText, workspacePath) => {
  const targetDir = workspacePath || app.getAppPath();
  
  const spawnWorker = (scriptName, workerName) => {
    return new Promise((resolve) => {
      const scriptPath = path.join(__dirname, scriptName);
      const child = fork(scriptPath, [targetDir], { stdio: 'pipe' });
      
      let output = '';
      if (child.stdout) {
        child.stdout.on('data', (data) => {
          output += data.toString();
        });
      }
      if (child.stderr) {
        child.stderr.on('data', (data) => {
          output += data.toString();
        });
      }
      
      child.on('close', (code) => {
        resolve({
          name: workerName,
          success: code === 0,
          output: output.trim() || `Worker finished with exit code ${code}`
        });
      });
    });
  };

  const startTime = Date.now();
  
  // Real concurrent processes execution
  const results = await Promise.all([
    spawnWorker('linter_healer.js', 'Linter Healing'),
    spawnWorker('test_writer.js', 'Test Writing'),
    spawnWorker('doc_generator.js', 'Doc Generation')
  ]);

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  return {
    success: true,
    duration,
    results
  };
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
