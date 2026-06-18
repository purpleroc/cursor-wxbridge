/**
 * 企业微信智能机器人凭据加载。
 *
 * 凭据来源优先级：环境变量 > credentials.json。
 * 严禁在代码中硬编码 botId / secret，必须从安全配置源读取。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { TEMPLATES_ROOT } from './config.js';

export const CREDENTIALS_PATH = path.join(TEMPLATES_ROOT, 'credentials.json');

export interface WecomCredentials {
  /** 机器人 ID（企业微信管理后台 - 智能机器人获取） */
  botId: string;
  /** 机器人 Secret（企业微信管理后台 - 智能机器人获取） */
  secret: string;
  /** 自定义长连接地址（私有部署填写），留空走 SDK 默认 wss://openws.work.weixin.qq.com */
  wsUrl?: string;
  /** 私有部署自签证书路径（可选，配合 wsUrl 使用） */
  caPath?: string;
}

interface RawCredentialsFile {
  botId?: string;
  secret?: string;
  wsUrl?: string;
  caPath?: string;
}

function readCredentialsFile(): RawCredentialsFile {
  if (!fs.existsSync(CREDENTIALS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8')) as RawCredentialsFile;
  } catch (e) {
    console.error('[credentials] 解析 credentials.json 失败:', e);
    return {};
  }
}

/**
 * 加载凭据：环境变量优先，其次 credentials.json。
 * 缺少 botId / secret 时抛错。
 */
export function loadCredentials(): WecomCredentials {
  const file = readCredentialsFile();

  const botId = (process.env.WECOM_AIBOT_ID ?? file.botId ?? '').trim();
  const secret = (process.env.WECOM_AIBOT_SECRET ?? file.secret ?? '').trim();
  const wsUrl = (process.env.WECOM_WS_URL ?? file.wsUrl ?? '').trim();
  const caPath = (process.env.WECOM_WS_CA_PATH ?? file.caPath ?? '').trim();

  if (!botId || !secret) {
    throw new Error(
      '缺少企业微信机器人凭据。请运行 `npm run setup` 录入，或设置环境变量 ' +
        'WECOM_AIBOT_ID / WECOM_AIBOT_SECRET，或在 credentials.json 中填写 botId / secret。',
    );
  }

  return {
    botId,
    secret,
    wsUrl: wsUrl || undefined,
    caPath: caPath || undefined,
  };
}

/** 将凭据写入 credentials.json（setup 使用） */
export function saveCredentials(cred: WecomCredentials): void {
  const out: RawCredentialsFile = {
    botId: cred.botId,
    secret: cred.secret,
  };
  if (cred.wsUrl) out.wsUrl = cred.wsUrl;
  if (cred.caPath) out.caPath = cred.caPath;
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(out, null, 2) + '\n', 'utf-8');
}
