# OmniSync: Real-Time CRDT & Secure Swarm Workspace

OmniSync is a local-first, highly secure collaborative development workspace builder. It integrates real-time CRDT synchronization, cost-sensitive model routing, AST-based semantic code chunking for precise RAG, and secure concurrent swarm pipelines.

---

## 1. Core Project Function

OmniSync orchestrates AI-assisted development environments by bridging local context (AST pruning, local vector store search, Ollama model instances) with secure remote synchronization. Its primary goal is to optimize developer productivity while protecting source code integrity and reducing API token costs.

---

## 2. Key Implemented Features

### 📡 Real-Time CRDT Rule Sync (`omnisyncd.js`)
*   **State Sharing**: Leverages `Yjs` document listeners to synchronize project and global rulebooks between workspace peers.
*   **Conflict Resolution**: Detects `remote-origin` updates to prevent infinite feedback loops during multi-user collaboration.
*   **Tamper-Proof Signatures**: Protects the synchronization pipeline using SSH-key cryptography. Every Git hook synchronization update is signed using `~/.ssh/id_rsa` and verified via public keys before being applied by the central daemon.

### 🧠 Semantic-Overlap RAG & AST Compaction
*   **AST-based Chunking**: Replaces raw, arbitrary line chunking with Babel AST-based semantic analysis. Code snippets are grouped along logical boundaries (classes, methods, functions) to maintain context.
*   **Dense/Sparse Hybrid Search**: Combines vector database embeddings with TF-IDF fallback structures for accurate retrieval matching.
*   **AST Compaction**: Prunes function bodies, boilerplate, and irrelevant lines from large source files to present distilled context to the LLM.

### 🔀 Cost-Sensitive Model Router (`route-model-prompt`)
*   **Dynamic Complexity Routing**: Evaluates incoming developer queries based on length, complexity metrics, and keyword heuristics.
*   **Three-Tier Execution**:
    1.  `LOCAL`: Low-complexity prompts run locally on Ollama (`Llama-3`) at zero cost.
    2.  `CLOUD_FAST`: Medium-complexity prompts run on **Gemini 1.5 Flash** for high speed and minimal token cost.
    3.  `CLOUD_PRO`: High-complexity architecture/debugging prompts run on **Gemini 1.5 Pro**.

### ⚙️ Parallel Swarm Worker Pipeline
*   **Process Concurrency**: Initiates concurrent worker processes utilizing Node's `child_process` and `Promise.all`.
*   **Interactive Topology**: Hooks into the workspace frontend to display real-time execution outputs for linter healers, unit test writers, and doc generators in parallel, merging their final outputs into the developer's log.

---

## 3. Future Roadmap

### 🔐 1. Strict Whitelist-based Rule Access Control
*   Extend the current signature verification to match incoming public keys against a local `.agents/authorized_keys` whitelist, rejecting any un-approved signatures even if validly signed.

### 🗄️ 2. Vector DB Migration & Hybrid Indexing
*   Migrate from simple JSON vector files to a dedicated SQLite/Vector database for faster hybrid retrieval at scale.
*   Implement automatic incremental indexing of Git diffs on file-save.

### 🔄 3. Bi-directional Daemon Conflict Healing
*   Enhance the CRDT engine with structured merge-conflict UI markers, allowing developers to visually reconcile divergent rulebooks using git-like diff screens.

---

*This document is stored in [README.md](file:///home/shaanafshan2/omnisync-app/DOCS/README.md) for local persistence.*
