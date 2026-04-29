/**
 * 扫码登录：写入 credentials.json
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { fetchQRCode, pollQRStatus } from './ilink.js';
import type { Credentials } from './types.js';
import { TEMPLATES_ROOT } from './config.js';

const require = createRequire(import.meta.url);
const qrcode = require('qrcode-terminal') as { generate: (text: string, opts: { small: boolean }, cb?: () => void) => void };

const CREDENTIALS_PATH = path.join(TEMPLATES_ROOT, 'credentials.json');
const FIXED_QR_BASE = 'https://ilinkai.weixin.qq.com';
const MAX_QR_REFRESH = 3;
const LOGIN_TIMEOUT_MS = 8 * 60 * 1000;

async function setup() {
  console.log('🔗 微信 ↔ Claude Agent SDK（Cursor 侧能力）桥接');
  console.log('='.repeat(45));
  console.log('');

  let refreshCount = 0;
  const startTime = Date.now();

  while (refreshCount <= MAX_QR_REFRESH) {
    console.log('📱 正在获取登录二维码...');
    const qrRes = await fetchQRCode(FIXED_QR_BASE);

    if (!qrRes.qrcode && !qrRes.qrcode_img_content) {
      console.error('❌ 获取二维码失败');
      process.exit(1);
    }

    const qrUrl = qrRes.qrcode_img_content || qrRes.qrcode;

    console.log('');
    console.log('📷 请用微信扫描以下二维码：');
    console.log('');
    qrcode.generate(qrUrl, { small: true });
    console.log('');
    console.log(`🔗 或直接在微信中打开: ${qrUrl}`);
    console.log('');
    console.log('⏳ 等待扫码确认...');

    let pollApiBase = FIXED_QR_BASE;
    let lastStatus = '';
    while (Date.now() - startTime < LOGIN_TIMEOUT_MS) {
      const statusRes = await pollQRStatus(qrRes.qrcode, pollApiBase);

      if (statusRes.status !== lastStatus) {
        lastStatus = statusRes.status;
        switch (statusRes.status) {
          case 'wait':
            break;
          case 'scaned':
            console.log('📱 已扫码，请在手机上确认...');
            break;
          case 'scaned_but_redirect': {
            const host = statusRes.redirect_host?.trim();
            if (host) {
              pollApiBase = host.startsWith('http') ? host : `https://${host}`;
              console.log(`🔄 IDC 重定向，轮询切换到: ${pollApiBase}`);
            } else {
              console.warn('⚠️ scaned_but_redirect 但未返回 redirect_host');
            }
            break;
          }
          case 'confirmed':
            console.log('');
            console.log('✅ 认证成功！');
            console.log(`   Bot ID: ${statusRes.ilink_bot_id || '(未返回)'}`);
            console.log(`   User ID: ${statusRes.ilink_user_id || '(未返回)'}`);
            console.log(`   Base URL: ${statusRes.baseurl || '(使用默认)'}`);

            const credentials: Credentials = {
              bot_token: statusRes.bot_token!,
              bot_id: statusRes.ilink_bot_id,
              base_url: statusRes.baseurl || 'https://ilinkai.weixin.qq.com',
              user_id: statusRes.ilink_user_id,
              created_at: new Date().toISOString(),
            };

            fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2), 'utf-8');
            console.log(`   凭据已保存到: ${CREDENTIALS_PATH}`);

            console.log('');
            console.log('🚀 复制 bridge.config.example.json 为 bridge.config.json 并编辑 cwd，然后运行 npm start');
            return;

          case 'expired':
            console.log('⏰ 二维码已过期');
            break;
        }
      }

      if (statusRes.status === 'expired') {
        break;
      }

      await sleep(1000);
    }

    refreshCount++;
    if (refreshCount <= MAX_QR_REFRESH) {
      console.log(`🔄 刷新二维码 (${refreshCount}/${MAX_QR_REFRESH})...`);
      console.log('');
    }
  }

  console.error('❌ 登录超时，请重试');
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

setup().catch(err => {
  console.error('❌ 启动失败:', err);
  process.exit(1);
});
