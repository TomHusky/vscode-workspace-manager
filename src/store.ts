import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';

export interface WorkspaceFolderEntry {
  path: string;
  name?: string;
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  description: string;
  filePath: string; // absolute path to .code-workspace
  folders: string[]; // absolute folder paths
  createdAt: number;
  updatedAt: number;
}

interface StoreShape {
  records: WorkspaceRecord[];
}

const STORE_KEY = 'workspaceManager.records.v1';

export class WorkspaceStore {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  getStorageDir(): string {
    const config = vscode.workspace.getConfiguration('workspaceManager');
    const custom = (config.get<string>('storageDir') || '').trim();
    if (custom) {
      return custom.replace(/^~(?=$|\/)/, os.homedir());
    }
    return path.join(os.homedir(), 'CopilotWorkspaces');
  }

  async ensureStorageDir(): Promise<string> {
    const dir = this.getStorageDir();
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  list(): WorkspaceRecord[] {
    const data = this.context.globalState.get<StoreShape>(STORE_KEY, { records: [] });
    return [...data.records].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): WorkspaceRecord | undefined {
    return this.list().find(r => r.id === id);
  }

  private async save(records: WorkspaceRecord[]) {
    await this.context.globalState.update(STORE_KEY, { records });
    this._onDidChange.fire();
  }

  async add(record: WorkspaceRecord) {
    const records = this.list();
    records.push(record);
    await this.save(records);
  }

  async update(id: string, patch: Partial<WorkspaceRecord>) {
    const records = this.list();
    const idx = records.findIndex(r => r.id === id);
    if (idx === -1) return;
    records[idx] = { ...records[idx], ...patch, updatedAt: Date.now() };
    await this.save(records);
  }

  async remove(id: string, deleteFile: boolean) {
    const records = this.list();
    const target = records.find(r => r.id === id);
    const next = records.filter(r => r.id !== id);
    await this.save(next);
    if (target && deleteFile) {
      try {
        await fs.unlink(target.filePath);
      } catch {
        /* ignore */
      }
    }
  }

  async createWorkspace(input: {
    name: string;
    description: string;
    folders: string[];
  }): Promise<WorkspaceRecord> {
    const dir = await this.ensureStorageDir();
    const safeName = sanitizeFileName(input.name) || 'workspace';
    let filePath = path.join(dir, `${safeName}.code-workspace`);
    let counter = 1;
    while (await fileExists(filePath)) {
      filePath = path.join(dir, `${safeName}-${counter}.code-workspace`);
      counter++;
    }

    const content = {
      folders: input.folders.map(p => ({ path: p })),
      settings: {},
      // 自定义元数据，便于外部读取
      'workspaceManager.meta': {
        name: input.name,
        description: input.description,
      },
    };
    await fs.writeFile(filePath, JSON.stringify(content, null, 2), 'utf8');

    const record: WorkspaceRecord = {
      id: crypto.randomUUID(),
      name: input.name,
      description: input.description,
      filePath,
      folders: input.folders,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.add(record);
    return record;
  }

  async writeWorkspaceFile(record: WorkspaceRecord) {
    const content = {
      folders: record.folders.map(p => ({ path: p })),
      settings: {},
      'workspaceManager.meta': {
        name: record.name,
        description: record.description,
      },
    };
    await fs.writeFile(record.filePath, JSON.stringify(content, null, 2), 'utf8');
  }
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim();
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
