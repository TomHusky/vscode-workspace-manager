import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { WorkspaceStore, WorkspaceRecord } from './store';
import { WorkspaceListProvider } from './treeView';
import { BuilderViewProvider } from './builderView';
import { generateDescription, getFoldersGitInfo } from './ai';
import { showOpenWorkspaceDialog } from './openDialog';

export function activate(context: vscode.ExtensionContext) {
  const store = new WorkspaceStore(context);
  const listProvider = new WorkspaceListProvider(store);
  const builderProvider = new BuilderViewProvider(context, store);

  const treeView = vscode.window.createTreeView('workspaceManager.list', {
    treeDataProvider: listProvider,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    treeView,
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
        `删除工作区记录「${record.name}」？`,
        { modal: true },
        '仅删除记录',
        '同时删除文件',
      );
      if (!choice) return;
      await store.remove(record.id, choice === '同时删除文件');
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
