import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { CopilotChatTopic } from './copilotChat';

const execAsync = promisify(exec);

export interface DescriptionInput {
  name: string;
  folders: string[];
}

export interface FolderGitInfo {
  branch: string;
  dirty: boolean;
}

/**
 * 获取多个文件夹的 git 分支信息。
 */
export async function getFoldersGitInfo(folders: string[]): Promise<Map<string, FolderGitInfo>> {
  const map = new Map<string, FolderGitInfo>();
  await Promise.all(
    folders.map(async f => {
      const info = await detectGit(f);
      if (info) map.set(f, info);
    }),
  );
  return map;
}

/**
 * 生成与 tooltip 一致的多行详情文本：每个路径右侧跟 @分支，末尾附描述。
 */
export function formatRecordDetail(opts: {
  folders: string[];
  description?: string;
  gitInfo?: Map<string, FolderGitInfo>;
}): string {
  const lines = opts.folders.map(f => {
    const info = opts.gitInfo?.get(f);
    const tag = info ? `  @${info.branch}${info.dirty ? '*' : ''}` : '';
    return `📁 ${path.basename(f)}${tag}`;
  });
  if (opts.description) {
    lines.push('');
    // 清除可能存在的 markdown 粗体等符号，避免在原生弹窗里显示乱码
    const cleanDesc = opts.description.replace(/(\*\*|__)(.*?)\1/g, '$2');
    lines.push(cleanDesc);
  }
  return lines.join('\n');
}

/**
 * 基于文件夹内容生成一个简短的工作区名称（2-8 字）。
 */
export async function generateName(folders: string[]): Promise<string> {
  const summary = await summarizeFolders(folders);
  const fallbackName = () => {
    if (summary.length === 0) return '新工作区';
    if (summary.length === 1) return summary[0].name;
    return `${summary[0].name} 等${summary.length}项`;
  };
  try {
    const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (!model) return fallbackName();
    const list = summary
      .map(s => `- ${s.name}（${s.signals.join('/') || '未知'}${s.gitBranch ? ` @${s.gitBranch}` : ''}）`)
      .join('\n');
    const prompt = [
      '请根据下列 VS Code 工作区包含的文件夹，给出一个简洁的中文工作区名称。',
      '要求：2-12 个字符，能概括项目主题，可包含英文项目名；不要加引号、不要加后缀「工作区」、不要解释。',
      '',
      '包含文件夹:',
      list,
      '',
      '直接输出名称：',
    ].join('\n');
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(prompt)],
      {},
      new vscode.CancellationTokenSource().token,
    );
    let text = '';
    for await (const fragment of response.text) text += fragment;
    const name = text.trim().replace(/^["'`「『]+|["'`」』]+$/g, '').split(/\r?\n/)[0].trim();
    return name || fallbackName();
  } catch {
    return fallbackName();
  }
}

/**
 * 调用 VS Code Language Model API（Copilot）生成工作区描述。
 * 失败时回退为简单的目录摘要。
 */
export async function generateDescription(input: DescriptionInput): Promise<string> {
  const summary = await summarizeFolders(input.folders);
  try {
    const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (!model) {
      return fallback(input.name, summary);
    }
    const prompt = buildPrompt(input.name, summary);
    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
    let text = '';
    for await (const fragment of response.text) {
      text += fragment;
    }
    return text.trim() || fallback(input.name, summary);
  } catch (err) {
    return fallback(input.name, summary);
  }
}

function buildPrompt(name: string, summary: FolderSummary[]): string {
  const list = summary
    .map(s => {
      const lines = [`# ${s.name}`];
      if (s.gitBranch) {
        lines.push(`当前分支: ${s.gitBranch}${s.gitDirty ? '（有未提交改动）' : ''}`);
      } else {
        lines.push(`无 Git 仓库`);
      }
      if (s.recentCommits && s.recentCommits.length) {
        lines.push(`最近提交:`);
        s.recentCommits.forEach(c => lines.push(`  · ${c}`));
      }
      return lines.join('\n');
    })
    .join('\n\n');
  return [
    `请根据下面 VS Code 工作区各项目「当前分支」上的最近 commit 记录，输出一段中文 Markdown 描述。`,
    `格式要求：`,
    `- 每个项目一行，格式：\`- **项目名**：该分支正在做什么（一句话概括）\``,
    `- 不超过 4 个 bullet、整体不超过 5 行；`,
    `- 不要添加标题、不要技术栈说明、不要代码块；`,
    `- 重点是从 commit 消息中归纳「正在做的事」，不要逽词 commit hash；`,
    `- 若某项目无 git，可写 \`- **项目名**：（未纳入 git）\` 。`,
    ``,
    `工作区: ${name}`,
    ``,
    list,
    ``,
    `直接输出 Markdown，不要任何前缀、后缀或解释。`,
  ].join('\n');
}

function fallback(name: string, summary: FolderSummary[]): string {
  const withCommits = summary.filter(s => s.recentCommits && s.recentCommits.length);
  if (withCommits.length === 0) {
    return `_暂无 git 提交记录_`;
  }
  return withCommits
    .map(s => `- **${s.name}**：分支 \`${s.gitBranch}\` 最近「${s.recentCommits!.slice(0, 2).join('、')}」`)
    .join('\n');
}

/**
 * 基于 Copilot Chat 历史话题 + 项目 git 信息生成更贴近"实际工作"的描述。
 */
export async function generateDescriptionFromCopilot(input: {
  name: string;
  folders: string[];
  topics: CopilotChatTopic[];
}): Promise<string> {
  const summary = await summarizeFolders(input.folders);
  const topics = input.topics.slice(0, 12);

  if (topics.length === 0) {
    // 没有任何 Copilot 会话，回退到普通描述
    return generateDescription({ name: input.name, folders: input.folders });
  }

  try {
    const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (!model) return fallbackFromTopics(topics);

    const projectList = summary
      .map(s => `- ${s.name}${s.gitBranch ? ` @${s.gitBranch}` : ''}`)
      .join('\n');
    const topicList = topics
      .map((t, i) => {
        const promptPart = t.prompts.length ? `\n  关键提问：${t.prompts.map(p => `「${p}」`).join(' ')}` : '';
        return `${i + 1}. ${t.title}${promptPart}`;
      })
      .join('\n');

    const prompt = [
      `请根据用户在 VS Code 工作区中与 GitHub Copilot 的近期会话主题，归纳出一段中文 Markdown 描述，用于在工作区列表中说明"这个工作区在做什么"。`,
      ``,
      `工作区: ${input.name}`,
      ``,
      `包含项目:`,
      projectList,
      ``,
      `Copilot 会话主题（按时间倒序）:`,
      topicList,
      ``,
      `格式要求：`,
      `- 输出 2-4 行 Markdown bullet，格式：\`- **方向/项目**：正在做的事（一句话）\``,
      `- 概括用户的真实工作主题，不要逐条复述会话标题；`,
      `- 不要标题、不要技术栈说明、不要代码块、不要解释；`,
      `- 直接输出 Markdown。`,
    ].join('\n');

    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(prompt)],
      {},
      new vscode.CancellationTokenSource().token,
    );
    let text = '';
    for await (const fragment of response.text) text += fragment;
    return text.trim() || fallbackFromTopics(topics);
  } catch {
    return fallbackFromTopics(topics);
  }
}

function fallbackFromTopics(topics: CopilotChatTopic[]): string {
  return topics
    .slice(0, 4)
    .map(t => `- **${t.title}**`)
    .join('\n');
}

interface FolderSummary {
  name: string;
  path: string;
  topEntries: string[];
  signals: string[];
  gitBranch?: string;
  gitDirty?: boolean;
  recentCommits?: string[];
}

async function summarizeFolders(folders: string[]): Promise<FolderSummary[]> {
  const results: FolderSummary[] = [];
  for (const folder of folders) {
    try {
      const entries = await fs.readdir(folder, { withFileTypes: true });
      const visible = entries.filter(e => !e.name.startsWith('.')).slice(0, 30);
      const topEntries = visible.slice(0, 12).map(e => (e.isDirectory() ? `${e.name}/` : e.name));
      const signals = detectSignals(entries.map(e => e.name));
      const git = await detectGit(folder);
      const recentCommits = git ? await getRecentCommits(folder) : [];
      results.push({
        name: path.basename(folder),
        path: folder,
        topEntries,
        signals,
        gitBranch: git?.branch,
        gitDirty: git?.dirty,
        recentCommits,
      });
    } catch {
      results.push({ name: path.basename(folder), path: folder, topEntries: [], signals: [] });
    }
  }
  return results;
}

async function detectGit(folder: string): Promise<{ branch: string; dirty: boolean } | undefined> {
  try {
    await fs.access(path.join(folder, '.git'));
  } catch {
    return undefined;
  }
  try {
    const { stdout: branchOut } = await execAsync('git rev-parse --abbrev-ref HEAD', {
      cwd: folder,
      timeout: 2000,
    });
    const branch = branchOut.trim();
    let dirty = false;
    try {
      const { stdout: statusOut } = await execAsync('git status --porcelain', {
        cwd: folder,
        timeout: 2000,
      });
      dirty = statusOut.trim().length > 0;
    } catch {
      /* ignore */
    }
    return { branch: branch || 'HEAD', dirty };
  } catch {
    return undefined;
  }
}

async function getRecentCommits(folder: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync('git log -n 15 --pretty=format:%s', {
      cwd: folder,
      timeout: 3000,
      maxBuffer: 1024 * 64,
    });
    return stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function detectSignals(names: string[]): string[] {
  const map: Record<string, string> = {
    'package.json': 'Node.js',
    'tsconfig.json': 'TypeScript',
    'pom.xml': 'Java/Maven',
    'build.gradle': 'Gradle',
    'build.gradle.kts': 'Gradle',
    'requirements.txt': 'Python',
    'pyproject.toml': 'Python',
    'Cargo.toml': 'Rust',
    'go.mod': 'Go',
    'Gemfile': 'Ruby',
    'composer.json': 'PHP',
    'Dockerfile': 'Docker',
    'docker-compose.yml': 'Docker Compose',
    'next.config.js': 'Next.js',
    'vite.config.ts': 'Vite',
    'angular.json': 'Angular',
    'flutter.yaml': 'Flutter',
    'pubspec.yaml': 'Flutter/Dart',
    'AndroidManifest.xml': 'Android',
  };
  const found = new Set<string>();
  for (const n of names) {
    if (map[n]) found.add(map[n]);
  }
  return Array.from(found);
}
