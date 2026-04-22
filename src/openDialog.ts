import * as vscode from 'vscode';
import * as path from 'path';
import { WorkspaceRecord, WorkspaceStore } from './store';
import { FolderGitInfo, generateDescriptionFromCopilot } from './ai';
import { getCopilotChatTopics } from './copilotChat';

let currentPanel: vscode.WebviewPanel | undefined;
let currentResolver: ((v: 'current' | 'newWindow' | undefined) => void) | undefined;
let currentRecordId: string | undefined;

/**
 * 用 webview panel 显示一个美化的"打开工作区"对话框，支持 markdown 渲染描述。
 * 同一时间只复用一个 panel，多次调用会更新内容并 reveal。
 * 返回用户选择的窗口模式，或 undefined 表示取消。
 */
export function showOpenWorkspaceDialog(
  record: WorkspaceRecord,
  gitInfo: Map<string, FolderGitInfo>,
  store?: WorkspaceStore,
): Promise<'current' | 'newWindow' | undefined> {
  return new Promise(resolve => {
    if (currentResolver) {
      currentResolver(undefined);
      currentResolver = undefined;
    }

    currentRecordId = record.id;

    const handleMessage = async (panel: vscode.WebviewPanel, msg: any) => {
      if (msg.type === 'current' || msg.type === 'newWindow' || msg.type === 'cancel') {
        const r = currentResolver;
        currentResolver = undefined;
        r?.(msg.type === 'cancel' ? undefined : msg.type);
        panel.dispose();
        return;
      }
      if (msg.type === 'updateName' && store && currentRecordId) {
        const name = String(msg.value || '').trim();
        if (!name) return;
        await store.update(currentRecordId, { name });
        const updated = store.get(currentRecordId);
        if (updated) {
          await store.writeWorkspaceFile(updated);
          panel.title = `打开 ${updated.name}`;
        }
      }
      if (msg.type === 'updateDescription' && store && currentRecordId) {
        const description = String(msg.value || '');
        await store.update(currentRecordId, { description });
        const updated = store.get(currentRecordId);
        if (updated) {
          await store.writeWorkspaceFile(updated);
          panel.webview.postMessage({
            type: 'descriptionRendered',
            html: renderMarkdown(description) || '<em class="empty">暂无描述，双击可编辑</em>',
            raw: description,
          });
        }
      }
      if (msg.type === 'aiGenerateDescription' && currentRecordId) {
        const rec = store?.get(currentRecordId) ?? record;
        try {
          const topics = await getCopilotChatTopics(rec.filePath, rec.folders);
          const text = await generateDescriptionFromCopilot({
            name: rec.name,
            folders: rec.folders,
            topics,
          });
          panel.webview.postMessage({
            type: 'aiDescriptionResult',
            value: text,
            topicsCount: topics.length,
          });
        } catch (err: any) {
          panel.webview.postMessage({
            type: 'aiDescriptionResult',
            error: err?.message || String(err),
          });
        }
      }
    };

    if (currentPanel) {
      currentPanel.title = `打开 ${record.name}`;
      currentPanel.webview.html = renderHtml(record, gitInfo, currentPanel.webview);
      currentPanel.reveal(currentPanel.viewColumn ?? vscode.ViewColumn.Active, false);
    } else {
      const panel = vscode.window.createWebviewPanel(
        'workspaceManager.openDialog',
        `打开 ${record.name}`,
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
        { enableScripts: true, retainContextWhenHidden: true },
      );
      currentPanel = panel;

      panel.webview.onDidReceiveMessage(msg => handleMessage(panel, msg));
      panel.onDidDispose(() => {
        currentPanel = undefined;
        currentRecordId = undefined;
        const r = currentResolver;
        currentResolver = undefined;
        r?.(undefined);
      });

      panel.webview.html = renderHtml(record, gitInfo, panel.webview);
    }

    currentResolver = resolve;
  });
}

function renderHtml(
  record: WorkspaceRecord,
  gitInfo: Map<string, FolderGitInfo>,
  webview: vscode.Webview,
): string {
  const nonce = nonceStr();
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

  const folderRows = record.folders
    .map(f => {
      const info = gitInfo.get(f);
      const branch = info
        ? `<span class="branch"><svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.492 2.492 0 016 7h4a1 1 0 001-1v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z"/></svg>${escapeHtml(info.branch)}${info.dirty ? '<span class="dirty">●</span>' : ''}</span>`
        : '';
      return `<li><span class="fname">${escapeHtml(path.basename(f))}</span>${branch}<div class="fpath">${escapeHtml(f)}</div></li>`;
    })
    .join('');

  const descRaw = record.description || '';
  const descHtml = descRaw ? renderMarkdown(descRaw) : '<em class="empty">暂无描述，双击可编辑</em>';

  return /* html */ `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${escapeHtml(record.name)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0; padding: 24px 28px;
    width: 50vw; min-width: 380px; max-width: 100%;
    font-size: 13px; line-height: 1.6;
    box-sizing: border-box;
  }
  .header { display: flex; align-items: center; gap: 8px; margin: 0 0 4px; }
  .header .icon { font-size: 18px; color: var(--vscode-symbolIcon-folderForeground, var(--vscode-foreground)); }
  .name {
    font-size: 18px; font-weight: 600;
    padding: 2px 6px; border-radius: 3px; outline: none;
    border: 1px solid transparent; min-width: 100px;
    transition: background .15s, border-color .15s;
  }
  .name:hover { background: var(--vscode-list-hoverBackground); }
  .name:focus { background: var(--vscode-input-background); border-color: var(--vscode-focusBorder); }
  .edit-hint { font-size: 11px; color: var(--vscode-descriptionForeground); opacity: 0; transition: opacity .15s; }
  .header:hover .edit-hint { opacity: .7; }
  .subtitle { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 2px 0 18px; padding-left: 26px; }
  h2 {
    font-size: 11px; font-weight: 600; text-transform: uppercase;
    color: var(--vscode-descriptionForeground); margin: 18px 0 8px;
    letter-spacing: .5px;
    display: flex; align-items: center; gap: 8px;
  }
  h2 .hint { font-size: 10px; opacity: .7; text-transform: none; font-weight: normal; letter-spacing: 0; }
  ul.folders { list-style: none; padding: 0; margin: 0; }
  ul.folders li {
    padding: 8px 12px; margin-bottom: 4px;
    background: var(--vscode-list-hoverBackground);
    border-radius: 4px; border-left: 2px solid var(--vscode-textLink-foreground);
  }
  .fname { font-weight: 600; font-size: 13px; }
  .branch {
    display: inline-flex; align-items: center; gap: 3px;
    margin-left: 8px; padding: 1px 7px; border-radius: 10px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    font-size: 11px;
  }
  .branch svg { opacity: .8; }
  .dirty { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); margin-left: 2px; }
  .fpath {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px; color: var(--vscode-descriptionForeground);
    margin-top: 2px; word-break: break-all;
  }
  .desc-wrap { position: relative; }
  .desc {
    background: var(--vscode-textBlockQuote-background, var(--vscode-list-hoverBackground));
    border-left: 2px solid var(--vscode-textBlockQuote-border, var(--vscode-textLink-foreground));
    padding: 10px 14px; border-radius: 4px;
    font-size: 13px; cursor: text; min-height: 40px;
  }
  .desc:hover { outline: 1px dashed var(--vscode-input-border, var(--vscode-panel-border)); }
  .desc p { margin: 0 0 8px; }
  .desc p:last-child { margin-bottom: 0; }
  .desc code {
    background: var(--vscode-textCodeBlock-background); padding: 1px 5px;
    border-radius: 3px; font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
  }
  .desc strong { color: var(--vscode-foreground); }
  .desc ul, .desc ol { margin: 4px 0 8px; padding-left: 22px; }
  .desc li { margin: 2px 0; }
  .empty { color: var(--vscode-descriptionForeground); }
  textarea.desc-edit {
    width: 100%; min-height: 120px; resize: vertical;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-focusBorder); border-radius: 4px;
    padding: 10px 14px; font-family: var(--vscode-editor-font-family, monospace); font-size: 13px;
    outline: none;
  }
  .desc-actions { margin-top: 6px; display: flex; align-items: center; gap: 6px; font-size: 11px; }
  .desc-actions button { padding: 4px 10px; font-size: 11px; }
  .btn-ai {
    background: transparent; color: var(--vscode-textLink-foreground);
    border: 1px solid var(--vscode-button-secondaryBackground); border-radius: 3px;
    display: inline-flex; align-items: center; gap: 4px; cursor: pointer;
  }
  .btn-ai:hover { background: var(--vscode-list-hoverBackground); }
  .btn-ai .icon { font-size: 12px; }
  .btn-ai.loading .icon { animation: spin 1s linear infinite; display: inline-block; }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .actions {
    margin-top: 24px; display: flex; gap: 8px; justify-content: flex-end;
  }
  button {
    font-family: inherit; font-size: 13px;
    padding: 6px 16px; border-radius: 2px; cursor: pointer; border: none;
  }
  .btn-primary {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
  .btn-secondary {
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
  }
  .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
</style>
</head>
<body>
  <div class="header">
    <span class="icon">📁</span>
    <span class="name" id="name" contenteditable="true" spellcheck="false">${escapeHtml(record.name)}</span>
    <span class="edit-hint">点击可编辑</span>
  </div>
  <div class="subtitle">${record.folders.length} 个文件夹</div>

  <h2>描述 <span class="hint">双击编辑 · 支持 Markdown</span></h2>
  <div class="desc-wrap">
    <div class="desc" id="desc" data-raw="${escapeHtml(descRaw)}">${descHtml}</div>
  </div>

  <h2>包含项目</h2>
  <ul class="folders">${folderRows}</ul>

  <div class="actions">
    <button class="btn-secondary" id="cancel">取消</button>
    <button class="btn-secondary" id="newWindow">新窗口打开</button>
    <button class="btn-primary" id="current">当前窗口打开</button>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById('current').onclick = () => vscode.postMessage({ type: 'current' });
  document.getElementById('newWindow').onclick = () => vscode.postMessage({ type: 'newWindow' });
  document.getElementById('cancel').onclick = () => vscode.postMessage({ type: 'cancel' });

  // 名称编辑
  const nameEl = document.getElementById('name');
  let originalName = nameEl.textContent;
  nameEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
    if (e.key === 'Escape') { nameEl.textContent = originalName; nameEl.blur(); }
  });
  nameEl.addEventListener('blur', () => {
    const v = (nameEl.textContent || '').trim();
    if (!v) { nameEl.textContent = originalName; return; }
    if (v !== originalName) {
      originalName = v;
      nameEl.textContent = v;
      vscode.postMessage({ type: 'updateName', value: v });
    }
  });

  // 描述编辑
  const descWrap = document.querySelector('.desc-wrap');
  const descEl = document.getElementById('desc');
  let descRaw = descEl.dataset.raw || '';
  let currentTextarea = null;
  let currentAiBtn = null;
  function enterDescEdit() {
    if (descWrap.querySelector('textarea')) return;
    const ta = document.createElement('textarea');
    ta.className = 'desc-edit';
    ta.value = descRaw;
    const acts = document.createElement('div');
    acts.className = 'desc-actions';
    const aiBtn = document.createElement('button');
    aiBtn.className = 'btn-ai'; aiBtn.type = 'button';
    aiBtn.innerHTML = '<span class="icon">\u2728</span> <span class="label">AI \u751f\u6210</span>';
    aiBtn.title = '\u6839\u636e Copilot \u4f1a\u8bdd\u4e3b\u9898\u751f\u6210\u63cf\u8ff0';
    const spacer = document.createElement('div'); spacer.style.flex = '1';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-secondary'; cancelBtn.textContent = '取消';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn-primary'; saveBtn.textContent = '保存';
    acts.append(aiBtn, spacer, cancelBtn, saveBtn);
    descEl.style.display = 'none';
    descWrap.append(ta, acts);
    ta.focus();
    currentTextarea = ta; currentAiBtn = aiBtn;
    const cleanup = () => { currentTextarea = null; currentAiBtn = null; ta.remove(); acts.remove(); descEl.style.display = ''; };
    cancelBtn.onclick = cleanup;
    saveBtn.onclick = () => {
      descRaw = ta.value;
      vscode.postMessage({ type: 'updateDescription', value: descRaw });
      cleanup();
    };
    aiBtn.onclick = () => {
      if (aiBtn.dataset.loading === '1') return;
      aiBtn.dataset.loading = '1';
      aiBtn.classList.add('loading');
      aiBtn.querySelector('.label').textContent = '生成中…';
      ta.disabled = true;
      vscode.postMessage({ type: 'aiGenerateDescription' });
    };
    ta.addEventListener('keydown', e => {
      if (e.key === 'Escape') cancelBtn.click();
      else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') saveBtn.click();
    });
  }
  descEl.addEventListener('dblclick', enterDescEdit);

  window.addEventListener('message', e => {
    const d = e.data;
    if (!d) return;
    if (d.type === 'descriptionRendered') {
      descRaw = d.raw || '';
      descEl.dataset.raw = descRaw;
      descEl.innerHTML = d.html;
    } else if (d.type === 'aiDescriptionResult') {
      if (currentAiBtn) {
        currentAiBtn.dataset.loading = '';
        currentAiBtn.classList.remove('loading');
        currentAiBtn.querySelector('.label').textContent = 'AI 生成';
      }
      if (currentTextarea) {
        currentTextarea.disabled = false;
        if (d.error) {
          alert('AI 生成失败：' + d.error);
        } else {
          currentTextarea.value = d.value || '';
          const hint = typeof d.topicsCount === 'number' && d.topicsCount === 0
            ? '\u672a\u627e\u5230\u8be5\u5de5\u4f5c\u533a\u7684 Copilot \u4f1a\u8bdd\uff0c\u5df2\u4f7f\u7528 git \u8bb0\u5f55\u751f\u6210'
            : null;
          if (hint) {
            // 临时提示
            const tip = document.createElement('div');
            tip.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground);margin-top:4px;';
            tip.textContent = hint;
            currentTextarea.parentElement.insertBefore(tip, currentTextarea.nextSibling);
            setTimeout(() => tip.remove(), 4000);
          }
          currentTextarea.focus();
        }
      }
    }
  });

  document.addEventListener('keydown', e => {
    if (document.activeElement && (document.activeElement.tagName === 'TEXTAREA' || document.activeElement.isContentEditable)) return;
    if (e.key === 'Escape') vscode.postMessage({ type: 'cancel' });
    else if (e.key === 'Enter' && !e.shiftKey) vscode.postMessage({ type: 'current' });
  });
</script>
</body>
</html>`;
}

/** 极简 markdown 渲染：支持 **粗体**、*斜体*、\`code\`、- 列表、段落 */
function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inList = false;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (inList) { out.push('</ul>'); inList = false; }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { flushPara(); flushList(); continue; }
    const m = line.match(/^\s*[-*]\s+(.*)$/);
    if (m) {
      flushPara();
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara(); flushList();
  return out.join('');
}

function inline(s: string): string {
  let r = escapeHtml(s);
  r = r.replace(/`([^`]+)`/g, '<code>$1</code>');
  r = r.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  r = r.replace(/(^|\W)\*([^*\s][^*]*)\*(?=\W|$)/g, '$1<em>$2</em>');
  return r;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function nonceStr(): string {
  let t = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) t += chars.charAt(Math.floor(Math.random() * chars.length));
  return t;
}
