import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export interface CopilotChatTopic {
  title: string;
  /** 用户在该会话中提问的前几句摘要 */
  prompts: string[];
  /** 创建时间（毫秒） */
  createdAt?: number;
}

/**
 * 找到 VS Code 用户数据目录中的 workspaceStorage 路径。
 */
function getWorkspaceStorageDir(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Code', 'User', 'workspaceStorage');
  }
  return path.join(home, '.config', 'Code', 'User', 'workspaceStorage');
}

function toFileUri(p: string): string {
  // 转成 file:// URI（与 workspace.json 中的字段格式对齐）
  const normalized = p.replace(/\\/g, '/');
  return 'file://' + (normalized.startsWith('/') ? normalized : '/' + normalized);
}

/**
 * 在 workspaceStorage 中查找与给定 .code-workspace 文件或文件夹列表匹配的存储目录。
 */
async function findMatchingStorageDirs(workspaceFilePath: string, folders: string[]): Promise<string[]> {
  const root = getWorkspaceStorageDir();
  let entries: string[] = [];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }

  const targetWsUri = toFileUri(workspaceFilePath).toLowerCase();
  const folderUris = new Set(folders.map(f => toFileUri(f).toLowerCase()));

  const matches: string[] = [];
  await Promise.all(
    entries.map(async name => {
      const dir = path.join(root, name);
      try {
        const raw = await fs.readFile(path.join(dir, 'workspace.json'), 'utf8');
        const data = JSON.parse(raw);
        const config = (data.configuration || '').toString().toLowerCase();
        const folder = (data.folder || '').toString().toLowerCase();
        if (config === targetWsUri) {
          matches.push(dir);
          return;
        }
        if (folder && folderUris.has(folder)) {
          matches.push(dir);
        }
      } catch {
        // ignore
      }
    }),
  );
  return matches;
}

/**
 * 读取一个 chatSessions 文件，提取标题和用户提问摘要。
 */
async function readChatSession(file: string): Promise<CopilotChatTopic | undefined> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const firstLine = raw.split('\n').find(l => l.trim().length > 0);
    if (!firstLine) return undefined;
    const obj = JSON.parse(firstLine);
    const v = obj.v ?? obj;
    const title: string = v.customTitle || v.title || '';
    const requests: any[] = Array.isArray(v.requests) ? v.requests : [];
    const prompts = requests
      .map(r => (r?.message?.text || '').toString().trim())
      .filter(Boolean)
      .slice(0, 3)
      .map(t => t.replace(/\s+/g, ' ').slice(0, 200));
    if (!title && prompts.length === 0) return undefined;
    return {
      title: title || prompts[0]?.slice(0, 30) || '未命名会话',
      prompts,
      createdAt: typeof v.creationDate === 'number' ? v.creationDate : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * 收集与给定工作区相关的 Copilot Chat 主题。
 */
export async function getCopilotChatTopics(
  workspaceFilePath: string,
  folders: string[],
  options: { maxSessions?: number } = {},
): Promise<CopilotChatTopic[]> {
  const dirs = await findMatchingStorageDirs(workspaceFilePath, folders);
  const topics: CopilotChatTopic[] = [];
  for (const dir of dirs) {
    const sessionsDir = path.join(dir, 'chatSessions');
    let files: string[] = [];
    try {
      files = (await fs.readdir(sessionsDir)).filter(f => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const t = await readChatSession(path.join(sessionsDir, f));
      if (t) topics.push(t);
    }
  }
  // 按时间倒序，截断
  topics.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return topics.slice(0, options.maxSessions ?? 20);
}
