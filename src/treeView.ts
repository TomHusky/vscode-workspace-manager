import * as vscode from 'vscode';
import * as path from 'path';
import { WorkspaceRecord, WorkspaceStore } from './store';
import { getFoldersGitInfo, FolderGitInfo } from './ai';

export class WorkspaceListProvider implements vscode.TreeDataProvider<WorkspaceRecord> {
  private _onDidChangeTreeData = new vscode.EventEmitter<WorkspaceRecord | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private gitCache = new Map<string, Map<string, FolderGitInfo>>();

  constructor(private readonly store: WorkspaceStore) {
    store.onDidChange(() => {
      this.gitCache.clear();
      this._onDidChangeTreeData.fire();
    });
  }

  refresh() {
    this.gitCache.clear();
    this._onDidChangeTreeData.fire();
  }

  async ensureGitInfo(record: WorkspaceRecord): Promise<Map<string, FolderGitInfo>> {
    const cached = this.gitCache.get(record.id);
    if (cached) return cached;
    const info = await getFoldersGitInfo(record.folders);
    this.gitCache.set(record.id, info);
    return info;
  }

  getTreeItem(record: WorkspaceRecord): vscode.TreeItem {
    const item = new vscode.TreeItem(record.name, vscode.TreeItemCollapsibleState.None);
    item.id = record.id;
    item.description = `${record.folders.length} 个文件夹`;
    item.iconPath = new vscode.ThemeIcon('folder-library');
    item.contextValue = 'workspace';
    item.tooltip = buildTooltip(record, this.gitCache.get(record.id));
    item.command = {
      command: 'workspaceManager.openItem',
      title: '打开工作区',
      arguments: [record.id],
    };
    if (!this.gitCache.has(record.id)) {
      this.ensureGitInfo(record).then(() => this._onDidChangeTreeData.fire(record));
    }
    return item;
  }

  getChildren(): WorkspaceRecord[] {
    return this.store.list();
  }
}

function buildTooltip(record: WorkspaceRecord, gitInfo?: Map<string, FolderGitInfo>): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.supportThemeIcons = true;
  md.appendMarkdown(`**${escapeMd(record.name)}**\n\n`);
  for (const f of record.folders) {
    const info = gitInfo?.get(f);
    const branch = info ? `  $(git-branch) ${info.branch}${info.dirty ? '\\*' : ''}` : '';
    md.appendMarkdown(`- \`${path.basename(f)}\`${branch}\n`);
  }
  return md;
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}\[\]()#+\-.!]/g, m => `\\${m}`);
}
