/**
 * 企业微信智能机器人通道层。
 *
 * 基于 @wecom/aibot-node-sdk 的 WebSocket 长连接封装：
 * - 连接 / 自动认证 / 断线重连（SDK 内置）
 * - 主动推送 markdown（用于异步产出的进度与最终回答）
 * - 被动流式即时反馈（用于收到消息后立即回执）
 * - 文件上传并发送（uploadMedia + sendMediaMessage）
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  WSClient,
  generateReqId,
  type WsFrame,
  type WsFrameHeaders,
  type Logger,
  type WeComMediaType,
} from '@wecom/aibot-node-sdk';
import type { WecomCredentials } from './credentials.js';

/** replyStream / sendMessage markdown 内容的字节上限（协议约 20480 字节，留余量） */
const STREAM_CONTENT_MAX_BYTES = 18_000;

function buildLogger(verbose: boolean): Logger {
  const ts = () => new Date().toISOString();
  return {
    debug: verbose ? (m, ...a) => console.log(`[wecom][debug] ${ts()} ${m}`, ...a) : () => {},
    info: (m, ...a) => console.log(`[wecom] ${ts()} ${m}`, ...a),
    warn: (m, ...a) => console.warn(`[wecom][warn] ${ts()} ${m}`, ...a),
    error: (m, ...a) => console.error(`[wecom][error] ${ts()} ${m}`, ...a),
  };
}

/** 创建并配置 WSClient（不会自动连接，调用方需 .connect()） */
export function createWecomClient(cred: WecomCredentials, verbose = false): WSClient {
  const wsOptions =
    cred.caPath && fs.existsSync(cred.caPath)
      ? { ca: fs.readFileSync(cred.caPath) }
      : undefined;

  return new WSClient({
    botId: cred.botId,
    secret: cred.secret,
    ...(cred.wsUrl ? { wsUrl: cred.wsUrl } : {}),
    ...(wsOptions ? { wsOptions } : {}),
    maxReconnectAttempts: -1,
    logger: buildLogger(verbose),
  });
}

/** 按 UTF-8 字节长度切分字符串，避免单条超过协议上限 */
function chunkByBytes(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of text) {
    const b = Buffer.byteLength(ch, 'utf-8');
    if (curBytes + b > maxBytes && cur) {
      chunks.push(cur);
      cur = '';
      curBytes = 0;
    }
    cur += ch;
    curBytes += b;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/**
 * 主动推送文本（markdown）到指定用户（单聊 chatid = userid）。
 * 超长自动按字节分段为多条。返回是否全部成功。
 */
export async function pushMarkdown(
  client: WSClient,
  userId: string,
  text: string,
  maxLen = STREAM_CONTENT_MAX_BYTES,
): Promise<boolean> {
  const t = text || '';
  if (!t.trim()) return false;
  const segments = chunkByBytes(t, Math.min(maxLen, STREAM_CONTENT_MAX_BYTES));
  let ok = true;
  for (const seg of segments) {
    try {
      await client.sendMessage(userId, { msgtype: 'markdown', markdown: { content: seg } });
    } catch (e) {
      console.error('[wecom] pushMarkdown 失败:', e);
      ok = false;
    }
  }
  return ok;
}

/**
 * 被动流式即时回执：用收到消息的 frame（透传 req_id）回复一条已结束的流式消息。
 * 用于"已收到，处理中"等即时反馈，以及短命令的同步回复。
 */
export async function replyAck(
  client: WSClient,
  frame: WsFrameHeaders,
  text: string,
): Promise<boolean> {
  const t = (text || '').trim();
  if (!t) return false;
  // 单条被动回复内容上限较大，命令类输出可直接放入；超长则截断尾部由主动推送补发
  const content = Buffer.byteLength(t, 'utf-8') > STREAM_CONTENT_MAX_BYTES
    ? t.slice(0, 6000)
    : t;
  try {
    await client.replyStream(frame, generateReqId('stream'), content, true);
    return true;
  } catch (e) {
    console.error('[wecom] replyAck 失败:', e);
    return false;
  }
}

/** 根据扩展名推断上传素材类型 */
function inferUploadType(filePath: string): WeComMediaType {
  const ext = path.extname(filePath).toLowerCase();
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
  const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  const voiceExts = ['.amr', '.silk'];
  if (imageExts.includes(ext)) return 'image';
  if (videoExts.includes(ext)) return 'video';
  if (voiceExts.includes(ext)) return 'voice';
  return 'file';
}

/**
 * 上传本地文件到企业微信临时素材并主动发送给用户。
 */
export async function sendFileToUser(
  client: WSClient,
  userId: string,
  filePath: string,
): Promise<void> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }
  const buffer = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  const type = inferUploadType(filePath);

  const result = await client.uploadMedia(buffer, { type, filename });
  if (type === 'video') {
    await client.sendMediaMessage(userId, type, result.media_id, { title: filename });
  } else {
    await client.sendMediaMessage(userId, type, result.media_id);
  }
}

export type { WsFrame };
