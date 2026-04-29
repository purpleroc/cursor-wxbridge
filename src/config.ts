/**
 * 桥接配置（bridge.config.json + 默认值）
 * 已从 @anthropic-ai/claude-agent-sdk 迁移到 Cursor CLI（agent 命令）
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATES_ROOT = path.join(__dirname, '..');
export const CONFIG_PATH = path.join(TEMPLATES_ROOT, 'bridge.config.json');
export const EXAMPLE_CONFIG_PATH = path.join(TEMPLATES_ROOT, 'bridge.config.example.json');

export interface BridgeConfig {
  /** agent 的工作目录（建议与 Cursor 打开的项目根目录一致） */
  cwd: string;
  /** Cursor CLI 可执行文件路径，默认 "agent" */
  agentPath: string;
  /** 模型名称，留空则用 Cursor 默认 */
  model: string;
  /** 是否启用 --force（自动批准所有工具执行，不需要确认） */
  force: boolean;
  /** agent 单次调用最长运行时间（毫秒），超时自动终止 */
  agentTimeoutMs: number;

  maxMessageLength: number;
  enableSession: boolean;
  sessionTimeoutMs: number;

  sendThinkingHint: boolean;
  thinkingHintText: string;
  showToolCalls: boolean;
  verbose: boolean;
  /** 是否在最终回答末尾附加 token 消耗统计（input/output/cache） */
  showTokenUsage: boolean;

  /** 匹配到这些正则的 shell 命令会暂停并通过微信询问用户确认 */
  dangerousCommandPatterns: string[];
  /** 危险命令确认超时（毫秒），超时自动跳过（非关键操作）或终止（关键操作） */
  dangerousCommandTimeoutMs: number;
  /**
   * 匹配到这些正则的命令属于"不可跳过"的关键操作。
   * 拒绝时终止整个 agent（而非仅跳过）。
   * 不在此列表中的 dangerousCommandPatterns 匹配项拒绝时只跳过当前操作，agent 继续运行。
   */
  criticalCommandPatterns: string[];

  allowedUserIds: string[];
  replyAllowedUserIds: string[];
  replyDeniedMessage: string;
}

export const defaultConfig: BridgeConfig = {
  cwd: '',
  agentPath: 'agent',
  model: '',
  force: true,
  agentTimeoutMs: 30 * 60 * 1000,

  maxMessageLength: 4000,
  enableSession: true,
  sessionTimeoutMs: 30 * 60 * 1000,

  sendThinkingHint: true,
  thinkingHintText: '✅ 已收到，正在处理...',
  showToolCalls: false,
  verbose: false,
  showTokenUsage: true,

  dangerousCommandPatterns: ['\\brm\\b', '\\brmdir\\b', '\\bsudo\\b'],
  dangerousCommandTimeoutMs: 120_000,
  criticalCommandPatterns: ['\\brm\\s+-r[f ].*/', '\\bsudo\\s+rm\\b', '\\bmkfs\\b', '\\bdd\\s+if='],

  allowedUserIds: [],
  replyAllowedUserIds: [],
  replyDeniedMessage: '⚠️ 您没有查看回复的权限。请联系管理员将您的 ID 加入白名单。',
};

/**
 * 当 agentPath 不是绝对路径时，通过 `which` 解析其完整路径。
 * 解决 npm scripts / spawn 子进程中 PATH 查找失败（ENOENT）的问题。
 */
function resolveAgentPath(raw: string): string {
  if (path.isAbsolute(raw)) return raw;
  try {
    const resolved = execSync(`which ${raw}`, { encoding: 'utf-8', timeout: 5000 }).trim();
    if (resolved) return resolved;
  } catch {
    // `which` failed — keep original and let spawn surface the error later
  }
  return raw;
}

/**
 * 解析 cwd：空值 / 相对路径 → 基于 TEMPLATES_ROOT 展开为绝对路径；
 * 目录不存在时回退到 TEMPLATES_ROOT 并打印警告。
 */
function resolveCwd(raw: string): string {
  if (!raw) return TEMPLATES_ROOT;
  const abs = path.isAbsolute(raw) ? raw : path.resolve(TEMPLATES_ROOT, raw);
  if (fs.existsSync(abs)) return abs;
  console.warn(`[config] cwd "${abs}" 不存在，回退到项目目录: ${TEMPLATES_ROOT}`);
  return TEMPLATES_ROOT;
}

export function loadBridgeConfig(): BridgeConfig {
  let partial: Partial<BridgeConfig> = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      partial = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as Partial<BridgeConfig>;
    } catch (e) {
      console.error('[config] 解析 bridge.config.json 失败，使用默认配置:', e);
    }
  } else if (fs.existsSync(EXAMPLE_CONFIG_PATH)) {
    console.warn('[config] 未找到 bridge.config.json，从 bridge.config.example.json 读取（建议复制并改名为 bridge.config.json）');
    try {
      partial = JSON.parse(fs.readFileSync(EXAMPLE_CONFIG_PATH, 'utf-8')) as Partial<BridgeConfig>;
    } catch {
      // ignore
    }
  }
  const cfg = { ...defaultConfig, ...partial };
  cfg.agentPath = resolveAgentPath(cfg.agentPath);
  cfg.cwd = resolveCwd(cfg.cwd);
  return cfg;
}
