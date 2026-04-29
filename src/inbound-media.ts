/**
 * 解析微信入站消息中的媒体并落地 / 解密密文
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { downloadAndDecryptMedia } from './ilink.js';
import type { Credentials, WeixinMessage, ImageItem, FileItem, VoiceItem, VideoItem } from './types.js';

export interface InboundPayload {
  text: string;
  /** 图片（已保存到磁盘，包含路径） */
  imageParts: { mediaType: string; base64: string; savedPath: string }[];
  /** 已写入磁盘的附件路径（文件/语音/视频或退化为文件的图片） */
  savedPaths: string[];
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function extForImageMagic(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'png';
  if (buf.length >= 6 && buf.slice(0, 6).toString('ascii') === 'GIF87a' || buf.slice(0, 6).toString('ascii') === 'GIF89a')
    return 'gif';
  if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP')
    return 'webp';
  return 'bin';
}

function mimeForExt(ext: string): string {
  const m: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    bin: 'application/octet-stream',
  };
  return m[ext] ?? 'application/octet-stream';
}

function getImageCdn(it: ImageItem): { param: string; key: string } | null {
  const m = it.media ?? it.cdn ?? it.thumb_media;
  const param =
    m?.encrypt_query_param ?? it.encrypt_query_param;
  const key = m?.aes_key ?? it.aes_key ?? (it.aeskey ? Buffer.from(it.aeskey, 'ascii').toString('base64') : undefined);
  if (param && key) return { param, key };
  return null;
}

function getFileCdn(it: FileItem): { param: string; key: string } | null {
  const m = it.media ?? it.cdn;
  const param = m?.encrypt_query_param ?? it.encrypt_query_param;
  let key = m?.aes_key ?? it.aes_key;
  if (!key && it.aes_key && /^[0-9a-fA-F]{32}$/.test(it.aes_key)) {
    key = Buffer.from(it.aes_key, 'ascii').toString('base64');
  }
  if (param && key) return { param, key };
  return null;
}

function getVoiceCdn(it: VoiceItem): { param: string; key: string } | null {
  const m = it.media ?? it.cdn;
  const param = m?.encrypt_query_param ?? it.encrypt_query_param;
  const key = m?.aes_key ?? it.aes_key;
  if (param && key) return { param, key };
  return null;
}

function getVideoCdn(it: VideoItem): { param: string; key: string } | null {
  const m = it.media ?? it.cdn;
  const param = m?.encrypt_query_param ?? it.encrypt_query_param;
  const key = m?.aes_key ?? it.aes_key;
  if (param && key) return { param, key };
  return null;
}

function writeBuffer(inboundDir: string, ext: string, data: Buffer): string {
  ensureDir(inboundDir);
  const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const fp = path.join(inboundDir, name);
  fs.writeFileSync(fp, data);
  return fp;
}

export async function materializeInboundMessage(
  msg: WeixinMessage,
  _credentials: Credentials,
  inboundDir: string,
): Promise<InboundPayload> {
  const imageParts: InboundPayload['imageParts'] = [];
  const savedPaths: string[] = [];
  const textParts: string[] = [];

  for (const it of msg.item_list ?? []) {
    const ty = it.type;
    if (ty === 1 && it.text_item?.text) {
      textParts.push(it.text_item.text);
      continue;
    }

    try {
      if (ty === 2 && it.image_item) {
        const ref = getImageCdn(it.image_item);
        if (ref) {
          const buf = await downloadAndDecryptMedia(ref.param, ref.key);
          const ext = extForImageMagic(buf);
          const savedPath = writeBuffer(inboundDir, ext === 'bin' ? 'bin' : ext, buf);
          if (ext === 'bin') {
            savedPaths.push(savedPath);
          } else {
            imageParts.push({ mediaType: mimeForExt(ext), base64: buf.toString('base64'), savedPath });
          }
        }
        continue;
      }
      if (ty === 4 && it.file_item) {
        const ref = getFileCdn(it.file_item);
        if (ref) {
          const buf = await downloadAndDecryptMedia(ref.param, ref.key);
          const base = (it.file_item.file_name || 'file').replace(/[^\w.\-()\u4e00-\u9fa5]/g, '_');
          const ext = path.extname(base).slice(1) || 'dat';
          savedPaths.push(writeBuffer(inboundDir, ext, buf));
        }
        continue;
      }
      if (ty === 3 && it.voice_item) {
        if (it.voice_item.text) {
          textParts.push(`[语音] ${it.voice_item.text}`);
        } else {
          const ref = getVoiceCdn(it.voice_item);
          if (ref) {
            const buf = await downloadAndDecryptMedia(ref.param, ref.key);
            savedPaths.push(writeBuffer(inboundDir, 'voice.dat', buf));
          }
        }
        continue;
      }
      if (ty === 5 && it.video_item) {
        const ref = getVideoCdn(it.video_item);
        if (ref) {
          const buf = await downloadAndDecryptMedia(ref.param, ref.key);
          savedPaths.push(writeBuffer(inboundDir, 'mp4', buf));
        }
        continue;
      }
    } catch (e) {
      textParts.push(`[媒体处理失败] ${String(e)}`);
    }
  }

  return {
    text: textParts.join('\n').trim(),
    imageParts,
    savedPaths,
  };
}
