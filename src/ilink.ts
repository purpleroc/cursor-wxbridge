/**
 * ilink API 通信层
 * 封装了与微信 ClawBot ilink 服务的所有 HTTP 交互
 *
 * 行为对齐 Tencent [openclaw-weixin](https://github.com/Tencent/openclaw-weixin)
 * （参考：openclaw-weixin/src/api/api.ts、src/cdn/cdn-url.ts）
 */

import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  QRCodeResponse,
  QRStatusResponse,
  GetUpdatesResp,
  GetUploadUrlResp,
  WeixinMessage,
  GetConfigResp,
  Credentials,
} from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 默认 API 基础地址
const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';

// Bot 类型常量（与 openclaw-weixin src/auth/login-qr.ts 一致）
const DEFAULT_ILINK_BOT_TYPE = '3';

// 超时设置
const LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;

// CDN 默认地址（openclaw-weixin src/auth/accounts.ts）
const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

interface PkgJson {
  version?: string;
  ilink_appid?: string;
}

function readBridgePackageJson(): PkgJson {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as PkgJson;
  } catch {
    return {};
  }
}

const pkg = readBridgePackageJson();

/** base_info.channel_version：与 openclaw 一致使用 npm 包 version */
const CHANNEL_VERSION = pkg.version ?? 'unknown';

/** iLink-App-Id，见 openclaw-weixin package.json 顶层 ilink_appid */
const ILINK_APP_ID = pkg.ilink_appid ?? 'bot';

/**
 * iLink-App-ClientVersion: 0x00MMNNPP（openclaw-weixin src/api/api.ts）
 */
function buildClientVersion(version: string): number {
  const parts = version.split('.').map(p => parseInt(p, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

const ILINK_APP_CLIENT_VERSION = buildClientVersion(pkg.version ?? '0.0.0');

function buildBaseInfo(): { channel_version: string } {
  return { channel_version: CHANNEL_VERSION };
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

/** X-WECHAT-UIN：密码学安全随机 uint32（openclaw-weixin） */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function buildCommonHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
  };
  const routeTag = process.env.ILINK_SK_ROUTE_TAG?.trim();
  if (routeTag) {
    headers.SKRouteTag = routeTag;
  }
  return headers;
}

function buildPostHeaders(token: string | undefined, bodyStr: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'Content-Length': String(Buffer.byteLength(bodyStr, 'utf-8')),
    'X-WECHAT-UIN': randomWechatUin(),
    ...buildCommonHeaders(),
  };
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

/**
 * POST ilink API（URL 拼接与 openclaw apiPostFetch 一致）
 */
async function apiFetch<T>(
  baseUrl: string,
  endpoint: string,
  body: Record<string, unknown>,
  token?: string,
  timeoutMs: number = API_TIMEOUT_MS,
): Promise<T> {
  const base = ensureTrailingSlash(baseUrl);
  const url = new URL(endpoint, base).toString();
  const bodyWithBase = {
    ...body,
    base_info: buildBaseInfo(),
  };
  const bodyStr = JSON.stringify(bodyWithBase);
  const headers = buildPostHeaders(token, bodyStr);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`ilink API error: ${res.status} ${res.statusText} - ${errText}`);
    }

    return JSON.parse(await res.text()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function apiGetJson<T>(
  baseUrl: string,
  endpoint: string,
  timeoutMs?: number,
): Promise<T> {
  const base = ensureTrailingSlash(baseUrl);
  const url = new URL(endpoint, base).toString();
  const controller =
    timeoutMs != null && timeoutMs > 0 ? new AbortController() : undefined;
  const t =
    controller != null && timeoutMs != null
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: buildCommonHeaders(),
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (t !== undefined) clearTimeout(t);
    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`ilink GET ${endpoint} ${res.status}: ${rawText}`);
    }
    return JSON.parse(rawText) as T;
  } catch (err) {
    if (t !== undefined) clearTimeout(t);
    throw err;
  }
}

// ========== 二维码登录 ==========

/**
 * 获取登录二维码
 * 对应 ilink/bot/get_bot_qrcode 接口（GET 方式）
 */
export async function fetchQRCode(baseUrl: string = DEFAULT_BASE_URL): Promise<QRCodeResponse> {
  const endpoint = `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(DEFAULT_ILINK_BOT_TYPE)}`;
  return apiGetJson<QRCodeResponse>(baseUrl, endpoint);
}

/**
 * 轮询二维码扫描状态（GET 长轮询）
 * 超时/网关错误时返回 wait，与 openclaw-weixin login-qr.ts 一致
 */
export async function pollQRStatus(
  qrcode: string,
  baseUrl: string = DEFAULT_BASE_URL,
): Promise<QRStatusResponse> {
  const endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  try {
    return await apiGetJson<QRStatusResponse>(baseUrl, endpoint, LONG_POLL_TIMEOUT_MS);
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { status: 'wait' };
    }
    console.warn(`[pollQRStatus] 网络错误，将重试: ${String(err)}`);
    return { status: 'wait' };
  }
}

// ========== 消息收发 ==========

/**
 * 长轮询获取新消息
 * 对应 ilink/bot/getupdates 接口
 */
export async function getUpdates(
  credentials: Credentials,
  getUpdatesBuf: string = '',
): Promise<GetUpdatesResp> {
  try {
    return await apiFetch<GetUpdatesResp>(
      credentials.base_url,
      'ilink/bot/getupdates',
      { get_updates_buf: getUpdatesBuf },
      credentials.bot_token,
      LONG_POLL_TIMEOUT_MS,
    );
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}

/**
 * 生成唯一的 client_id
 */
function generateClientId(): string {
  return `cursor-agent-bridge-${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * 发送消息到微信
 * 对应 ilink/bot/sendmessage 接口
 *
 * 关键：msg 必须包含 from_user_id、client_id、message_type、message_state
 * 参考 OpenClaw 源码 src/messaging/send.ts
 */
export async function sendMessage(
  credentials: Credentials,
  toUserId: string,
  contextToken: string,
  text: string,
): Promise<Record<string, unknown>> {
  const clientId = generateClientId();
  const msg: WeixinMessage = {
    from_user_id: '',              // Bot 发送时为空字符串
    to_user_id: toUserId,
    client_id: clientId,           // 每条消息唯一 ID
    message_type: 2,               // BOT = 2
    message_state: 2,              // FINISH = 2
    context_token: contextToken,
    item_list: [
      {
        type: 1,  // TEXT
        text_item: { text },
      },
    ],
  };

  return await apiFetch<Record<string, unknown>>(
    credentials.base_url,
    'ilink/bot/sendmessage',
    { msg },
    credentials.bot_token,
  );
}

/**
 * 发送"正在输入"状态
 * 对应 ilink/bot/sendtyping 接口
 */
export async function sendTyping(
  credentials: Credentials,
  userId: string,
  typingTicket: string,
  cancel: boolean = false,
): Promise<void> {
  await apiFetch(
    credentials.base_url,
    'ilink/bot/sendtyping',
    {
      ilink_user_id: userId,
      typing_ticket: typingTicket,
      status: cancel ? 2 : 1,
    },
    credentials.bot_token,
    10_000,
  );
}

/**
 * 获取 Bot 配置（包含 typing_ticket）
 * 对应 ilink/bot/getconfig 接口
 */
export async function getConfig(
  credentials: Credentials,
  opts?: { ilinkUserId?: string; contextToken?: string },
): Promise<GetConfigResp> {
  const body: Record<string, unknown> = {};
  if (opts?.ilinkUserId) body.ilink_user_id = opts.ilinkUserId;
  if (opts?.contextToken) body.context_token = opts.contextToken;
  return apiFetch<GetConfigResp>(
    credentials.base_url,
    'ilink/bot/getconfig',
    body,
    credentials.bot_token,
    10_000,
  );
}

// ========== CDN 媒体下载 ==========

/**
 * AES-128-ECB 解密（CDN 下载内容的逆操作）
 */
function aesEcbDecrypt(data: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/** 与 openclaw-weixin src/cdn/pic-decrypt.ts parseAesKey 一致 */
function decodeAesKey(aesKeyB64: string, label: string): Buffer {
  const decoded = Buffer.from(aesKeyB64, 'base64');
  if (decoded.length === 16) {
    return decoded;
  }
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error(
    `${label}: aes_key 须为 base64(16 字节) 或 base64(32 位 hex 文本)，当前解码长度 ${decoded.length}`,
  );
}

function buildCdnDownloadUrl(encryptedQueryParam: string, cdnBaseUrl: string): string {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

export async function downloadAndDecryptMedia(
  encryptQueryParam: string,
  aesKeyB64: string,
): Promise<Buffer> {
  const downloadUrl = buildCdnDownloadUrl(encryptQueryParam, CDN_BASE_URL);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  try {
    const res = await fetch(downloadUrl, {
      method: 'GET',
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`CDN download failed: ${res.status} ${res.statusText} - ${errText}`);
    }

    const encryptedData = Buffer.from(await res.arrayBuffer());

    // 解密 — 兼容两种 key 编码格式
    const aesKey = decodeAesKey(aesKeyB64, 'downloadAndDecryptMedia');
    return aesEcbDecrypt(encryptedData, aesKey);
  } finally {
    clearTimeout(timer);
  }
}

// ========== CDN 媒体上传 ==========

/**
 * AES-128-ECB 加密
 * 与 openclaw-weixin 插件的 src/cdn/aes-ecb.ts 一致
 */
function aesEcbEncrypt(data: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

/**
 * 计算 AES-128-ECB 密文大小（PKCS7 填充到 16 字节边界）
 * 与 openclaw-weixin 的 aesEcbPaddedSize 一致
 */
function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/**
 * 构建 CDN 上传 URL
 * 格式：{cdnBaseUrl}/upload?encrypted_query_param={uploadParam}&filekey={filekey}
 */
function buildCdnUploadUrl(cdnBaseUrl: string, uploadParam: string, filekey: string): string {
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

/**
 * 获取 CDN 预签名上传参数
 * 对应 ilink/bot/getuploadurl 接口
 */
async function getUploadUrl(
  credentials: Credentials,
  toUserId: string,
  filekey: string,
  mediaType: number,
  rawSize: number,
  rawFileMd5: string,
  filesize: number,
  aesKeyHex: string,
): Promise<GetUploadUrlResp> {
  const body: Record<string, unknown> = {
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize: rawSize,
    rawfilemd5: rawFileMd5,
    filesize,
    no_need_thumb: true,
    aeskey: aesKeyHex,
  };

  return apiFetch<GetUploadUrlResp>(
    credentials.base_url,
    'ilink/bot/getuploadurl',
    body,
    credentials.bot_token,
  );
}

/**
 * 上传加密文件到 CDN
 *
 * 根据 openclaw-weixin 源码 uploadBufferToCdn：
 * - URL: {cdnBaseUrl}/upload?encrypted_query_param={uploadParam}&filekey={filekey}
 * - 方法: POST
 * - Body: AES-128-ECB 加密后的密文
 * - 响应: 从 x-encrypted-param header 获取 downloadParam
 *
 * 返回 downloadParam，用于后续发消息时作为 encrypt_query_param
 */
async function uploadBufferToCdn(
  plaintext: Buffer,
  uploadParam: string,
  filekey: string,
  aesKey: Buffer,
): Promise<string> {
  const ciphertext = aesEcbEncrypt(plaintext, aesKey);
  const cdnUrl = buildCdnUploadUrl(CDN_BASE_URL, uploadParam, filekey);

  const UPLOAD_MAX_RETRIES = 3;
  let downloadParam: string | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);

    try {
      const res = await fetch(cdnUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
        signal: controller.signal,
      });

      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get('x-error-message') ?? (await res.text().catch(() => ''));
        throw new Error(`CDN upload client error ${res.status}: ${errMsg}`);
      }
      if (res.status !== 200) {
        const errMsg = res.headers.get('x-error-message') ?? `status ${res.status}`;
        throw new Error(`CDN upload server error: ${errMsg}`);
      }

      downloadParam = res.headers.get('x-encrypted-param') ?? undefined;
      if (!downloadParam) {
        throw new Error('CDN upload response missing x-encrypted-param header');
      }
      break; // 成功，跳出重试循环
    } catch (err) {
      lastError = err;
      // 客户端错误（4xx）不重试
      if (err instanceof Error && err.message.includes('client error')) throw err;
      if (attempt < UPLOAD_MAX_RETRIES) {
        console.error(`[CDN] attempt ${attempt} failed, retrying... err=${String(err)}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  if (!downloadParam) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`CDN upload failed after ${UPLOAD_MAX_RETRIES} attempts`);
  }

  return downloadParam;
}

/**
 * 根据文件扩展名推断 media_type（用于 ilink API）
 * 1 = IMAGE, 2 = VIDEO, 3 = FILE
 */
function inferMediaType(filePath: string): number {
  const ext = path.extname(filePath).toLowerCase();
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'];
  const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];

  if (imageExts.includes(ext)) return 1; // IMAGE
  if (videoExts.includes(ext)) return 2; // VIDEO
  return 3; // FILE
}

/**
 * 根据文件扩展名和大小推断消息 item type
 * 2=IMAGE, 3=VOICE, 4=FILE, 5=VIDEO
 *
 * 语音条(3)仅用于极小的录音片段（<500KB），大音频文件走文件附件(4)
 */
function inferItemType(filePath: string, fileSize?: number): number {
  const ext = path.extname(filePath).toLowerCase();
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'];
  const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  const voiceExts = ['.amr', '.silk'];

  if (imageExts.includes(ext)) return 2;
  if (voiceExts.includes(ext) && (fileSize ?? 0) < 512 * 1024) return 3;
  if (videoExts.includes(ext)) return 5;
  return 4; // FILE — 包括 mp3/m4a/wav 等大音频
}

/**
 * 发送文件到微信
 *
 * 完整流程（完全对齐 openclaw-weixin 源码 uploadMediaToCdn + uploadBufferToCdn）：
 * 1. 读取本地文件，计算明文 size、MD5、预算密文 size
 * 2. 生成随机 filekey（16字节hex）和 AES 密钥
 * 3. 调用 getUploadUrl 获取 upload_param（含 no_need_thumb + aeskey）
 * 4. 用 POST 方法将密文上传到 CDN（URL: /upload?encrypted_query_param=...&filekey=...）
 * 5. 从 CDN 响应头 x-encrypted-param 获取 downloadParam
 * 6. 用 downloadParam 作为消息中的 encrypt_query_param 发送消息
 */
export async function sendFile(
  credentials: Credentials,
  toUserId: string,
  contextToken: string,
  filePath: string,
  caption?: string,
): Promise<Record<string, unknown>> {
  // 1. 读取文件
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }
  const fileData = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const mediaType = inferMediaType(filePath);
  const itemType = inferItemType(filePath, fileData.length);

  // 2. 计算原始文件 MD5、大小、预算密文大小
  const rawFileMd5 = crypto.createHash('md5').update(fileData).digest('hex');
  const rawSize = fileData.length;
  const filesize = aesEcbPaddedSize(rawSize); // 预算密文大小（PKCS7 填充）

  // 3. 生成随机 AES-128 密钥和 filekey
  const aesKey = crypto.randomBytes(16);
  const aesKeyHex = aesKey.toString('hex');
  const filekey = crypto.randomBytes(16).toString('hex'); // 32 字符 hex

  console.log(`[sendFile] file=${fileName} rawsize=${rawSize} filesize=${filesize} md5=${rawFileMd5} filekey=${filekey}`);

  // 4. 获取 CDN 上传参数
  const uploadInfo = await getUploadUrl(
    credentials,
    toUserId,
    filekey,
    mediaType,
    rawSize,
    rawFileMd5,
    filesize,
    aesKeyHex,
  );

  if (!uploadInfo.upload_param) {
    throw new Error(`获取上传参数失败: ${JSON.stringify(uploadInfo)}`);
  }

  console.log(`[sendFile] got upload_param (length=${uploadInfo.upload_param.length})`);

  // 5. 上传加密文件到 CDN，获取 downloadParam
  const downloadParam = await uploadBufferToCdn(
    fileData,
    uploadInfo.upload_param,
    filekey,
    aesKey,
  );

  console.log(`[sendFile] CDN upload success, got downloadParam (length=${downloadParam.length})`);

  // 6. 构造消息，用 downloadParam 作为 encrypt_query_param
  //
  // 关键：media.aes_key 编码为 "base64(hex string)"
  // 即先将 hex 字符串当作 ASCII 字节，再做 base64
  // 例如：hex "00112233..." → base64("00112233...") = "MDAxMTIyMzM..."
  // 参考协议规范 8.4 节和 openclaw-weixin 源码
  const aesKeyBase64 = Buffer.from(aesKeyHex, 'ascii').toString('base64');

  console.log(`[sendFile] aesKeyBase64=${aesKeyBase64.slice(0, 20)}... (len=${aesKeyBase64.length})`);

  // 根据协议规范 6.7 节，一条消息只发一个 MessageItem（兼容性最好）
  // 所以如果有 caption，先单独发文本消息，再发文件消息

  if (caption) {
    const textClientId = generateClientId();
    await apiFetch<Record<string, unknown>>(
      credentials.base_url,
      'ilink/bot/sendmessage',
      {
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: textClientId,
          message_type: 2,
          message_state: 1,
          context_token: contextToken,
          item_list: [{ type: 1, text_item: { text: caption } }],
        },
      },
      credentials.bot_token,
      30_000,
    );
  }

  // 构造单个媒体 item（按协议规范 5.5-5.8 的精确字段）
  let mediaItem: Record<string, unknown>;

  const cdnMedia = {
    encrypt_query_param: downloadParam,
    aes_key: aesKeyBase64,
    encrypt_type: 1,
  };

  if (itemType === 2) {
    // IMAGE — 协议 5.5
    mediaItem = {
      type: 2,
      image_item: {
        media: cdnMedia,
        aeskey: aesKeyHex, // 同时提供 hex 格式的 aeskey
        mid_size: filesize, // 密文大小
      },
    };
  } else if (itemType === 4) {
    // FILE — 协议 5.7
    mediaItem = {
      type: 4,
      file_item: {
        media: cdnMedia,
        file_name: fileName,
        md5: rawFileMd5,
        len: String(rawSize), // 注意：协议要求字符串形式
      },
    };
  } else if (itemType === 5) {
    // VIDEO — 协议 5.8
    mediaItem = {
      type: 5,
      video_item: {
        media: cdnMedia,
        video_size: filesize, // 密文大小
        video_md5: rawFileMd5,
      },
    };
  } else if (itemType === 3) {
    // VOICE — 协议 5.6
    mediaItem = {
      type: 3,
      voice_item: {
        media: cdnMedia,
      },
    };
  } else {
    throw new Error(`Unsupported item type: ${itemType}`);
  }

  const clientId = generateClientId();
  const msg = {
    from_user_id: '',
    to_user_id: toUserId,
    client_id: clientId,
    message_type: 2,
    message_state: 2,
    context_token: contextToken,
    item_list: [mediaItem],
  };

  console.log(`[sendFile] sending message with item type=${itemType}, client_id=${clientId}`);

  return await apiFetch<Record<string, unknown>>(
    credentials.base_url,
    'ilink/bot/sendmessage',
    { msg },
    credentials.bot_token,
    30_000,
  );
}
