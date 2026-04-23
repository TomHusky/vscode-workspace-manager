import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { WorkspaceStore } from './store';
import { generateDescription, generateName, getFoldersGitInfo } from './ai';
import { showOpenWorkspaceDialog } from './openDialog';

export class BuilderViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'workspaceManager.builderV2';
  private view?: vscode.WebviewView;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: WorkspaceStore,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      try {
        switch (msg.type) {
          case 'pickFolders':
            await this.pickFolders();
            break;
          case 'validatePaths':
            await this.validatePaths(msg.paths || []);
            break;
          case 'generateName':
            await this.generateName(msg.folders || []);
            break;
          case 'generateDescription':
            await this.generateDesc(msg.name || '', msg.folders || []);
            break;
          case 'create':
            await this.create(msg.name, msg.description, msg.folders, !!msg.openAfter);
            break;
        }
      } catch (err: any) {
        webviewView.webview.postMessage({ type: 'error', message: err?.message || String(err) });
      }
    });
  }

  private async pickFolders() {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: true,
      openLabel: '添加到工作区',
    });
    if (!picked || picked.length === 0) return;
    const folders = picked.map(u => u.fsPath);
    this.view?.webview.postMessage({ type: 'foldersAdded', folders });
  }

  private async validatePaths(paths: string[]) {
    const valid: string[] = [];
    const invalid: string[] = [];
    for (const p of paths) {
      try {
        const stat = await fs.stat(p);
        if (stat.isDirectory()) valid.push(p);
        else invalid.push(p);
      } catch {
        invalid.push(p);
      }
    }
    this.view?.webview.postMessage({ type: 'validateResult', valid, invalid });
  }

  private async generateDesc(name: string, folders: string[]) {
    this.view?.webview.postMessage({ type: 'descriptionGenerating' });
    const desc = await generateDescription({ name: name || '工作区', folders });
    this.view?.webview.postMessage({ type: 'descriptionGenerated', description: desc });
  }

  private async generateName(folders: string[]) {
    this.view?.webview.postMessage({ type: 'nameGenerating' });
    const name = await generateName(folders);
    this.view?.webview.postMessage({ type: 'nameGenerated', name });
  }

  private async create(name: string, description: string, folders: string[], openAfter: boolean) {
    if (!folders || folders.length === 0) {
      throw new Error('请至少添加一个文件夹');
    }
    if (!name || !name.trim()) {
      name = path.basename(folders[0]) + ' 工作区';
    }
    const record = await this.store.createWorkspace({
      name: name.trim(),
      description: (description || '').trim(),
      folders,
    });
    vscode.window.showInformationMessage(`工作区已创建：${record.name}`);
    this.view?.webview.postMessage({ type: 'created' });
    if (openAfter) {
      const gitInfo = await getFoldersGitInfo(record.folders);
      const mode = await showOpenWorkspaceDialog(record, gitInfo, this.store);
      if (mode) {
        const uri = vscode.Uri.file(record.filePath);
        await vscode.commands.executeCommand('vscode.openFolder', uri, mode === 'newWindow');
      }
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return /* html */ `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>新建工作区</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px 14px 18px; font-size: var(--vscode-font-size); }
  h3 { margin: 6px 0 8px; font-size: 11px; text-transform: uppercase; opacity: .7; letter-spacing: .3px; }
  .field { margin-bottom: 12px; }
  label { display: block; margin-bottom: 4px; font-size: 11px; opacity: .85; }
  input, textarea {
    width: 100%; box-sizing: border-box;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); padding: 6px 8px; border-radius: 2px;
    font-family: inherit; font-size: 12px;
  }
  textarea { min-height: 64px; resize: vertical; padding-right: 30px; }
  .input-wrap { position: relative; }
  .input-wrap input { padding-right: 30px; }
  .ai-btn {
    position: absolute; top: 4px; right: 4px;
    background: transparent; border: none; cursor: pointer;
    color: var(--vscode-textLink-foreground); padding: 2px 6px; border-radius: 3px;
    font-size: 13px; line-height: 1; opacity: .75;
  }
  .ai-btn:hover { background: var(--vscode-toolbar-hoverBackground); opacity: 1; }
  .ai-btn:disabled { opacity: .35; cursor: default; }
  .ai-btn.spin { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .drop {
    border: 1px dashed var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 4px; padding: 20px 12px; text-align: center; cursor: pointer;
    color: var(--vscode-descriptionForeground); transition: background .15s, border-color .15s;
    user-select: none;
  }
  .drop:hover { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-focusBorder); color: var(--vscode-foreground); }
  .drop.dragover { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-focusBorder); color: var(--vscode-foreground); }
  .drop .main { font-size: 13px; margin-bottom: 4px; }
  .drop .hint { font-size: 11px; opacity: .7; }
  .folders { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
  .folder {
    display: flex; align-items: center; gap: 6px; padding: 4px 6px;
    background: var(--vscode-list-hoverBackground); border-radius: 3px; font-size: 12px;
  }
  .folder .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .folder.invalid { color: var(--vscode-errorForeground); opacity: .8; }
  .folder button { background: transparent; color: inherit; border: none; cursor: pointer; opacity: .6; }
  .folder button:hover { opacity: 1; }
  button.primary {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; padding: 6px 14px; border-radius: 2px; cursor: pointer; font-size: 12px;
  }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
    border: none; padding: 6px 14px; border-radius: 2px; cursor: pointer; font-size: 12px;
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .actions { display: flex; gap: 8px; margin-top: 12px; align-items: center; flex-wrap: wrap; }
  .checkbox { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; margin-left: auto; white-space: nowrap; }
  .checkbox input { width: auto; margin: 0; }
</style>
</head>
<body>
  <h3>1. 添加文件夹</h3>
  <div id="drop" class="drop" role="button" tabindex="0">
    <div class="main">点击或拖拽文件夹到此处</div>
    <div class="hint">支持系统目录多选</div>
  </div>
  <div id="folders" class="folders"></div>

  <h3 style="margin-top:14px">2. 命名与描述</h3>
  <div class="field">
    <label>名称</label>
    <div class="input-wrap">
      <input id="name" placeholder="工作区名称" />
      <button id="genName" class="ai-btn" type="button" title="AI 自动生成名称">✨</button>
    </div>
  </div>
  <div class="field">
    <label>描述</label>
    <div class="input-wrap">
      <textarea id="desc" placeholder="工作区用途简介，可选"></textarea>
      <button id="genDesc" class="ai-btn" type="button" title="AI 自动生成描述">✨</button>
    </div>
  </div>

  <div class="actions">
    <button id="createBtn" class="primary" type="button">生成工作区</button>
    <button id="clearBtn" class="secondary" type="button">清空</button>
    <label class="checkbox">
      <input type="checkbox" id="openAfter" checked />
      <span>创建后打开</span>
    </label>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const drop = document.getElementById('drop');
  const foldersEl = document.getElementById('folders');
  const nameEl = document.getElementById('name');
  const descEl = document.getElementById('desc');
  const genNameBtn = document.getElementById('genName');
  const genDescBtn = document.getElementById('genDesc');
  let folders = [];
  let invalids = new Set();

  function render() {
    foldersEl.innerHTML = '';
    folders.forEach((f, i) => {
      const div = document.createElement('div');
      div.className = 'folder' + (invalids.has(f) ? ' invalid' : '');
      const name = document.createElement('span');
      name.className = 'name';
      name.title = f;
      name.textContent = f;
      const rm = document.createElement('button');
      rm.textContent = '✕';
      rm.title = '移除';
      rm.onclick = () => { folders.splice(i, 1); render(); };
      div.appendChild(name);
      div.appendChild(rm);
      foldersEl.appendChild(div);
    });
  }

  function addFolders(list) {
    for (const p of list) {
      if (p && !folders.includes(p)) folders.push(p);
    }
    render();
    if (list.length) vscode.postMessage({ type: 'validatePaths', paths: list });
  }

  // 整个 drop 区域点击 / 回车均打开选择器
  function openPicker() { vscode.postMessage({ type: 'pickFolders' }); }
  drop.addEventListener('click', openPicker);
  drop.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); }
  });

  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('dragover');
    const list = [];
    if (e.dataTransfer.files && e.dataTransfer.files.length) {
      for (const f of e.dataTransfer.files) {
        const p = f.path;
        if (p) list.push(p);
      }
    }
    if (list.length === 0) {
      const uri = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
      if (uri) {
        uri.split(/\\r?\\n/).forEach(u => {
          if (!u || u.startsWith('#')) return;
          try {
            const url = new URL(u);
            if (url.protocol === 'file:') list.push(decodeURIComponent(url.pathname));
          } catch {}
        });
      }
    }
    addFolders(list);
  });

  function setSpin(btn, on) {
    btn.disabled = on;
    btn.classList.toggle('spin', on);
    btn.textContent = on ? '⟳' : '✨';
  }

  genNameBtn.addEventListener('click', () => {
    if (folders.length === 0) return;
    setSpin(genNameBtn, true);
    vscode.postMessage({ type: 'generateName', folders });
  });

  genDescBtn.addEventListener('click', () => {
    if (folders.length === 0) return;
    setSpin(genDescBtn, true);
    vscode.postMessage({ type: 'generateDescription', name: nameEl.value, folders });
  });

  document.getElementById('createBtn').addEventListener('click', () => {
    vscode.postMessage({
      type: 'create',
      name: nameEl.value,
      description: descEl.value,
      folders,
      openAfter: document.getElementById('openAfter').checked,
    });
  });

  document.getElementById('clearBtn').addEventListener('click', () => {
    folders = []; invalids.clear();
    nameEl.value = ''; descEl.value = '';
    render();
  });

  window.addEventListener('message', e => {
    const msg = e.data;
    switch (msg.type) {
      case 'foldersAdded':
        addFolders(msg.folders);
        break;
      case 'validateResult':
        (msg.invalid || []).forEach(p => invalids.add(p));
        render();
        break;
      case 'nameGenerating':
        setSpin(genNameBtn, true);
        break;
      case 'nameGenerated':
        setSpin(genNameBtn, false);
        if (msg.name) nameEl.value = msg.name;
        break;
      case 'descriptionGenerating':
        setSpin(genDescBtn, true);
        break;
      case 'descriptionGenerated':
        setSpin(genDescBtn, false);
        descEl.value = msg.description || '';
        break;
      case 'created':
        folders = []; invalids.clear();
        nameEl.value = ''; descEl.value = '';
        render();
        break;
    }
  });
</script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}
