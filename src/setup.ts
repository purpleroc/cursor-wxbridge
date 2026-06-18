/**
 * 交互式录入企业微信智能机器人凭据，写入 credentials.json。
 *
 * botId / secret 在企业微信管理后台「智能机器人」配置页获取。
 * 私有部署可填写自定义长连接地址 wsUrl 与自签证书路径 caPath。
 */

import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { saveCredentials, loadCredentials, CREDENTIALS_PATH, type WecomCredentials } from './credentials.js';
import { createWecomClient } from './wecom.js';

async function ask(rl: readline.Interface, question: string, fallback = ''): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : '';
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || fallback;
}

/** 尝试建立连接以验证凭据，超时或断开返回 false */
function verifyCredentials(cred: WecomCredentials, timeoutMs = 12_000): Promise<boolean> {
  return new Promise((resolve) => {
    const client = createWecomClient(cred, false);
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { client.disconnect(); } catch {}
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    client.on('authenticated', () => finish(true));
    client.on('error', () => {});
    client.connect();
  });
}

async function setup() {
  console.log('🔗 企业微信智能机器人 ↔ Cursor Agent 桥接 — 凭据配置');
  console.log('='.repeat(50));
  console.log('在企业微信管理后台「智能机器人」页面获取 botId 与 secret。');
  console.log('');

  let existing: Partial<WecomCredentials> = {};
  try {
    existing = loadCredentials();
    console.log('（检测到已有 credentials.json，直接回车保留原值）\n');
  } catch {
    // 无现有凭据，正常流程
  }

  const rl = readline.createInterface({ input, output });
  try {
    const botId = await ask(rl, '机器人 botId', existing.botId ?? '');
    const secret = await ask(rl, '机器人 secret', existing.secret ?? '');
    if (!botId || !secret) {
      console.error('❌ botId 和 secret 不能为空。');
      process.exit(1);
    }
    const wsUrl = await ask(rl, '自定义长连接地址 wsUrl（私有部署填写，公有云直接回车）', existing.wsUrl ?? '');
    const caPath = wsUrl
      ? await ask(rl, '自签证书路径 caPath（无则回车）', existing.caPath ?? '')
      : '';

    const cred: WecomCredentials = {
      botId,
      secret,
      wsUrl: wsUrl || undefined,
      caPath: caPath || undefined,
    };

    saveCredentials(cred);
    console.log(`\n✅ 凭据已保存到: ${CREDENTIALS_PATH}`);

    const doVerify = (await ask(rl, '是否立即测试连接？(y/N)', 'N')).toLowerCase();
    if (doVerify === 'y' || doVerify === 'yes') {
      console.log('⏳ 正在尝试连接并认证…');
      const ok = await verifyCredentials(cred);
      console.log(ok ? '✅ 连接认证成功！' : '⚠️ 未能在超时内完成认证，请检查 botId/secret 或网络后重试。');
    }

    console.log('\n🚀 复制 bridge.config.example.json 为 bridge.config.json 并设置 cwd，然后运行 npm start');
  } finally {
    rl.close();
  }
}

setup().catch(err => {
  console.error('❌ 配置失败:', err);
  process.exit(1);
});
