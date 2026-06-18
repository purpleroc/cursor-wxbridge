# wecom-cursor-agent-bridge

企业微信智能机器人 ↔ Cursor Agent CLI 桥接服务。在企业微信里直接与本地 Cursor Agent 对话，支持文字、图片、文件交互。

> 通道基于 [@wecom/aibot-node-sdk](https://www.npmjs.com/package/@wecom/aibot-node-sdk)（WebSocket 长连接）。本分支由个人微信版（ilink）改造而来，专注企业微信智能机器人，旧版以 `main` 分支为准。

## 交互模型

- **WebSocket 长连接**：SDK 内置 `wss://openws.work.weixin.qq.com`，连接后自动认证（botId + secret），断线指数退避重连
- **混合回复**：收到消息后用被动流式 `replyStream` 立即回执"处理中"；中间进度与最终回答统一用主动推送 `sendMessage(userid)` 送达（Cursor 任务常需数分钟~数十分钟，远超被动回复时效窗口）
- **仅单聊**：会话 key = `userid`

## 功能特性

- **追问融入**：Agent 忙时发送的消息自动进入追问缓冲区，任务完成后通过 `--resume` 在同一会话上下文中处理
- **独立排队**：`/排队` 前缀将消息作为独立任务排队，与追问机制互不干扰
- **危险命令拦截**：匹配 `rm`/`sudo` 等模式的 shell 命令会暂停执行，通过企业微信确认后才继续；关键操作（如 `rm -rf`）拒绝时直接终止 Agent
- **思考过程推送**：`showToolCalls` 开启时，Agent 完成后先发送格式化的推理链路摘要（含敏感信息脱敏），再发最终回答
- **模型热切换**：通过 `/model <slug>` 命令实时切换模型，写回配置文件持久化
- **Token 用量与费用估算**：最终回答末尾附带 token 消耗统计和按模型费率计算的美元成本
- **会话续接**：30 分钟内的消息自动复用上一次 session，保持对话连贯性

## 快速启动

### 前置条件

- **Node.js 18+**（`node -v` 确认）
- **Cursor CLI**：`curl https://cursor.com/install -fsSL | bash`，安装后 `agent --version` 确认可用
- 远程无桌面服务器需设置 `CURSOR_API_KEY` 环境变量
- **企业微信智能机器人**：在企业微信管理后台「智能机器人」页面创建机器人，获取 `botId` 与 `secret`

### 安装与配置

```bash
npm install
cp bridge.config.example.json bridge.config.json
```

编辑 `bridge.config.json`，至少设置 `cwd` 为你希望 Agent 操作的项目目录。

### 录入企业微信凭据

```bash
npm run setup
```

按提示录入 `botId` / `secret`（私有部署可填 `wsUrl` 与自签证书 `caPath`），生成 `credentials.json`。
也可改用环境变量 `WECOM_AIBOT_ID` / `WECOM_AIBOT_SECRET`（优先级高于文件）。

### 启动

```bash
npm start

# 或后台运行
nohup npm start >> wx.log 2>&1 & disown
```

## 企业微信交互命令

| 命令 | 说明 |
|------|------|
| `/help` | 查看帮助 |
| `/clear` | 清空会话 + 队列 + 追问 |
| `/stop` | 终止当前任务，继续处理队列 |
| `/stopall` | 终止当前任务并清空所有队列和追问 |
| `/send <路径>` | 发送服务器上的文件到企业微信 |
| `/model` | 查看当前模型及子命令 |
| `/model list` | 列出全部可用模型 |
| `/model search <关键词>` | 模糊搜索模型 |
| `/model <slug>` | 切换模型（写回配置，下轮生效） |
| `/cwd <路径>` | 查看/切换 workspace 目录 |
| `/排队 <消息>` | 作为独立任务排队，不融入当前对话 |

直接发文字或图片即交由 Agent 处理。Agent 忙时发送的消息默认作为追问，任务完成后在同一对话上下文中处理。

## 配置说明

### bridge.config.json

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `cwd` | 项目目录 | Agent 工作目录 |
| `agentPath` | `"agent"` | Cursor CLI 路径 |
| `model` | `""` | 模型 slug，留空用 Cursor 默认 |
| `force` | `true` | Agent 自动执行所有工具，无需逐个确认 |
| `agentTimeoutMs` | `1800000` | 单次请求最长运行时间（30 分钟） |
| `maxMessageLength` | `4000` | 单条消息最大长度，超长自动分段 |
| `enableSession` | `true` | 启用会话续接 |
| `sessionTimeoutMs` | `1800000` | 会话续接超时（30 分钟） |
| `sendThinkingHint` | `true` | 收到消息后立即回复"处理中"提示 |
| `thinkingHintText` | `"✅ 已收到，正在处理..."` | 即时回执文案 |
| `welcomeText` | 见示例 | 用户当天首次进入会话（enter_chat）时的欢迎语，留空不发 |
| `showToolCalls` | `false` | 完成后推送思考过程摘要 |
| `showTokenUsage` | `true` | 最终回答末尾附加 token 消耗和费用统计 |
| `dangerousCommandPatterns` | `["\\brm\\b", ...]` | 危险命令正则，匹配后暂停并企业微信确认 |
| `criticalCommandPatterns` | `["\\brm\\s+-r...", ...]` | 关键命令正则，拒绝时终止 Agent |
| `allowedUserIds` | `[]` | 允许使用的企业微信 userid 白名单（空 = 不限制） |
| `replyAllowedUserIds` | `[]` | 允许触发 Agent 的 userid 白名单（空 = 不限制） |

### credentials.json / 环境变量

| 字段 | 环境变量 | 说明 |
|------|----------|------|
| `botId` | `WECOM_AIBOT_ID` | 机器人 ID |
| `secret` | `WECOM_AIBOT_SECRET` | 机器人 Secret |
| `wsUrl` | `WECOM_WS_URL` | 自定义长连接地址（私有部署，可选） |
| `caPath` | `WECOM_WS_CA_PATH` | 自签证书路径（私有部署，可选） |

## 文件说明

| 文件 | 说明 |
|------|------|
| `bridge.config.json` | 运行时配置 |
| `credentials.json` | 企业微信机器人凭据（勿泄露，已在 `.gitignore`） |
| `bridge-state.json` | 运行时状态：会话记录（自动生成） |

## 安全注意

- `force: true` 下 Agent 会自动执行读写文件、运行命令等操作
- `dangerousCommandPatterns` 提供了一层拦截保护，关键操作需企业微信端确认
- `credentials.json` 包含机器人凭据，已在 `.gitignore` 中排除；切勿硬编码到代码中
- 思考过程推送会自动脱敏 shell 命令中的密码参数
