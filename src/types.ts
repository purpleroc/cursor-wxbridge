/**
 * ilink API 类型定义
 * 与 Tencent openclaw-weixin（参考：openclaw-weixin/ 或 https://github.com/Tencent/openclaw-weixin）保持同步
 */

// ============ 二维码登录 ============

export interface QRCodeResponse {
  /** 二维码标识符，用于后续轮询状态 */
  qrcode: string;
  /** 二维码图片内容（Base64 编码的 PNG） */
  qrcode_img_content: string;
}

export interface QRStatusResponse {
  /** 状态：wait=等待扫码, scaned=已扫未确认, confirmed=已确认, expired=已过期, scaned_but_redirect=IDC 重定向 */
  status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect';
  /** 登录成功后的 Bot Token */
  bot_token?: string;
  /** Bot ID（账号 ID） */
  ilink_bot_id?: string;
  /** 服务端返回的 API base URL */
  baseurl?: string;
  /** 扫码用户 ID */
  ilink_user_id?: string;
  /** scaned_but_redirect 时的新 host，轮询应切到 https://{redirect_host} */
  redirect_host?: string;
}

// ============ 消息 ============

export interface TextItem {
  text?: string;
}

export interface CDNMedia {
  /** CDN 加密下载/上传参数 */
  encrypt_query_param?: string;
  /** AES-128 密钥（Base64 编码） */
  aes_key?: string;
}

export interface ImageItem {
  /** CDN 媒体引用（协议 5.5 标准路径） */
  media?: CDNMedia;
  /** 缩略图 CDN 引用 */
  thumb_media?: CDNMedia;
  url?: string;
  /** CDN 媒体引用（兼容旧路径） */
  cdn?: CDNMedia;
  /** 兼容：直接在 item 上的字段 */
  encrypt_query_param?: string;
  aes_key?: string;
  media_id?: string;
  file_md5?: string;
  /** hex 编码的 AES key（某些入站图片会给这个字段） */
  aeskey?: string;
  /** 中图/主图密文大小 */
  mid_size?: number;
  /** 缩略图密文大小 */
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
  /** 高清图密文大小 */
  hd_size?: number;
}

export interface VoiceItem {
  /** CDN 媒体引用（协议 5.6 标准路径） */
  media?: CDNMedia;
  /** CDN 媒体引用（兼容旧路径） */
  cdn?: CDNMedia;
  /** 兼容：直接在 item 上的字段 */
  encrypt_query_param?: string;
  aes_key?: string;
  media_id?: string;
  file_md5?: string;
  /** 语音编码：1=pcm, 2=adpcm, 3=feature, 4=speex, 5=amr, 6=silk, 7=mp3, 8=ogg-speex */
  encode_type?: number;
  /** 位深 */
  bits_per_sample?: number;
  /** 采样率 Hz */
  sample_rate?: number;
  /** 播放时长（毫秒） */
  playtime?: number;
  /** 语音时长（秒）— 兼容旧字段 */
  duration?: number;
  /** 服务端提供的语音转文字结果 */
  text?: string;
}

export interface VideoItem {
  /** CDN 媒体引用（协议 5.8 标准路径） */
  media?: CDNMedia;
  /** CDN 媒体引用（兼容旧路径） */
  cdn?: CDNMedia;
  /** 兼容 */
  encrypt_query_param?: string;
  aes_key?: string;
  media_id?: string;
  file_md5?: string;
  /** 视频密文大小 */
  video_size?: number;
  /** 视频时长（毫秒） */
  play_length?: number;
  /** 视频文件 MD5 */
  video_md5?: string;
  /** 缩略图引用 */
  thumb_media?: CDNMedia;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
}

export interface FileItem {
  /** CDN 媒体引用（协议 5.7 标准路径） */
  media?: CDNMedia;
  /** CDN 媒体引用（兼容旧路径） */
  cdn?: CDNMedia;
  /** 文件名 */
  file_name?: string;
  /** 文件大小（字节）— 兼容旧字段 */
  file_size?: number;
  /** 文件大小（字符串形式）— 协议标准字段 */
  len?: string;
  /** CDN 媒体 ID */
  media_id?: string;
  /** AES 密钥（hex 编码） */
  aes_key?: string;
  /** 兼容：直接在 item 上的字段 */
  encrypt_query_param?: string;
  /** 文件 MD5（hex 编码） */
  file_md5?: string;
  /** 文件 MD5（协议标准字段） */
  md5?: string;
}

export interface MessageItem {
  /** 1=文本, 2=图片, 3=语音, 4=文件, 5=视频 */
  type?: number;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
}

// ============ CDN 上传 ============

/**
 * getUploadUrl 请求体
 *
 * 根据 openclaw-weixin 源码 uploadMediaToCdn：
 * - filekey: 随机 16 字节 hex（32 字符）
 * - media_type: 1=IMAGE, 2=VIDEO, 3=FILE, 4=VOICE
 * - to_user_id: 目标用户 ID
 * - rawsize: 原始明文文件大小
 * - rawfilemd5: 原始明文文件 MD5
 * - filesize: aesEcbPaddedSize(rawsize) — 预计算的密文大小
 * - no_need_thumb: true（跳过缩略图）
 * - aeskey: AES 密钥 hex 编码
 */
export interface GetUploadUrlReq {
  filekey: string;
  media_type: number;
  to_user_id: string;
  rawsize: number;
  rawfilemd5: string;
  filesize: number;
  no_need_thumb?: boolean;
  aeskey?: string;
}

export interface GetUploadUrlResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  /** CDN 上传加密参数（原图） */
  upload_param?: string;
  /** CDN 上传加密参数（缩略图） */
  thumb_upload_param?: string;
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  /** 1=用户消息, 2=机器人消息 */
  message_type?: number;
  /** 0=新消息, 1=生成中, 2=已完成 */
  message_state?: number;
  item_list?: MessageItem[];
  /** 上下文 token，回复时必须带上 */
  context_token?: string;
}

// ============ GetUpdates ============

export interface GetUpdatesReq {
  /** 同步游标，首次为空字符串 */
  get_updates_buf?: string;
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  /** 新的同步游标，下次请求时带上 */
  get_updates_buf?: string;
  /** 服务端建议的下次长轮询超时（毫秒） */
  longpolling_timeout_ms?: number;
}

// ============ SendMessage ============

export interface SendMessageReq {
  msg?: WeixinMessage;
}

export interface SendMessageResp {
  // 通常为空
}

// ============ SendTyping ============

export interface SendTypingReq {
  ilink_user_id?: string;
  typing_ticket?: string;
  /** 1=正在输入, 2=取消输入 */
  status?: number;
}

// ============ GetConfig ============

export interface GetConfigResp {
  ret?: number;
  errmsg?: string;
  /** typing ticket，用于 sendTyping */
  typing_ticket?: string;
}

// ============ 凭据存储 ============

export interface Credentials {
  bot_token: string;
  bot_id?: string;
  base_url: string;
  user_id?: string;
  created_at: string;
}
