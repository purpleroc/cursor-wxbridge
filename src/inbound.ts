/**
 * 解析企业微信入站消息：提取文本、下载并落地图片/文件/视频媒体。
 *
 * 媒体下载走 SDK 的 client.downloadFile(url, aeskey)（内置 AES-256-CBC 解密）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type {
  WSClient,
  BaseMessage,
  ImageContent,
  FileContent,
  MixedMsgItem,
} from '@wecom/aibot-node-sdk';

export interface InboundPayload {
  text: string;
  /** 已落地的图片路径 */
  imageParts: { savedPath: string }[];
  /** 已落地的附件路径（文件 / 视频） */
  savedPaths: string[];
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function sanitizeName(name: string): string {
  return name.replace(/[^\w.\-()\u4e00-\u9fa5]/g, '_').slice(0, 120);
}

function writeBuffer(inboundDir: string, name: string, data: Buffer): string {
  ensureDir(inboundDir);
  const fp = path.join(inboundDir, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${name}`);
  fs.writeFileSync(fp, data);
  return fp;
}

async function downloadImage(
  client: WSClient,
  img: ImageContent,
  inboundDir: string,
): Promise<string | null> {
  if (!img?.url) return null;
  const { buffer, filename } = await client.downloadFile(img.url, img.aeskey);
  const name = sanitizeName(filename || 'image.jpg');
  return writeBuffer(inboundDir, name, buffer);
}

async function downloadFileItem(
  client: WSClient,
  file: FileContent & { filename?: string },
  inboundDir: string,
): Promise<string | null> {
  if (!file?.url) return null;
  const { buffer, filename } = await client.downloadFile(file.url, file.aeskey);
  const name = sanitizeName(file.filename || filename || 'file.dat');
  return writeBuffer(inboundDir, name, buffer);
}

/**
 * 将一条入站消息物化为文本 + 落地媒体路径。
 */
export async function materializeInbound(
  client: WSClient,
  body: BaseMessage,
  inboundDir: string,
): Promise<InboundPayload> {
  const imageParts: InboundPayload['imageParts'] = [];
  const savedPaths: string[] = [];
  const textParts: string[] = [];

  const msgtype = body.msgtype;

  try {
    if (msgtype === 'text' && body.text?.content) {
      textParts.push(body.text.content);
    } else if (msgtype === 'voice' && body.voice?.content) {
      // 语音由服务端转文本
      textParts.push(`[语音] ${body.voice.content}`);
    } else if (msgtype === 'image' && body.image) {
      const p = await downloadImage(client, body.image as ImageContent, inboundDir);
      if (p) imageParts.push({ savedPath: p });
    } else if (msgtype === 'file' && body.file) {
      const p = await downloadFileItem(client, body.file as FileContent, inboundDir);
      if (p) savedPaths.push(p);
    } else if (msgtype === 'video' && body.video) {
      const v = body.video as { url?: string; aeskey?: string };
      if (v.url) {
        const { buffer, filename } = await client.downloadFile(v.url, v.aeskey);
        savedPaths.push(writeBuffer(inboundDir, sanitizeName(filename || 'video.mp4'), buffer));
      }
    } else if (msgtype === 'mixed' && body.mixed?.msg_item) {
      for (const item of body.mixed.msg_item as MixedMsgItem[]) {
        if (item.msgtype === 'text' && item.text?.content) {
          textParts.push(item.text.content);
        } else if (item.msgtype === 'image' && item.image) {
          const p = await downloadImage(client, item.image, inboundDir);
          if (p) imageParts.push({ savedPath: p });
        }
      }
    }

    // 引用消息：附带引用的文本，便于 Agent 理解上下文
    if (body.quote?.text?.content) {
      textParts.unshift(`[引用] ${body.quote.text.content}`);
    }
  } catch (e) {
    textParts.push(`[媒体处理失败] ${String(e)}`);
  }

  return {
    text: textParts.join('\n').trim(),
    imageParts,
    savedPaths,
  };
}
