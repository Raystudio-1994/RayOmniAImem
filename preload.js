const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('omnisyncAPI', {
  readWorkspaceFiles: (dirPath) => ipcRenderer.invoke('read-workspace-files', dirPath),
  installGitHook: (workspaceId, dirPath) => ipcRenderer.invoke('install-git-hook', workspaceId, dirPath),
  compactCode: (filePath, codeContent, promptText) => ipcRenderer.invoke('ast-compact', filePath, codeContent, promptText),
  queryVectorRag: (promptText, useCloud, selectedTier) => ipcRenderer.invoke('query-vector-rag', promptText, useCloud, selectedTier),
  autoFixSecrets: (workspaceId, dirPath) => ipcRenderer.invoke('auto-fix-secrets', workspaceId, dirPath),
  logFeedback: (filePath, type) => ipcRenderer.invoke('log-feedback', filePath, type),
  indexGitDiffs: (dirPath) => ipcRenderer.invoke('index-git-diffs', dirPath),
  reconcileChatHistory: (transcriptText) => ipcRenderer.invoke('reconcile-chat-history', transcriptText),
  runSelfHealingTests: (args) => ipcRenderer.invoke('run-self-healing-tests', args),
  runLinterHealing: (args) => ipcRenderer.invoke('run-linter-healing', args),
  distillChatHistory: (chatTurns, maxContextTurns) => ipcRenderer.invoke('distill-chat-history', chatTurns, maxContextTurns),
  routeModelPrompt: (promptText, codeContent) => ipcRenderer.invoke('route-model-prompt', promptText, codeContent),
  executeSwarmPipeline: (promptText, workspacePath) => ipcRenderer.invoke('execute-swarm-pipeline', promptText, workspacePath),
});
