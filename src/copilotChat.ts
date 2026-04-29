import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { pathToFileURL } from 'url';

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
export function getWorkspaceStorageDir(): string {
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
  return pathToFileURL(p).toString();
}

function normalizeUriForCompare(uri: string): string {
  try {
    return decodeURI(uri).toLowerCase();
  } catch {
    return uri.toLowerCase();
  }
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

  const targetWsUri = workspaceFilePath ? normalizeUriForCompare(toFileUri(workspaceFilePath)) : '';
  const folderUris = new Set(folders.map(f => normalizeUriForCompare(toFileUri(f))));

  const matches: string[] = [];
  await Promise.all(
    entries.map(async name => {
      const dir = path.join(root, name);
      try {
        const raw = await fs.readFile(path.join(dir, 'workspace.json'), 'utf8');
        const data = JSON.parse(raw);
        const workspace = normalizeUriForCompare((data.workspace || data.configuration || '').toString());
        const folder = normalizeUriForCompare((data.folder || '').toString());
        if (targetWsUri && workspace === targetWsUri) {
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

/**
 * 计算 VS Code 给某个 workspace 配置文件分配的 storage 目录名（md5 of file:// URI）。
 */
export function computeWorkspaceStorageId(workspaceFilePath: string): string {
  const uri = toFileUri(workspaceFilePath);
  return crypto.createHash('md5').update(uri).digest('hex');
}

export function getWorkspaceStorageDirFromExtensionStorage(extensionStoragePath: string | undefined): string | undefined {
  if (!extensionStoragePath) return undefined;
  const root = getWorkspaceStorageDir();
  let current = extensionStoragePath;
  while (current && current !== path.dirname(current)) {
    if (path.dirname(current) === root) return current;
    current = path.dirname(current);
  }
  return undefined;
}

/**
 * 把当前 workspace 的 chatSessions 迁移（复制）到目标 .code-workspace 对应的存储目录。
 * 用于「保存当前工作区」后，新生成的 .code-workspace 第一次打开时仍能看到原会话。
 *
 * @returns 实际复制的会话文件数量
 */
export async function migrateChatSessionsToWorkspaceFile(
  sourceFolders: string[],
  sourceWorkspaceFilePath: string | undefined,
  targetWorkspaceFilePath: string,
  sourceWorkspaceStorageDir?: string,
): Promise<number> {
  // 找当前 workspace 对应的存储目录（按 .code-workspace 或文件夹匹配）
  const srcDirs = [
    sourceWorkspaceStorageDir,
    ...(await findMatchingStorageDirs(sourceWorkspaceFilePath || '', sourceFolders)),
  ].filter((dir, index, all): dir is string => Boolean(dir) && all.indexOf(dir) === index);
  if (srcDirs.length === 0) return 0;

  const root = getWorkspaceStorageDir();
  const targetId = computeWorkspaceStorageId(targetWorkspaceFilePath);
  const targetDir = path.join(root, targetId);
  const targetSessionsDir = path.join(targetDir, 'chatSessions');

  await fs.mkdir(targetSessionsDir, { recursive: true });

  // 写入 workspace.json，让 VS Code 把这个目录认作目标 workspace 的存储
  const wsJson = path.join(targetDir, 'workspace.json');
  try {
    await fs.access(wsJson);
  } catch {
    await fs.writeFile(
      wsJson,
      JSON.stringify({ workspace: toFileUri(targetWorkspaceFilePath) }, null, 2),
      'utf8',
    );
  }

  let copied = 0;
  for (const srcDir of srcDirs) {
    const sessionsDir = path.join(srcDir, 'chatSessions');
    let files: string[] = [];
    try {
      files = (await fs.readdir(sessionsDir)).filter(f => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const dest = path.join(targetSessionsDir, f);
      try {
        await fs.access(dest);
        // 已存在，跳过
      } catch {
        try {
          await fs.copyFile(path.join(sessionsDir, f), dest);
          copied++;
        } catch {
          /* ignore */
        }
      }
    }

    // 一并复制 chatEditingSessions（如果有），避免编辑会话状态丢失
    const editingSrc = path.join(srcDir, 'chatEditingSessions');
    try {
      const editingFiles = await fs.readdir(editingSrc);
      const editingDest = path.join(targetDir, 'chatEditingSessions');
      await fs.mkdir(editingDest, { recursive: true });
      for (const f of editingFiles) {
        const dst = path.join(editingDest, f);
        try {
          await fs.access(dst);
        } catch {
          try { await fs.copyFile(path.join(editingSrc, f), dst); } catch { /* ignore */ }
        }
      }
    } catch {
      /* ignore */
    }
  }
  return copied;
}

export async function backupChatSessionsFromWorkspaceStorage(
  sourceWorkspaceStorageDir: string | undefined,
  backupDir: string,
): Promise<number> {
  if (!sourceWorkspaceStorageDir) return 0;
  await fs.mkdir(backupDir, { recursive: true });
  return copyChatStorage(sourceWorkspaceStorageDir, backupDir);
}

export async function backupRelatedChatSessions(
  backupDir: string,
  sourceFolders: string[],
  sourceWorkspaceFilePath?: string,
  currentWorkspaceStorageDir?: string,
): Promise<number> {
  const sourceDirs = [
    currentWorkspaceStorageDir,
    ...(await findMatchingStorageDirs(sourceWorkspaceFilePath || '', sourceFolders)),
  ].filter((dir, index, all): dir is string => Boolean(dir) && all.indexOf(dir) === index);

  if (sourceDirs.length === 0) return 0;
  await fs.mkdir(backupDir, { recursive: true });

  let copied = 0;
  for (const sourceDir of sourceDirs) {
    copied += await copyChatStorage(sourceDir, backupDir);
  }
  return copied;
}

export async function restoreChatSessionsBackup(
  backupDir: string | undefined,
  targetWorkspaceStorageDir: string | undefined,
): Promise<number> {
  if (!backupDir || !targetWorkspaceStorageDir) return 0;
  try {
    await fs.access(backupDir);
  } catch {
    return 0;
  }
  await fs.mkdir(targetWorkspaceStorageDir, { recursive: true });
  return copyChatStorage(backupDir, targetWorkspaceStorageDir);
}

async function copyChatStorage(fromDir: string, toDir: string): Promise<number> {
  let copied = 0;
  copied += await copyDirFiles(path.join(fromDir, 'chatSessions'), path.join(toDir, 'chatSessions'), '.jsonl');
  await copyDirFiles(path.join(fromDir, 'chatEditingSessions'), path.join(toDir, 'chatEditingSessions'));
  return copied;
}

async function copyDirFiles(fromDir: string, toDir: string, requiredSuffix?: string): Promise<number> {
  let files: string[] = [];
  try {
    files = await fs.readdir(fromDir);
  } catch {
    return 0;
  }
  await fs.mkdir(toDir, { recursive: true });
  let copied = 0;
  for (const file of files) {
    if (requiredSuffix && !file.endsWith(requiredSuffix)) continue;
    const from = path.join(fromDir, file);
    const to = path.join(toDir, file);
    try {
      const stat = await fs.stat(from);
      if (!stat.isFile()) continue;
      await fs.access(to);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') continue;
      try {
        await fs.copyFile(from, to);
        copied++;
      } catch {
        /* ignore */
      }
    }
  }
  return copied;
}
