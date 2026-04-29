/**
 * 微信异步回复权限确认。
 *
 * 支持三种标准回复（允许/拒绝/始终允许）以及任意自由文本。
 * 自由文本被视为"拒绝当前操作 + 用户附加指示"，指示会传递给 Agent 作为后续上下文。
 */

export interface PermissionResult {
  behavior: 'allow' | 'deny';
  message?: string;
  /** 用户发送的自由文本（非预设关键词），可作为指示传递给 Agent */
  userText?: string;
  updatedPermissions?: unknown[];
}

export class PermissionGate {
  private pending = new Map<
    string,
    {
      resolve: (r: PermissionResult) => void;
      suggestions?: unknown[];
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private readonly timeoutMs: number) {}

  wait(userId: string, suggestions: unknown[] | undefined, signal: AbortSignal): Promise<PermissionResult> {
    return new Promise((resolve, reject) => {
      const prev = this.pending.get(userId);
      if (prev) {
        clearTimeout(prev.timeout);
        prev.resolve({ behavior: 'deny', message: '新的权限请求已覆盖上一项。' });
      }

      const timeout = setTimeout(() => {
        this.pending.delete(userId);
        resolve({ behavior: 'deny', message: '权限确认超时，已自动跳过。' });
      }, this.timeoutMs);

      const onAbort = () => {
        clearTimeout(timeout);
        const cur = this.pending.get(userId);
        if (cur?.timeout === timeout) {
          this.pending.delete(userId);
          reject(new Error('aborted'));
        }
      };

      signal.addEventListener('abort', onAbort, { once: true });

      this.pending.set(userId, { resolve, suggestions, timeout });
    });
  }

  /**
   * 将用户回复递送给待处理的权限请求。
   * 所有文本都会被接受——预设关键词映射到 allow/deny，
   * 其他自由文本视为 deny + userText。
   */
  deliver(
    userId: string,
    text: string,
    _notify: (hint: string) => Promise<void>,
  ): boolean {
    const p = this.pending.get(userId);
    if (!p) return false;

    const parsed = parsePermissionReply(text.trim(), p.suggestions);
    clearTimeout(p.timeout);
    this.pending.delete(userId);
    p.resolve(parsed);
    return true;
  }

  hasPending(userId: string): boolean {
    return this.pending.has(userId);
  }
}

function normalize(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[１-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

/**
 * 解析权限回复。始终返回结果（不再返回 null）：
 * - 匹配允许/拒绝/始终允许关键词 → 对应 behavior
 * - 任何其他文本 → deny + userText（用户自定义指示）
 */
export function parsePermissionReply(raw: string, suggestions?: unknown[]): PermissionResult {
  const t = raw.trim();
  if (!t) return { behavior: 'deny', message: '空回复，已跳过。' };

  const n = normalize(t);

  const allowOnce =
    n === '1' ||
    n === 'y' ||
    n === 'yes' ||
    n === 'ok' ||
    t === '允许' ||
    t.startsWith('允许') ||
    t === '好' ||
    t === '👌';

  const deny =
    n === '2' ||
    n === 'n' ||
    n === 'no' ||
    t === '否' ||
    t.startsWith('拒绝') ||
    n === 'deny';

  const always =
    suggestions?.length &&
    (n === '3' ||
      n === 'always' ||
      t.includes('始终允许') ||
      t.includes('始终') ||
      t.toLowerCase().includes('always'));

  if (always && suggestions?.length) {
    return { behavior: 'allow', updatedPermissions: suggestions };
  }
  if (allowOnce) {
    return { behavior: 'allow' };
  }
  if (deny) {
    return { behavior: 'deny', message: '用户拒绝执行该工具。' };
  }

  return {
    behavior: 'deny',
    userText: t,
    message: `用户回复了自定义指示: ${t}`,
  };
}
