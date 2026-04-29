/**
 * 微信 ilink 长轮询 + Cursor CLI agent（headless），微信收发消息。
 *
 * 策略：每轮 agent 最多发 3 条消息（thinkingHint + 思考过程 + 最终回答），
 * 避免触发 ilink 的 context_token 消息条数限制（约9条 ret=-2）。
 * showToolCalls 开启时，完成后发送格式化的思考过程摘要到微信端，
 * 方便检查意图识别和推理链路。
 *
 * 支持：
 *   - 追问融入：agent 忙时新消息默认进追问缓冲区，当前任务完成后
 *               通过 --resume 续接同一会话，合并处理所有追问
 *   - /排队    ：显式将消息作为独立任务排队（不融入当前对话）
 *   - /stop    ：终止当前 agent，继续处理队列下一条
 *   - /stopall ：终止当前 agent 并清空队列 + 追问
 *   - /clear   ：清空会话续接 + 清空队列 + 追问
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, execSync, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import * as readline from 'node:readline';

import { loadBridgeConfig, TEMPLATES_ROOT, CONFIG_PATH } from './config.js';
import { getUpdates, sendMessage, sendFile } from './ilink.js';
import type { Credentials, WeixinMessage } from './types.js';
import { materializeInboundMessage, type InboundPayload } from './inbound-media.js';
import { PermissionGate } from './permission-gate.js';

const CREDENTIALS_PATH = path.join(TEMPLATES_ROOT, 'credentials.json');
const STATE_PATH = path.join(TEMPLATES_ROOT, 'bridge-state.json');
const INBOUND_DIR = path.join(TEMPLATES_ROOT, '.media_cache', 'inbound');
const FOLLOWUP_DIR = path.join(TEMPLATES_ROOT, '.media_cache', 'followups');

const MAX_QUEUE_SIZE = 10;

/* ---------- state persistence ---------- */

interface BridgeState {
  get_updates_buf: string;
  sessions: Record<string, { sessionId: string; lastActivity: number }>;
}

function loadState(): BridgeState {
  if (!fs.existsSync(STATE_PATH)) {
    return { get_updates_buf: '', sessions: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')) as BridgeState;
  } catch {
    return { get_updates_buf: '', sessions: {} };
  }
}

function saveState(s: BridgeState) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2), 'utf-8');
}

function loadCredentials(): Credentials {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(`缺少 ${CREDENTIALS_PATH}，请先 npm run setup`);
  }
  return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8')) as Credentials;
}

/* ---------- helpers ---------- */

async function safeSend(
  cred: Credentials, userId: string, token: string, text: string,
): Promise<boolean> {
  try {
    const resp = await sendMessage(cred, userId, token, text) as { ret?: number; errmsg?: string };
    if (resp.ret !== undefined && resp.ret !== 0) {
      console.error(`[bridge] ⚠ sendMessage ret=${resp.ret} errmsg=${resp.errmsg ?? ''}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[bridge] ❌ sendMessage error:`, e);
    return false;
  }
}

async function safeSendLong(
  cred: Credentials, userId: string, token: string, text: string, maxLen: number,
): Promise<boolean> {
  const t = text || '';
  if (!t) return false;
  for (let i = 0; i < t.length; i += maxLen) {
    const ok = await safeSend(cred, userId, token, t.slice(i, i + maxLen));
    if (!ok) return false;
  }
  return true;
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

function formatTokenCount(n: number | undefined): string {
  const v = n ?? 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(2)}k`;
  return String(v);
}

function formatDuration(ms: number | undefined): string {
  if (!ms || ms < 0) return '-';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s - m * 60);
  return `${m}m${rs}s`;
}

function hasEvidenceMarkers(text: string): boolean {
  return /(https?:\/\/|参考链接[:：]|原帖|原始来源|权威媒体|官方来源|^##\s|^###\s)/m.test(text);
}

function looksLikeBriefSummary(text: string): boolean {
  return text.length < 1200 && /(总结核心发现|总结一下最终结论|最终结论|总结要点)/.test(text);
}

function scoreAssistantText(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;

  let score = Math.min(trimmed.length, 20000);
  if (hasEvidenceMarkers(trimmed)) score += 5000;
  if (/https?:\/\//.test(trimmed)) score += 3000;
  if (looksLikeBriefSummary(trimmed)) score -= 1500;
  return score;
}

function chooseAssistantReply(
  lastAssistantText: string,
  bestAssistantText: string,
  resultText: string,
): string {
  const last = lastAssistantText.trim();
  const best = bestAssistantText.trim();
  const result = resultText.trim();

  if (best) {
    const lastNeedsUpgrade = !last
      || (hasEvidenceMarkers(best) && !hasEvidenceMarkers(last))
      || (looksLikeBriefSummary(last) && best.length > last.length * 1.5)
      || scoreAssistantText(best) >= scoreAssistantText(last) + 2500;
    if (lastNeedsUpgrade) return best;
  }

  return last || best || result;
}

/* ---------- Cursor API 价格表（$/1M tokens，数据来源：cursor.com/docs/models） ---------- */

interface ModelPricing {
  label: string;
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
  /** Cursor 个人计划下该模型必须走 Max Mode，会在 API 费率上再加 20% */
  maxModeRequired?: boolean;
}

/** 按正则匹配模型 slug，顺序从特殊到通用 */
const PRICING_TABLE: { match: RegExp; price: ModelPricing }[] = [
  { match: /opus[-_\s]?4\.7/i,    price: { label: 'Claude 4.7 Opus',    input: 5,    cacheWrite: 6.25, cacheRead: 0.5,   output: 25,   maxModeRequired: true } },
  { match: /opus[-_\s]?4\.6.*fast/i, price: { label: 'Claude 4.6 Opus (Fast)', input: 30, cacheWrite: 37.5, cacheRead: 3, output: 150, maxModeRequired: true } },
  { match: /opus[-_\s]?4\.6/i,    price: { label: 'Claude 4.6 Opus',    input: 5,    cacheWrite: 6.25, cacheRead: 0.5,   output: 25,   maxModeRequired: true } },
  { match: /opus[-_\s]?4\.5/i,    price: { label: 'Claude 4.5 Opus',    input: 5,    cacheWrite: 6.25, cacheRead: 0.5,   output: 25,   maxModeRequired: true } },
  { match: /sonnet[-_\s]?4\.6/i,  price: { label: 'Claude 4.6 Sonnet',  input: 3,    cacheWrite: 3.75, cacheRead: 0.3,   output: 15,   maxModeRequired: true } },
  { match: /sonnet[-_\s]?4\.5/i,  price: { label: 'Claude 4.5 Sonnet',  input: 3,    cacheWrite: 3.75, cacheRead: 0.3,   output: 15,   maxModeRequired: true } },
  { match: /sonnet[-_\s]?4.*1m/i, price: { label: 'Claude 4 Sonnet 1M', input: 6,    cacheWrite: 7.5,  cacheRead: 0.6,   output: 22.5 } },
  { match: /sonnet[-_\s]?4/i,     price: { label: 'Claude 4 Sonnet',    input: 3,    cacheWrite: 3.75, cacheRead: 0.3,   output: 15 } },
  { match: /haiku[-_\s]?4\.5/i,   price: { label: 'Claude 4.5 Haiku',   input: 1,    cacheWrite: 1.25, cacheRead: 0.1,   output: 5 } },
  { match: /gpt[-_\s]?5\.4.*mini/i,  price: { label: 'GPT-5.4 Mini',    input: 0.75,                   cacheRead: 0.075, output: 4.5 } },
  { match: /gpt[-_\s]?5\.4.*nano/i,  price: { label: 'GPT-5.4 Nano',    input: 0.2,                    cacheRead: 0.02,  output: 1.25 } },
  { match: /gpt[-_\s]?5\.4/i,        price: { label: 'GPT-5.4',         input: 2.5,                    cacheRead: 0.25,  output: 15,   maxModeRequired: true } },
  { match: /gpt[-_\s]?5\.3.*codex/i, price: { label: 'GPT-5.3 Codex',   input: 1.75,                   cacheRead: 0.175, output: 14,   maxModeRequired: true } },
  { match: /gpt[-_\s]?5\.2.*codex/i, price: { label: 'GPT-5.2 Codex',   input: 1.75,                   cacheRead: 0.175, output: 14 } },
  { match: /gpt[-_\s]?5\.2/i,        price: { label: 'GPT-5.2',         input: 1.75,                   cacheRead: 0.175, output: 14 } },
  { match: /gpt[-_\s]?5\.1.*codex.*mini/i, price: { label: 'GPT-5.1 Codex Mini', input: 0.25,          cacheRead: 0.025, output: 2 } },
  { match: /gpt[-_\s]?5\.1.*codex.*max/i,  price: { label: 'GPT-5.1 Codex Max',  input: 1.25,          cacheRead: 0.125, output: 10 } },
  { match: /gpt[-_\s]?5\.1.*codex/i, price: { label: 'GPT-5.1 Codex',   input: 1.25,                   cacheRead: 0.125, output: 10 } },
  { match: /gpt[-_\s]?5.*codex/i,    price: { label: 'GPT-5 Codex',     input: 1.25,                   cacheRead: 0.125, output: 10 } },
  { match: /gpt[-_\s]?5.*mini/i,     price: { label: 'GPT-5 Mini',      input: 0.25,                   cacheRead: 0.025, output: 2 } },
  { match: /gpt[-_\s]?5.*fast/i,     price: { label: 'GPT-5 Fast',      input: 2.5,                    cacheRead: 0.25,  output: 20 } },
  { match: /gpt[-_\s]?5/i,           price: { label: 'GPT-5',           input: 1.25,                   cacheRead: 0.125, output: 10 } },
  { match: /gemini[-_\s]?3\.1.*pro/i,price: { label: 'Gemini 3.1 Pro',  input: 2,                      cacheRead: 0.2,   output: 12 } },
  { match: /gemini[-_\s]?3.*pro/i,   price: { label: 'Gemini 3 Pro',    input: 2,                      cacheRead: 0.2,   output: 12 } },
  { match: /gemini[-_\s]?3.*flash/i, price: { label: 'Gemini 3 Flash',  input: 0.5,                    cacheRead: 0.05,  output: 3 } },
  { match: /gemini[-_\s]?2\.5.*flash/i, price: { label: 'Gemini 2.5 Flash', input: 0.3,                cacheRead: 0.03,  output: 2.5 } },
  { match: /grok/i,                  price: { label: 'Grok 4.20',       input: 2,                      cacheRead: 0.2,   output: 6 } },
  { match: /kimi/i,                  price: { label: 'Kimi K2.5',       input: 0.6,                    cacheRead: 0.1,   output: 3 } },
  { match: /composer[-_\s]?2/i,      price: { label: 'Composer 2',      input: 0.5,                    cacheRead: 0.2,   output: 2.5 } },
  { match: /composer[-_\s]?1\.5/i,   price: { label: 'Composer 1.5',    input: 3.5,                    cacheRead: 0.35,  output: 17.5 } },
  { match: /composer[-_\s]?1/i,      price: { label: 'Composer 1',      input: 1.25,                   cacheRead: 0.125, output: 10 } },
  { match: /^auto$|^auto[-_]/i,      price: { label: 'Auto',            input: 1.25, cacheWrite: 1.25, cacheRead: 0.25,  output: 6 } },
];

function lookupPricing(model: string | undefined): ModelPricing | null {
  if (!model) return null;
  const hit = PRICING_TABLE.find(p => p.match.test(model));
  return hit ? hit.price : null;
}

function formatUSD(v: number): string {
  if (!isFinite(v) || v <= 0) return '$0';
  if (v >= 1)    return `$${v.toFixed(3)}`;
  if (v >= 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(6)}`;
}

/**
 * 按 Cursor 官方 API 费率计算本次请求的美金成本。
 * - 缓存价：未提供 cacheRead/cacheWrite 时按 input 价兜底
 * - Max Mode upcharge：Cursor 个人计划在模型 API 费率上额外 +20%；仅对 `maxModeRequired` 的模型展示
 */
function calcCost(usage: AgentUsage, pricing: ModelPricing): { base: number; withMax: number } {
  const inTok = usage.inputTokens ?? 0;
  const outTok = usage.outputTokens ?? 0;
  const crTok = usage.cacheReadTokens ?? 0;
  const cwTok = usage.cacheWriteTokens ?? 0;
  const cacheReadRate = pricing.cacheRead ?? pricing.input;
  const cacheWriteRate = pricing.cacheWrite ?? pricing.input;
  const base = (
    inTok * pricing.input +
    outTok * pricing.output +
    crTok * cacheReadRate +
    cwTok * cacheWriteRate
  ) / 1_000_000;
  const withMax = pricing.maxModeRequired ? base * 1.2 : base;
  return { base, withMax };
}

function buildUsageFooter(
  usage: AgentUsage | undefined,
  durationMs: number | undefined,
  model?: string,
): string {
  if (!usage) return '';
  const inp = formatTokenCount(usage.inputTokens);
  const out = formatTokenCount(usage.outputTokens);
  const cr = formatTokenCount(usage.cacheReadTokens);
  const cw = formatTokenCount(usage.cacheWriteTokens);
  const dur = formatDuration(durationMs);
  let footer = `\n\n— 📊 tokens: in ${inp} · out ${out} · cache r ${cr} / w ${cw} · ⏱ ${dur}`;

  const pricing = lookupPricing(model);
  if (pricing) {
    const { base, withMax } = calcCost(usage, pricing);
    if (pricing.maxModeRequired) {
      footer += `\n— 💰 ${pricing.label}: ${formatUSD(base)}（Max Mode +20% → ${formatUSD(withMax)}）`;
    } else {
      footer += `\n— 💰 ${pricing.label}: ${formatUSD(base)}`;
    }
  }
  return footer;
}

/* ---------- Cursor model catalog ---------- */

const execFileP = promisify(execFile);

interface CursorModelInfo {
  slug: string;
  display: string;
  isDefault: boolean;
}

interface ModelCache {
  fetchedAt: number;
  items: CursorModelInfo[];
}

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
let modelCache: ModelCache | null = null;

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function parseModelsOutput(raw: string): CursorModelInfo[] {
  const clean = stripAnsi(raw);
  const lines = clean.split('\n').map(l => l.trim()).filter(Boolean);
  const items: CursorModelInfo[] = [];
  for (const line of lines) {
    if (/^(Loading models|Available models)/i.test(line)) continue;
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*-\s*(.*)$/);
    if (!m) continue;
    let display = m[2].trim();
    let isDefault = false;
    const defM = display.match(/\s*\(default\)\s*$/i);
    if (defM) {
      isDefault = true;
      display = display.replace(/\s*\(default\)\s*$/i, '').trim();
    }
    items.push({ slug: m[1], display, isDefault });
  }
  return items;
}

async function fetchCursorModels(agentPath: string, forceRefresh = false): Promise<CursorModelInfo[]> {
  if (!forceRefresh && modelCache && Date.now() - modelCache.fetchedAt < MODEL_CACHE_TTL_MS) {
    return modelCache.items;
  }
  try {
    const { stdout } = await execFileP(agentPath, ['--list-models'], {
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const items = parseModelsOutput(stdout);
    if (items.length > 0) {
      modelCache = { fetchedAt: Date.now(), items };
    }
    return items;
  } catch (e) {
    console.error('[bridge] fetchCursorModels failed:', e);
    return modelCache?.items ?? [];
  }
}

function groupModels(items: CursorModelInfo[]): Array<{ family: string; items: CursorModelInfo[] }> {
  const buckets = new Map<string, CursorModelInfo[]>();
  const order: string[] = [];
  for (const it of items) {
    let family: string;
    if (it.slug === 'auto') family = 'auto';
    else if (it.slug.startsWith('claude-')) family = 'Claude';
    else if (it.slug.startsWith('gpt-')) family = 'GPT / Codex';
    else if (it.slug.startsWith('composer-')) family = 'Composer';
    else if (it.slug.startsWith('gemini-')) family = 'Gemini';
    else family = 'Other';
    if (!buckets.has(family)) { buckets.set(family, []); order.push(family); }
    buckets.get(family)!.push(it);
  }
  const priority = ['auto', 'Claude', 'GPT / Codex', 'Composer', 'Gemini', 'Other'];
  return order
    .sort((a, b) => {
      const ia = priority.indexOf(a), ib = priority.indexOf(b);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    })
    .map(f => ({ family: f, items: buckets.get(f)! }));
}

function formatModelsList(items: CursorModelInfo[], current: string): string {
  if (!items.length) return '(未获取到模型列表)';
  const lines: string[] = [];
  for (const group of groupModels(items)) {
    lines.push(`【${group.family}】`);
    for (const m of group.items) {
      const marks: string[] = [];
      if (m.slug === current) marks.push('✅当前');
      if (m.isDefault) marks.push('默认');
      const tag = marks.length ? `  [${marks.join(' / ')}]` : '';
      lines.push(`  ${m.slug} — ${m.display}${tag}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function findSimilarModels(items: CursorModelInfo[], query: string, limit = 8): CursorModelInfo[] {
  const q = query.toLowerCase();
  const scored = items.map(it => {
    const slug = it.slug.toLowerCase();
    const disp = it.display.toLowerCase();
    let score = 0;
    if (slug === q) score = 100;
    else if (slug.startsWith(q)) score = 80;
    else if (slug.includes(q)) score = 60;
    else if (disp.includes(q)) score = 40;
    return { it, score };
  }).filter(x => x.score > 0);
  scored.sort((a, b) => b.score - a.score || a.it.slug.length - b.it.slug.length);
  return scored.slice(0, limit).map(x => x.it);
}

/**
 * 将新的 model 值持久化到 bridge.config.json，保留其他字段不变。
 * 若文件不存在则新建。
 */
function persistConfigField(field: string, value: unknown): void {
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
    } catch (e) {
      console.error('[bridge] parse bridge.config.json before persist failed:', e);
      raw = {};
    }
  }
  raw[field] = value;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
}

/**
 * 递归终止指定进程的所有子进程（不杀父进程本身）。
 * 用于"跳过当前工具调用"：杀掉正在执行的 shell 子进程，
 * 然后 SIGCONT 恢复 agent 主进程，使其收到工具失败并继续后续工作。
 */
function killChildProcesses(parentPid: number): number {
  try {
    const output = execSync(`pgrep -P ${parentPid}`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const pids = output.trim().split('\n').filter(Boolean).map(Number);
    let killed = 0;
    for (const cpid of pids) {
      killed += killChildProcesses(cpid);
      try {
        process.kill(cpid, 'SIGKILL');
        killed++;
      } catch {}
    }
    return killed;
  } catch {
    return 0;
  }
}

/* ---------- per-user context with queue ---------- */

interface PendingMsg {
  prompt: string;
  contextToken: string;
}

interface UserContext {
  proc: ChildProcess | null;
  contextToken: string;
  queue: PendingMsg[];
  followUpBuffer: PendingMsg[];
  killed: boolean;
}

/* ---------- Cursor CLI agent types (stream-json NDJSON) ---------- */

interface AgentInitMsg {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model?: string;
  cwd?: string;
  [k: string]: unknown;
}

interface AgentAssistantMsg {
  type: 'assistant';
  message?: {
    role: 'assistant';
    content: Array<{ type?: string; text?: string }>;
  };
  session_id?: string;
  [k: string]: unknown;
}

interface AgentToolCallMsg {
  type: 'tool_call';
  subtype: 'started' | 'completed';
  call_id?: string;
  tool_call?: Record<string, { args?: Record<string, unknown>; result?: unknown }>;
  session_id?: string;
  [k: string]: unknown;
}

interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

interface AgentResultMsg {
  type: 'result';
  subtype: 'success' | string;
  result?: string;
  session_id?: string;
  is_error?: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  usage?: AgentUsage;
  [k: string]: unknown;
}

interface AgentThinkingMsg {
  type: 'thinking';
  subtype: 'delta' | 'completed';
  text?: string;
  session_id?: string;
  [k: string]: unknown;
}

type AgentMsg = AgentInitMsg | AgentAssistantMsg | AgentThinkingMsg | AgentToolCallMsg | AgentResultMsg | { type: string; [k: string]: unknown };

/* ---------- thinking process for WeChat ---------- */

interface ThinkingEntry {
  kind: 'think' | 'say' | 'tool';
  text: string;
}

function summarizeToolCall(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'shell': {
      let cmd = ((args.command as string) || '').trim();
      cmd = cmd.replace(/-p'[^']*'/g, "-p'***'")
               .replace(/-p"[^"]*"/g, '-p"***"')
               .replace(/--password[= ]\S+/gi, '--password=***');
      return cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd;
    }
    case 'read': {
      const p = (args.path as string) || '';
      const name = p.split('/').pop() || p;
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      if (offset !== undefined || limit !== undefined)
        return `${name}:${offset ?? 1}-${(offset ?? 1) + (limit ?? 0)}`;
      return name;
    }
    case 'grep': {
      const pat = (args.pattern as string) || '';
      const grepPath = (args.path as string) || '';
      const pathShort = grepPath.split('/').pop() || grepPath;
      return pat.length > 40
        ? `/${pat.slice(0, 37)}.../ in ${pathShort}`
        : `/${pat}/ in ${pathShort}`;
    }
    case 'semanticSearch':
      return ((args.query as string) || '').slice(0, 80);
    case 'write':
    case 'strReplace':
    case 'delete':
      return ((args.path as string) || '').split('/').pop() || '';
    default:
      return JSON.stringify(args).slice(0, 60);
  }
}

function formatThinkingProcess(log: ThinkingEntry[], toolCount: number, maxLen: number): string {
  const lines: string[] = ['🔍 思考过程', ''];
  let stepNum = 0;

  for (const entry of log) {
    switch (entry.kind) {
      case 'think':
        lines.push(`💭 ${entry.text.replace(/\n/g, ' ').slice(0, 200)}`);
        break;
      case 'say':
        stepNum++;
        if (stepNum > 1) lines.push('');
        lines.push(`${stepNum}. 💬 ${entry.text.replace(/\n/g, ' ').slice(0, 200)}`);
        break;
      case 'tool':
        lines.push(`   🔧 ${entry.text}`);
        break;
    }
  }

  lines.push('', `📊 共 ${toolCount} 次工具调用`);

  let result = lines.join('\n');
  if (result.length > maxLen) {
    const head = result.slice(0, Math.floor(maxLen * 0.6));
    const tail = result.slice(-Math.floor(maxLen * 0.3));
    result = head + '\n\n… 省略部分中间步骤 …\n\n' + tail;
  }

  return result;
}

/* ---------- prompt builder ---------- */

const FOLLOWUP_FILENAME = '.bridge-followup.md';

const BRIDGE_CAPABILITY_HINT = [
  '[系统提示：你正通过微信桥接与用户对话。',
  '当用户要求发送文件/图片/音频/视频时，在回复中使用 [SEND_FILE:/绝对路径] 标记，桥接会自动上传发送到用户微信。',
  '路径必须是服务器上已存在的绝对路径，单文件不超过25MB。',
  '示例：这是生成的音频 [SEND_FILE:/tmp/output/chapter_01.mp3]',
  '',
  '重要：用户可能在你执行任务期间通过微信发来追问或补充信息。',
  `这些追问会实时写入工作区根目录的 ${FOLLOWUP_FILENAME} 文件。`,
  '在你做出重要决策（如选择安装源、确定技术方案、开始长时间操作）之前，',
  `请先用 Read 工具检查 ${FOLLOWUP_FILENAME} 是否存在且有内容，以获取用户最新的指示。]`,
].join(' ');

function buildPromptText(inbound: InboundPayload): string {
  const lines: string[] = [];
  if (inbound.text) lines.push(inbound.text);

  for (const im of inbound.imageParts) {
    if (im.savedPath) {
      lines.push(`\n[用户发送了图片，已保存到: ${im.savedPath}，请用 Read 工具查看]`);
    }
  }

  if (inbound.savedPaths.length) {
    lines.push('', '[用户附件已保存到本地]', ...inbound.savedPaths.map(p => `- ${p}`));
  }

  lines.push('', BRIDGE_CAPABILITY_HINT);

  return lines.join('\n').trim() || '(空消息)';
}

function buildFollowUpPrompt(followUps: PendingMsg[]): string {
  const lines: string[] = [
    '[用户在你执行上一个任务期间发来了以下追问/补充信息，请结合之前的工作成果一并处理：]',
    '',
  ];
  for (let i = 0; i < followUps.length; i++) {
    lines.push(`--- 追问 ${i + 1} ---`);
    lines.push(followUps[i].prompt.replace(BRIDGE_CAPABILITY_HINT, '').trim());
    lines.push('');
  }
  lines.push(BRIDGE_CAPABILITY_HINT);
  return lines.join('\n').trim();
}

function writeFollowUpFile(userId: string, followUps: PendingMsg[], workspaceCwd?: string) {
  const content = buildFollowUpFileContent(followUps);

  try {
    if (!fs.existsSync(FOLLOWUP_DIR)) fs.mkdirSync(FOLLOWUP_DIR, { recursive: true });
    const fp = path.join(FOLLOWUP_DIR, `${userId.slice(0, 16)}.md`);
    fs.writeFileSync(fp, content, 'utf-8');
    console.log(`[bridge] 📝 追问缓存已更新: ${fp} (${followUps.length} 条)`);
  } catch (e) {
    console.error('[bridge] 写追问缓存失败:', e);
  }

  if (workspaceCwd) {
    try {
      const wsFp = path.join(workspaceCwd, FOLLOWUP_FILENAME);
      fs.writeFileSync(wsFp, content, 'utf-8');
      console.log(`[bridge] 📝 workspace 追问文件已更新: ${wsFp}`);
    } catch (e) {
      console.error('[bridge] 写 workspace 追问文件失败:', e);
    }
  }
}

function buildFollowUpFileContent(followUps: PendingMsg[]): string {
  const lines = [
    '# 用户追问（实时更新）',
    '',
    '> 以下是用户在当前任务执行期间发来的追问/补充信息，请在做出重要决策前参考。',
    '',
  ];
  for (let i = 0; i < followUps.length; i++) {
    const clean = followUps[i].prompt.replace(BRIDGE_CAPABILITY_HINT, '').trim();
    lines.push(`## 追问 ${i + 1}`, '', clean, '');
  }
  return lines.join('\n');
}

function clearFollowUpFile(userId: string, workspaceCwd?: string) {
  try {
    const fp = path.join(FOLLOWUP_DIR, `${userId.slice(0, 16)}.md`);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch {}

  if (workspaceCwd) {
    try {
      const wsFp = path.join(workspaceCwd, FOLLOWUP_FILENAME);
      if (fs.existsSync(wsFp)) fs.unlinkSync(wsFp);
    } catch {}
  }
}

/* ---------- main ---------- */

async function main() {
  const cfg = loadBridgeConfig();
  const credentials = loadCredentials();
  const state = loadState();
  const userContexts = new Map<string, UserContext>();

  function getOrCreateCtx(userId: string, contextToken: string): UserContext {
    let ctx = userContexts.get(userId);
    if (!ctx) {
      ctx = { proc: null, contextToken, queue: [], followUpBuffer: [], killed: false };
      userContexts.set(userId, ctx);
    }
    ctx.contextToken = contextToken;
    return ctx;
  }

  const gate = new PermissionGate(cfg.dangerousCommandTimeoutMs);
  const dangerousREs = cfg.dangerousCommandPatterns
    .map(p => { try { return new RegExp(p); } catch { return null; } })
    .filter((r): r is RegExp => r !== null);
  const criticalREs = cfg.criticalCommandPatterns
    .map(p => { try { return new RegExp(p); } catch { return null; } })
    .filter((r): r is RegExp => r !== null);

  console.log(`[bridge] 已启动 — cwd=${cfg.cwd} model=${cfg.model || '(default)'} force=${cfg.force}`);
  if (dangerousREs.length) {
    console.log(`[bridge] 🛡 危险命令拦截已启用: ${cfg.dangerousCommandPatterns.join(', ')}`);
  }
  if (criticalREs.length) {
    console.log(`[bridge] 🚨 关键命令（不可跳过）: ${cfg.criticalCommandPatterns.join(', ')}`);
  }

  /* ---------- spawn Cursor CLI and stream results ---------- */

  async function runAgentCli(
    prompt: string,
    userId: string,
    contextToken: string,
    resumeSessionId?: string,
  ): Promise<string | undefined> {
    const ctx = getOrCreateCtx(userId, contextToken);

    const args = ['-p', '--output-format', 'stream-json', '--workspace', cfg.cwd, '--trust'];
    if (cfg.force) args.push('--force');
    if (cfg.model?.trim()) args.push('--model', cfg.model.trim());
    if (resumeSessionId) args.push('--resume', resumeSessionId);
    args.push(prompt);

    console.log(`[agent] ▶ 启动 (user=${userId.slice(0, 12)}…) prompt=${prompt.slice(0, 80)}…`);

    const proc = spawn(cfg.agentPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: cfg.cwd,
      detached: true,
    });

    ctx.proc = proc;
    ctx.killed = false;

    let resultSessionId: string | undefined;
    let stderr = '';
    let timedOut = false;
    let lastAssistantText = '';
    let bestAssistantText = '';
    let toolCount = 0;
    let agentModel: string | undefined = cfg.model?.trim() || undefined;
    const thinkingLog: ThinkingEntry[] = [];

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(async () => {
      timedOut = true;
      ctx.killed = true;
      const elapsed = Math.round(cfg.agentTimeoutMs / 60000);
      console.warn(`[bridge] agent 超时 (${elapsed}min)，终止进程`);

      if (cfg.showToolCalls && thinkingLog.length > 0) {
        const processText = formatThinkingProcess(thinkingLog, toolCount, cfg.maxMessageLength);
        await safeSend(credentials, userId, contextToken, processText);
      }
      const partial = chooseAssistantReply(lastAssistantText, bestAssistantText, '');
      const notice = partial
        ? `⏰ Agent 运行超过 ${elapsed} 分钟，已自动终止。以下是已完成的部分结果：\n\n${partial}`
        : `⏰ Agent 运行超过 ${elapsed} 分钟，已自动终止。暂无可返回的结果。\n发 /stop 终止后可重新发起更小的任务。`;
      await safeSendLong(credentials, userId, contextToken, notice, cfg.maxMessageLength);

      proc.kill('SIGTERM');
      setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 5000);
    }, cfg.agentTimeoutMs);

    try {
      const rl = readline.createInterface({ input: proc.stdout! });

      for await (const line of rl) {
        if (!line.trim()) continue;
        let msg: AgentMsg;
        try {
          msg = JSON.parse(line) as AgentMsg;
        } catch {
          continue;
        }

        if (msg.type === 'system' && (msg as AgentInitMsg).subtype === 'init') {
          const init = msg as AgentInitMsg;
          resultSessionId = init.session_id;
          if (init.model) agentModel = init.model;
          console.log(`[agent] ✓ init model=${init.model ?? '?'} session=${init.session_id.slice(0, 8)}…`);
          continue;
        }

        if (msg.type === 'thinking') {
          const tk = msg as AgentThinkingMsg;
          if (tk.subtype === 'completed' && tk.text?.trim()) {
            console.log(`[agent] 🧠 ${tk.text.trim().replace(/\n/g, ' ↵ ').slice(0, 120)}`);
            if (cfg.showToolCalls) thinkingLog.push({ kind: 'think', text: tk.text.trim() });
          }
        }

        if (msg.type === 'assistant') {
          const asst = msg as AgentAssistantMsg;
          const blocks = asst.message?.content;
          if (Array.isArray(blocks)) {
            for (const b of blocks) {
              if (b?.type === 'text') {
                const trimmed = (b.text ?? '').replace(/^\n+/, '').trim();
                if (trimmed) {
                  lastAssistantText = trimmed;
                  if (scoreAssistantText(trimmed) >= scoreAssistantText(bestAssistantText)) {
                    bestAssistantText = trimmed;
                  }
                  console.log(`[agent] 💬 ${trimmed.replace(/\n/g, ' ↵ ').slice(0, 120)}`);
                  if (cfg.showToolCalls) thinkingLog.push({ kind: 'say', text: trimmed });
                }
              }
            }
          }
        }

        if (msg.type === 'tool_call') {
          const tc = msg as AgentToolCallMsg;
          const toolEntries = Object.entries(tc.tool_call ?? {});
          for (const [toolKey, toolData] of toolEntries) {
            const toolName = toolKey.replace(/ToolCall$/, '').replace(/Tool$/, '');

            if (tc.subtype === 'started') {
              toolCount++;
              const argsStr = JSON.stringify(toolData.args ?? {}).slice(0, 120);
              console.log(`[agent] 🛠 ${toolName}: ${argsStr}`);
              if (cfg.showToolCalls && toolName !== 'glob') {
                thinkingLog.push({ kind: 'tool', text: `${toolName}(${summarizeToolCall(toolName, (toolData.args ?? {}) as Record<string, unknown>)})` });
              }

              const cmd = (toolData.args as { command?: string })?.command ?? '';
              const filePath = (toolData.args as { path?: string })?.path ?? '';
              const isDangerousShell = toolKey === 'shellToolCall' && dangerousREs.some(re => re.test(cmd));
              const isDangerousDelete = toolKey === 'deleteToolCall';

              if ((isDangerousShell || isDangerousDelete) && proc.pid) {
                const dangerDesc = isDangerousDelete ? `删除文件: ${filePath}` : cmd;
                const isCritical = isDangerousDelete || criticalREs.some(re => re.test(dangerDesc));

                console.log(`[bridge] 🛡 ${isCritical ? '关键' : ''}危险操作拦截: ${dangerDesc.slice(0, 200)}`);
                try { process.kill(-proc.pid, 'SIGSTOP'); } catch {}

                const timeoutSec = Math.round(cfg.dangerousCommandTimeoutMs / 1000);
                const promptLines = [
                  isCritical ? '🚨 **关键操作需要确认（不可跳过）**' : '🛡 **操作需要确认**',
                  '',
                  `\`${dangerDesc.slice(0, 1500)}\``,
                  '',
                  '回复 **1** / **允许** — 继续执行',
                  isCritical
                    ? '回复 **2** / **拒绝** — 终止 agent（此操作不可跳过）'
                    : '回复 **2** / **拒绝** — 跳过此操作，agent 继续',
                  '回复 **3** / **始终允许** — 允许并记住',
                  '',
                  isCritical
                    ? '或回复其他文本（将终止 agent 并记录你的指示）'
                    : '或直接回复其他文本作为指示（将跳过此操作，你的文字会作为追问传给 agent）',
                  '',
                  `（${timeoutSec} 秒内无回复将自动${isCritical ? '终止' : '跳过'}）`,
                ];
                await sendMessage(credentials, userId, contextToken, promptLines.join('\n'));

                const ac = new AbortController();
                const onProcExit = () => ac.abort();
                proc.once('exit', onProcExit);
                try {
                  const result = await gate.wait(userId, undefined, ac.signal);
                  proc.removeListener('exit', onProcExit);

                  if (result.behavior === 'allow') {
                    console.log('[bridge] ✅ 用户允许');
                    await sendMessage(credentials, userId, contextToken, '✅ 已允许，继续执行。');
                    try { process.kill(-proc.pid!, 'SIGCONT'); } catch {}
                  } else if (isCritical) {
                    console.log(`[bridge] ❌ 关键操作被拒绝，终止 agent${result.userText ? ` (用户指示: ${result.userText})` : ''}`);
                    await sendMessage(credentials, userId, contextToken,
                      `❌ 已拒绝关键操作，终止当前 agent。${result.userText ? `\n📝 你的指示已记录: "${result.userText}"` : ''}`);
                    if (result.userText) {
                      ctx.followUpBuffer.push({ prompt: `[用户在拒绝操作 \`${dangerDesc.slice(0, 200)}\` 时附加的指示] ${result.userText}`, contextToken });
                      writeFollowUpFile(userId, ctx.followUpBuffer, cfg.cwd);
                    }
                    ctx.killed = true;
                    try { process.kill(-proc.pid!, 'SIGKILL'); } catch {}
                  } else {
                    console.log(`[bridge] ⏭ 非关键操作被拒绝，跳过并继续${result.userText ? ` (用户指示: ${result.userText})` : ''}`);
                    killChildProcesses(proc.pid!);
                    try { process.kill(-proc.pid!, 'SIGCONT'); } catch {}

                    const skipMsg = result.userText
                      ? `⏭ 已跳过此操作，agent 继续运行。\n📝 你的指示已传达: "${result.userText}"`
                      : '⏭ 已跳过此操作，agent 继续运行。';
                    await sendMessage(credentials, userId, contextToken, skipMsg);

                    if (result.userText) {
                      ctx.followUpBuffer.push({ prompt: `[用户在跳过操作 \`${dangerDesc.slice(0, 200)}\` 时的指示] ${result.userText}`, contextToken });
                      writeFollowUpFile(userId, ctx.followUpBuffer, cfg.cwd);
                    }
                  }
                } catch {
                  proc.removeListener('exit', onProcExit);
                }
              }
            } else if (tc.subtype === 'completed') {
              console.log(`[agent] ✓ ${toolName} 完成`);
            }
          }
        }

        if (msg.type === 'result') {
          const res = msg as AgentResultMsg;
          resultSessionId = res.session_id ?? resultSessionId;

          if (res.subtype === 'success') {
            const usage = res.usage;
            const usageLog = usage
              ? ` in=${usage.inputTokens ?? 0} out=${usage.outputTokens ?? 0} cacheR=${usage.cacheReadTokens ?? 0} cacheW=${usage.cacheWriteTokens ?? 0}`
              : '';
            console.log(`[agent] ✅ 完成 (${res.duration_ms ?? '?'}ms) tools=${toolCount}${usageLog}`);

            if (cfg.showToolCalls && thinkingLog.length > 0) {
              const processText = formatThinkingProcess(thinkingLog, toolCount, cfg.maxMessageLength);
              console.log(`[bridge] 📨 发送思考过程 (${processText.length} 字符)…`);
              await safeSend(credentials, userId, contextToken, processText);
            }

            let finalText = chooseAssistantReply(
              lastAssistantText,
              bestAssistantText,
              (res.result ?? '').trim(),
            );
            if (finalText) {
              const cleaned = await extractAndSendFiles(finalText, userId, contextToken);
              const footer = cfg.showTokenUsage ? buildUsageFooter(usage, res.duration_ms, agentModel) : '';
              const toSend = cleaned.trim() ? cleaned + footer : footer.trim();
              if (toSend) {
                console.log(`[bridge] 📨 发送最终回答 (${toSend.length} 字符)…`);
                const ok = await safeSendLong(credentials, userId, contextToken, toSend, cfg.maxMessageLength);
                console.log(`[bridge] ${ok ? '✅ 最终回答发送成功' : '⚠ 最终回答发送失败'}`);
              }
            } else if (cfg.showTokenUsage && usage) {
              const footer = buildUsageFooter(usage, res.duration_ms, agentModel).trim();
              if (footer) {
                await safeSend(credentials, userId, contextToken, footer);
              }
            }
          } else {
            const errText = res.result || res.subtype || 'unknown error';
            console.log(`[agent] ❌ ${res.subtype}: ${errText.slice(0, 200)}`);
            if (cfg.showToolCalls && thinkingLog.length > 0) {
              const processText = formatThinkingProcess(thinkingLog, toolCount, cfg.maxMessageLength);
              await safeSend(credentials, userId, contextToken, processText);
            }
            await safeSend(credentials, userId, contextToken,
              `❌ ${errText}`.slice(0, cfg.maxMessageLength));
          }
        }
      }

      await new Promise<void>((resolve) => {
        proc.on('close', () => resolve());
        if (proc.exitCode !== null) resolve();
      });

      if (proc.exitCode !== null && proc.exitCode !== 0 && !timedOut && !ctx.killed) {
        console.error(`[agent] ⚠ 退出码=${proc.exitCode} stderr=${stderr.slice(0, 500)}`);
        await safeSend(credentials, userId, contextToken,
          `❌ Agent 异常退出 (code=${proc.exitCode}): ${stderr.slice(0, 400)}`);
      }
    } finally {
      clearTimeout(timeout);
      ctx.proc = null;
      if (!proc.killed) {
        if (proc.pid) { try { process.kill(-proc.pid, 'SIGTERM'); } catch {} }
        else { proc.kill(); }
      }
    }

    return resultSessionId;
  }

  /* ---------- process one task ---------- */

  async function processTask(userId: string, prompt: string, contextToken: string) {
    const sessionRec = state.sessions[userId];
    const resume =
      cfg.enableSession &&
      sessionRec &&
      Date.now() - sessionRec.lastActivity < cfg.sessionTimeoutMs
        ? sessionRec.sessionId
        : undefined;

    const newSessionId = await runAgentCli(prompt, userId, contextToken, resume);

    if (newSessionId) {
      state.sessions[userId] = { sessionId: newSessionId, lastActivity: Date.now() };
      saveState(state);
    }
  }

  /* ---------- drain queue ---------- */

  async function drainQueue(userId: string, firstPrompt: string, firstToken: string) {
    const ctx = getOrCreateCtx(userId, firstToken);

    try {
      if (cfg.sendThinkingHint) {
        await safeSend(credentials, userId, firstToken, cfg.thinkingHintText);
      }
      await processTask(userId, firstPrompt, firstToken);
    } catch (e) {
      console.error('[bridge] processTask error:', e);
      await safeSend(credentials, userId, firstToken, `❌ 处理出错: ${String(e).slice(0, 500)}`);
    }

    /* --- process follow-up buffer: resume same session with accumulated context --- */
    await drainFollowUps(userId, ctx);

    /* --- then process independent queued tasks --- */
    while (ctx.queue.length > 0) {
      const next = ctx.queue.shift()!;
      console.log(`[bridge] 📋 处理队列消息 (user=${userId.slice(0, 12)}…, 剩余${ctx.queue.length}条)`);

      try {
        await safeSend(credentials, userId, next.contextToken,
          `📋 开始处理排队消息: "${next.prompt.slice(0, 50)}${next.prompt.length > 50 ? '…' : ''}"`);
        await processTask(userId, next.prompt, next.contextToken);
      } catch (e) {
        console.error('[bridge] queue processTask error:', e);
        await safeSend(credentials, userId, next.contextToken, `❌ 处理出错: ${String(e).slice(0, 500)}`);
      }

      await drainFollowUps(userId, ctx);
    }

    ctx.proc = null;
  }

  async function drainFollowUps(userId: string, ctx: UserContext) {
    if (ctx.followUpBuffer.length === 0) return;

    const followUps = ctx.followUpBuffer.splice(0);
    const lastToken = followUps[followUps.length - 1].contextToken;
    clearFollowUpFile(userId, cfg.cwd);

    const count = followUps.length;
    console.log(`[bridge] 💬 处理 ${count} 条追问 (user=${userId.slice(0, 12)}…, --resume 同一会话)`);

    const followUpPrompt = buildFollowUpPrompt(followUps);
    try {
      await safeSend(credentials, userId, lastToken,
        `💬 开始处理 ${count} 条追问，续接同一对话上下文…`);
      await processTask(userId, followUpPrompt, lastToken);
    } catch (e) {
      console.error('[bridge] follow-up processTask error:', e);
      await safeSend(credentials, userId, lastToken, `❌ 处理追问出错: ${String(e).slice(0, 500)}`);
    }

    if (ctx.followUpBuffer.length > 0) {
      await drainFollowUps(userId, ctx);
    }
  }

  /* ---------- kill current agent ---------- */

  function killAgent(ctx: UserContext): boolean {
    if (ctx.proc && !ctx.proc.killed) {
      ctx.killed = true;
      const pid = ctx.proc.pid;
      if (pid) { try { process.kill(-pid, 'SIGTERM'); } catch {} }
      else { ctx.proc.kill('SIGTERM'); }
      const ref = ctx.proc;
      setTimeout(() => { if (!ref.killed) { try { process.kill(-(pid ?? 0), 'SIGKILL'); } catch {} ref.kill('SIGKILL'); } }, 3000);
      console.log('[bridge] 🔴 终止当前 agent 进程');
      return true;
    }
    return false;
  }

  /* ---------- detect [SEND_FILE:path] in agent text ---------- */

  const SEND_FILE_RE = /\[SEND_FILE:([^\]]+)\]/g;

  async function extractAndSendFiles(text: string, userId: string, contextToken: string): Promise<string> {
    const matches = [...text.matchAll(SEND_FILE_RE)];
    if (!matches.length) return text;
    for (const m of matches) {
      const fp = m[1].trim();
      console.log(`[bridge] 📤 agent 请求发送文件: ${fp}`);
      await handleSendFile(userId, contextToken, fp);
    }
    return text.replace(SEND_FILE_RE, '').trim();
  }

  /* ---------- send file to WeChat ---------- */

  const MAX_FILE_SIZE = 25 * 1024 * 1024;

  async function handleSendFile(userId: string, contextToken: string, filePath: string) {
    if (!filePath) {
      await sendMessage(credentials, userId, contextToken, '用法：/send <文件路径>');
      return;
    }
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cfg.cwd, filePath);
    if (!fs.existsSync(resolved)) {
      await sendMessage(credentials, userId, contextToken, `❌ 文件不存在: ${resolved}`);
      return;
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      await sendMessage(credentials, userId, contextToken, `❌ 不是文件（可能是目录）: ${resolved}`);
      return;
    }
    if (stat.size > MAX_FILE_SIZE) {
      await sendMessage(credentials, userId, contextToken,
        `❌ 文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，微信限制约 25MB。`);
      return;
    }
    try {
      console.log(`[bridge] 📤 发送文件: ${resolved} (${(stat.size / 1024).toFixed(0)}KB)`);
      await sendFile(credentials, userId, contextToken, resolved);
      console.log(`[bridge] ✅ 文件发送成功: ${resolved}`);
    } catch (e) {
      console.error('[bridge] sendFile error:', e);
      await sendMessage(credentials, userId, contextToken,
        `❌ 文件发送失败: ${String(e).slice(0, 300)}`);
    }
  }

  /* ---------- per-message handler ---------- */

  async function handleOneMessage(msg: WeixinMessage) {
    if (msg.message_type !== 1) return;
    const userId = msg.from_user_id;
    const contextToken = msg.context_token;
    if (!userId || !contextToken) return;

    if (cfg.allowedUserIds.length && !cfg.allowedUserIds.includes(userId)) {
      return;
    }

    const inbound = await materializeInboundMessage(msg, credentials, INBOUND_DIR);
    const text = inbound.text.trim();

    console.log(`[bridge] 📩 收到消息 user=${userId.slice(0, 12)}… text="${text.slice(0, 60)}" images=${inbound.imageParts.length} files=${inbound.savedPaths.length}`);

    if (!text && !inbound.imageParts.length && !inbound.savedPaths.length) {
      return;
    }

    const ctx = getOrCreateCtx(userId, contextToken);
    const isBusy = ctx.proc !== null;

    if (gate.hasPending(userId)) {
      const notifyInvalid = async (hint: string) => { await sendMessage(credentials, userId, contextToken, hint); };
      if (gate.deliver(userId, text, notifyInvalid)) {
        return;
      }
    }

    /* --- commands --- */

    if (text === '/help') {
      await safeSend(credentials, userId, contextToken, [
        '命令：',
        '  /help          — 帮助',
        '  /cwd           — 查看当前工作目录',
        '  /cwd <路径>    — 切换工作目录（会重置会话）',
        '  /clear         — 清空会话 + 队列 + 追问',
        '  /stop          — 终止当前任务，继续队列',
        '  /stopall       — 终止当前任务 + 清空队列 + 追问',
        '  /send <路径>   — 发送服务器上的文件到微信',
        '  /model         — 查看当前模型及子命令',
        '  /model list    — 列出全部模型',
        '  /model <slug>  — 切换模型',
        '',
        '直接发文字或图片，由 Cursor Agent 处理。',
        '忙时发送的消息默认作为**追问**，会在当前任务完成后融入同一对话上下文中处理。',
        `用 /排队 前缀（如 "/排队 帮我做另一件事"）可将消息作为独立任务排队 (最多 ${MAX_QUEUE_SIZE} 条)。`,
        `当前模式：force=${cfg.force}，model=${cfg.model || '(default)'}`,
        isBusy
          ? `状态：处理中，追问 ${ctx.followUpBuffer.length} 条，队列 ${ctx.queue.length} 条`
          : '状态：空闲',
      ].join('\n'));
      return;
    }

    if (text === '/model' || text.startsWith('/model ')) {
      const arg = text.slice(6).trim();

      if (!arg) {
        await safeSend(credentials, userId, contextToken, [
          `当前模型：${cfg.model || '(Cursor 默认)'}`,
          '',
          '子命令：',
          '  /model list              — 列出全部可用模型',
          '  /model search <关键词>   — 模糊搜索',
          '  /model <slug>            — 切换并写回 bridge.config.json',
          '  /model <slug> !          — 跳过校验强制切换',
          '  /model clear             — 恢复 Cursor 默认（清空 model 字段）',
          '  /model refresh           — 强制刷新缓存后再查',
        ].join('\n'));
        return;
      }

      if (arg === 'refresh') {
        modelCache = null;
        const items = await fetchCursorModels(cfg.agentPath, true);
        await safeSend(credentials, userId, contextToken,
          items.length
            ? `✅ 已刷新，共 ${items.length} 个模型。用 /model list 查看。`
            : '⚠️ 刷新失败：未拿到模型列表，请检查 agent CLI 登录状态。');
        return;
      }

      if (arg === 'list' || arg === 'ls') {
        const items = await fetchCursorModels(cfg.agentPath);
        if (!items.length) {
          await safeSend(credentials, userId, contextToken,
            '⚠️ 无法获取模型列表。可能原因：agent 未登录 / 网络问题 / agentPath 配置错误。');
          return;
        }
        const body = formatModelsList(items, cfg.model);
        const header = `Cursor CLI 可用模型（共 ${items.length} 个，当前：${cfg.model || '(默认)'}）\n\n`;
        await safeSendLong(credentials, userId, contextToken, header + body, cfg.maxMessageLength);
        return;
      }

      if (arg.startsWith('search ')) {
        const kw = arg.slice(7).trim();
        if (!kw) {
          await safeSend(credentials, userId, contextToken, '用法：/model search <关键词>');
          return;
        }
        const items = await fetchCursorModels(cfg.agentPath);
        const hits = findSimilarModels(items, kw, 20);
        if (!hits.length) {
          await safeSend(credentials, userId, contextToken, `未匹配到包含 "${kw}" 的模型。`);
          return;
        }
        const body = formatModelsList(hits, cfg.model);
        const header = `搜索 "${kw}"，共 ${hits.length} 个匹配：\n\n`;
        await safeSendLong(credentials, userId, contextToken, header + body, cfg.maxMessageLength);
        return;
      }

      if (arg === 'clear' || arg === 'default' || arg === 'reset') {
        cfg.model = '';
        try {
          persistConfigField('model', '');
        } catch (e) {
          await safeSend(credentials, userId, contextToken,
            `⚠️ 内存已切换到 Cursor 默认，但写回配置失败：${(e as Error).message}`);
          return;
        }
        await safeSend(credentials, userId, contextToken,
          '✅ 已恢复 Cursor 默认模型，并写回 bridge.config.json。下一轮对话生效。');
        return;
      }

      const forceMatch = arg.match(/^(\S+)\s+!\s*$/);
      const slug = forceMatch ? forceMatch[1] : arg;
      const force = !!forceMatch;

      if (/\s/.test(slug)) {
        await safeSend(credentials, userId, contextToken,
          '⚠️ 模型 slug 不应含空格。用法：/model <slug>');
        return;
      }

      const items = await fetchCursorModels(cfg.agentPath);
      const exact = items.find(m => m.slug === slug);

      if (!exact && !force) {
        const similar = findSimilarModels(items, slug, 6);
        const hint = similar.length
          ? '相近的候选：\n' + similar.map(m => `  ${m.slug} — ${m.display}`).join('\n')
          : '（未找到相近候选，用 /model list 查看全部）';
        await safeSend(credentials, userId, contextToken, [
          `⚠️ 模型 "${slug}" 不在当前账号可用列表中。`,
          hint,
          '',
          `如确信可用，可加尾缀 ! 强制切换：/model ${slug} !`,
        ].join('\n'));
        return;
      }

      const oldModel = cfg.model || '(默认)';
      cfg.model = slug;
      try {
        persistConfigField('model', slug);
      } catch (e) {
        await safeSend(credentials, userId, contextToken,
          `⚠️ 内存已切换到 ${slug}，但写回 bridge.config.json 失败：${(e as Error).message}`);
        return;
      }

      const parts: string[] = [
        `✅ 模型已切换：${oldModel} → ${slug}`,
        exact ? `   ${exact.display}${exact.isDefault ? '（Cursor 默认）' : ''}` : '   (未校验，强制切换)',
        '已写回 bridge.config.json。正在运行的任务不受影响，下一轮对话生效。',
      ];
      if (isBusy) {
        parts.push('当前有任务正在执行，若要立刻切换请先 /stop。');
      }
      await safeSend(credentials, userId, contextToken, parts.join('\n'));
      return;
    }

    if (text === '/cwd' || text.startsWith('/cwd ')) {
      const arg = text.slice(4).trim();

      if (!arg) {
        await safeSend(credentials, userId, contextToken, `当前工作目录：${cfg.cwd}`);
        return;
      }

      const abs = path.isAbsolute(arg) ? arg : path.resolve(cfg.cwd, arg);
      if (!fs.existsSync(abs)) {
        await safeSend(credentials, userId, contextToken, `❌ 目录不存在：${abs}`);
        return;
      }
      const stat = fs.statSync(abs);
      if (!stat.isDirectory()) {
        await safeSend(credentials, userId, contextToken, `❌ 不是目录：${abs}`);
        return;
      }

      const oldCwd = cfg.cwd;
      cfg.cwd = abs;
      try {
        persistConfigField('cwd', abs);
      } catch (e) {
        await safeSend(credentials, userId, contextToken,
          `⚠️ 内存已切换，但写回配置失败：${(e as Error).message}`);
        return;
      }

      if (isBusy) {
        killAgent(ctx);
      }
      ctx.queue.length = 0;
      ctx.followUpBuffer.length = 0;
      clearFollowUpFile(userId, oldCwd);
      delete state.sessions[userId];
      saveState(state);

      const parts = [`✅ 工作目录已切换：\n${oldCwd}\n→ ${abs}`, '已写回 bridge.config.json，会话已重置。'];
      if (isBusy) parts.push('正在执行的任务已终止。');
      await safeSend(credentials, userId, contextToken, parts.join('\n'));
      return;
    }

    if (text === '/clear') {
      ctx.queue.length = 0;
      ctx.followUpBuffer.length = 0;
      clearFollowUpFile(userId, cfg.cwd);
      killAgent(ctx);
      delete state.sessions[userId];
      saveState(state);
      await sendMessage(credentials, userId, contextToken, '✅ 已清除会话、终止任务、清空队列和追问。');
      return;
    }

    if (text === '/stop') {
      if (isBusy) {
        killAgent(ctx);
        await sendMessage(credentials, userId, contextToken,
          ctx.queue.length > 0
            ? `⏹ 已终止当前任务，队列还有 ${ctx.queue.length} 条将继续处理。`
            : '⏹ 已终止当前任务。');
      } else {
        await sendMessage(credentials, userId, contextToken, '当前没有正在执行的任务。');
      }
      return;
    }

    if (text === '/stopall') {
      const qLen = ctx.queue.length;
      const fLen = ctx.followUpBuffer.length;
      ctx.queue.length = 0;
      ctx.followUpBuffer.length = 0;
      clearFollowUpFile(userId, cfg.cwd);
      killAgent(ctx);
      const parts = [qLen > 0 && `${qLen} 条排队`, fLen > 0 && `${fLen} 条追问`].filter(Boolean);
      await sendMessage(credentials, userId, contextToken,
        `⏹ 已终止当前任务${parts.length ? `并清空 ${parts.join('、')}` : ''}。`);
      return;
    }

    if (text.startsWith('/send ')) {
      const filePath = text.slice(6).trim();
      await handleSendFile(userId, contextToken, filePath);
      return;
    }

    /* --- reply permission check --- */

    const canReply = !cfg.replyAllowedUserIds.length || cfg.replyAllowedUserIds.includes(userId);
    if (!canReply) {
      await sendMessage(credentials, userId, contextToken, cfg.replyDeniedMessage);
      return;
    }

    /* --- /排队 prefix → force enqueue as independent task --- */

    const isExplicitQueue = text.startsWith('/排队');
    const effectiveInbound = isExplicitQueue
      ? { ...inbound, text: text.slice(3).trim() }
      : inbound;
    const prompt = buildPromptText(isExplicitQueue ? effectiveInbound : inbound);

    if (isBusy) {
      const totalPending = ctx.followUpBuffer.length + ctx.queue.length;
      if (totalPending >= MAX_QUEUE_SIZE) {
        await sendMessage(credentials, userId, contextToken,
          `⚠️ 待处理已满 (${MAX_QUEUE_SIZE} 条)。请等当前任务完成，或发 /stop 终止当前任务、/stopall 全部清空。`);
        return;
      }

      if (isExplicitQueue) {
        /* --- explicit queue: independent task --- */
        ctx.queue.push({ prompt, contextToken });
        console.log(`[bridge] 📋 消息入队 (user=${userId.slice(0, 12)}…, 队列${ctx.queue.length}条)`);
        await sendMessage(credentials, userId, contextToken,
          `📋 已作为独立任务排队 (#${ctx.queue.length})，当前任务完成后依次处理。`);
      } else {
        /* --- default: follow-up → merge into current conversation --- */
        ctx.followUpBuffer.push({ prompt, contextToken });
        console.log(`[bridge] 💬 追问入缓冲区 (user=${userId.slice(0, 12)}…, 追问${ctx.followUpBuffer.length}条)`);
        writeFollowUpFile(userId, ctx.followUpBuffer, cfg.cwd);
        await sendMessage(credentials, userId, contextToken,
          `💬 已收到追问 (#${ctx.followUpBuffer.length})，已写入 ${FOLLOWUP_FILENAME}，Agent 可在执行中读取。任务完成后也会在同一对话中处理。`);
      }
      return;
    }

    /* --- idle → process --- */

    void drainQueue(userId, prompt, contextToken);
  }

  /* ---------- main loop ---------- */

  console.log('[bridge] 🔄 进入长轮询循环，等待微信消息...');
  let pollCount = 0;

  while (true) {
    try {
      const resp = await getUpdates(credentials, state.get_updates_buf);
      if (resp.get_updates_buf) state.get_updates_buf = resp.get_updates_buf;
      pollCount++;

      const msgCount = resp.msgs?.length ?? 0;
      if (msgCount > 0) {
        console.log(`[bridge] 📨 轮询 #${pollCount}: 收到 ${msgCount} 条消息`);
      } else if (pollCount % 20 === 0) {
        console.log(`[bridge] … 轮询 #${pollCount} 在线，暂无新消息`);
      }

      for (const msg of resp.msgs ?? []) {
        await handleOneMessage(msg);
      }
      saveState(state);
    } catch (e) {
      console.error('[bridge] getUpdates error:', e);
      await sleep(3000);
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
