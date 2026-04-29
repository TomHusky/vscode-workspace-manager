import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { WorkspaceStore, WorkspaceRecord } from './store';
import { WorkspaceListProvider, RecycleBinProvider } from './treeView';
import { BuilderViewProvider } from './builderView';
import { generateDescription, getFoldersGitInfo } from './ai';
import { showOpenWorkspaceDialog } from './openDialog';

export function activate(context: vscode.ExtensionContext) {
  const store = new WorkspaceStore(context);
  const listProvider = new WorkspaceListProvider(store);
  const recycleProvider = new RecycleBinProvider(store);
  const builderProvider = new BuilderViewProvider(context, store);

  const treeView = vscode.window.createTreeView('workspaceManager.list', {
    treeDataProvider: listProvider,
    showCollapseAll: true,
  });
  const recycleView = vscode.window.createTreeView('workspaceManager.recycle', {
    treeDataProvider: recycleProvider,
  });

  context.subscriptions.push(
    treeView,
    recycleView,
    vscode.window.registerWebviewViewProvider(BuilderViewProvider.viewType, builderProvider),
  );

  const getRecord = async (arg: unknown): Promise<WorkspaceRecord | undefined> => {
    if (typeof arg === 'string') return store.get(arg);
    if (arg && typeof arg === 'object') {
      const a = arg as any;
      // TreeNode (workspace 类型)
      if (a.kind === 'workspace' && a.record) return store.get(a.record.id);
      if (typeof a.id === 'string') return store.get(a.id);
    }
    // 命令面板调用：弹选择
    const records = store.list();
    if (records.length === 0) {
      vscode.window.showInformationMessage('还没有任何工作区记录');
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      records.map(r => ({ label: r.name, description: r.description, detail: r.filePath, id: r.id })),
      { placeHolder: '选择工作区' },
    );
    return pick ? store.get(pick.id) : undefined;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('workspaceManager.refresh', () => listProvider.refresh()),

    vscode.commands.registerCommand('workspaceManager.saveCurrent', async () => {
      await saveCurrentWorkspace(store);
    }),

    vscode.commands.registerCommand('workspaceManager.openItem', async (arg: unknown) => {
      const record = await getRecord(arg);
      if (!record) return;
      const gitInfo = await listProvider.ensureGitInfo(record);
      await openWorkspaceRecord(record, undefined, gitInfo, store);
    }),

    vscode.commands.registerCommand('workspaceManager.openItemNewWindow', async (arg: unknown) => {
      const record = await getRecord(arg);
      if (!record) return;
      await openWorkspaceRecord(record, 'newWindow');
    }),

    vscode.commands.registerCommand('workspaceManager.renameItem', async (arg: unknown) => {
      const record = await getRecord(arg);
      if (!record) return;
      const name = await vscode.window.showInputBox({
        prompt: '新的工作区名称',
        value: record.name,
      });
      if (!name) return;
      await store.update(record.id, { name: name.trim() });
      const updated = store.get(record.id);
      if (updated) await store.writeWorkspaceFile(updated);
    }),

    vscode.commands.registerCommand('workspaceManager.editDescription', async (arg: unknown) => {
      const record = await getRecord(arg);
      if (!record) return;
      const desc = await vscode.window.showInputBox({
        prompt: '工作区描述',
        value: record.description,
      });
      if (desc === undefined) return;
      await store.update(record.id, { description: desc });
      const updated = store.get(record.id);
      if (updated) await store.writeWorkspaceFile(updated);
    }),

    vscode.commands.registerCommand('workspaceManager.regenerateDescription', async (arg: unknown) => {
      const record = await getRecord(arg);
      if (!record) return;
      const desc = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'AI 生成工作区描述…' },
        () => generateDescription({ name: record.name, folders: record.folders }),
      );
      await store.update(record.id, { description: desc });
      const updated = store.get(record.id);
      if (updated) await store.writeWorkspaceFile(updated);
      vscode.window.showInformationMessage(`已更新描述：${desc}`);
    }),

    vscode.commands.registerCommand('workspaceManager.deleteItem', async (arg: unknown) => {
      const record = await getRecord(arg);
      if (!record) return;
      const choice = await vscode.window.showWarningMessage(
        `将「${record.name}」移到回收站？`,
        { modal: true },
        '移入回收站',
      );
      if (!choice) return;
      await store.softDelete(record.id);
    }),

    vscode.commands.registerCommand('workspaceManager.restoreItem', async (arg: unknown) => {
      const id = typeof arg === 'string' ? arg : (arg as any)?.id;
      if (!id) return;
      await store.restore(id);
    }),

    vscode.commands.registerCommand('workspaceManager.deleteForever', async (arg: unknown) => {
      const id = typeof arg === 'string' ? arg : (arg as any)?.id;
      if (!id) return;
      const record = store.getDeleted(id);
      if (!record) return;
      const choice = await vscode.window.showWarningMessage(
        `彻底删除「${record.name}」？`,
        { modal: true, detail: '这个操作不可恢复。可选择是否同时删除本地 .code-workspace 文件。' },
        '仅删除记录',
        '同时删除文件',
      );
      if (!choice) return;
      await store.hardDelete(id, choice === '同时删除文件');
    }),

    vscode.commands.registerCommand('workspaceManager.emptyRecycleBin', async () => {
      const items = store.listDeleted();
      if (items.length === 0) {
        vscode.window.showInformationMessage('回收站已空');
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `清空回收站（${items.length} 项）？`,
        { modal: true, detail: '记录全部移除，本地 .code-workspace 文件保留。' },
        '清空',
      );
      if (!choice) return;
      for (const r of items) {
        await store.hardDelete(r.id, false);
      }
    }),

    vscode.commands.registerCommand('workspaceManager.revealInFinder', async (arg: unknown) => {
      const record = await getRecord(arg);
      if (!record) return;
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(record.filePath));
    }),
  );
}

async function openWorkspaceRecord(
  record: WorkspaceRecord,
  force?: 'current' | 'newWindow',
  gitInfo?: Awaited<ReturnType<typeof getFoldersGitInfo>>,
  store?: WorkspaceStore,
) {
  try {
    await fs.access(record.filePath);
  } catch {
    vscode.window.showErrorMessage(`工作区文件不存在：${record.filePath}`);
    return;
  }

  let mode: 'current' | 'newWindow' | undefined = force;
  if (!mode) {
    const config = vscode.workspace.getConfiguration('workspaceManager');
    const behavior = config.get<string>('openBehavior', 'ask');
    if (behavior === 'current') mode = 'current';
    else if (behavior === 'newWindow') mode = 'newWindow';
  }
  if (!mode) {
    const info = gitInfo ?? (await getFoldersGitInfo(record.folders));
    // 获取最新 record（如果在 dialog 里被编辑过）
    const latest = store?.get(record.id) ?? record;
    mode = await showOpenWorkspaceDialog(latest, info, store);
    if (!mode) return;
  }
  const uri = vscode.Uri.file(record.filePath);
  await vscode.commands.executeCommand('vscode.openFolder', uri, mode === 'newWindow');
}

export function deactivate() {}

async function saveCurrentWorkspace(store: WorkspaceStore) {
  const wsFile = vscode.workspace.workspaceFile;
  const folders = vscode.workspace.workspaceFolders;

  if (!folders || folders.length === 0) {
    vscode.window.showInformationMessage('当前没有打开任何文件夹或工作区');
    return;
  }

  // 情况 1：当前已经是 .code-workspace 文件
  if (wsFile && wsFile.scheme === 'file' && wsFile.fsPath.endsWith('.code-workspace')) {
    const existing = store.list().find(r => r.filePath === wsFile.fsPath);
    if (existing) {
      vscode.window.showInformationMessage(`「${existing.name}」已在工作区记录中`);
      return;
    }
    let meta: { name?: string; description?: string } = {};
    try {
      const raw = await fs.readFile(wsFile.fsPath, 'utf8');
      const parsed = JSON.parse(raw);
      meta = parsed['workspaceManager.meta'] ?? {};
    } catch {
      /* ignore */
    }
    const defaultName = meta.name || path.basename(wsFile.fsPath, '.code-workspace');
    const name = await vscode.window.showInputBox({
      prompt: '为当前工作区起个名字',
      value: defaultName,
    });
    if (!name) return;
    const description = meta.description ?? '';
    const folderPaths = folders.map(f => f.uri.fsPath);
    const record: WorkspaceRecord = {
      id: cryptoRandomId(),
      name: name.trim(),
      description,
      filePath: wsFile.fsPath,
      folders: folderPaths,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await store.add(record);
    await store.writeWorkspaceFile(record);
    vscode.window.showInformationMessage(`已保存工作区「${record.name}」`);
    return;
  }

  // 情况 2：当前是普通文件夹（单根或临时多根，无 .code-workspace 文件），生成新文件
  const folderPaths = folders.map(f => f.uri.fsPath);
  const defaultName = folders.length === 1
    ? folders[0].name
    : folders.map(f => f.name).join(' + ');
  const name = await vscode.window.showInputBox({
    prompt: '为当前工作区起个名字',
    value: defaultName,
  });
  if (!name) return;

  const record = await store.createWorkspace({
    name: name.trim(),
    description: '',
    folders: folderPaths,
  });
  const choice = await vscode.window.showInformationMessage(
    `已保存工作区「${record.name}」`,
    '在新窗口打开',
  );
  if (choice === '在新窗口打开') {
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(record.filePath), true);
  }
}

function cryptoRandomId(): string {
  // 复用 store 中的 randomUUID 风格
  return require('crypto').randomUUID();
}
