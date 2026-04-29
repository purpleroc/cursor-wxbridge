# cursor-wxbridge

微信 ↔ Cursor Agent CLI 桥接服务。在微信里直接与本地 Cursor Agent 对话，支持文字、图片、文件交互。

> **致谢**：项目功能来自 [wechat_agent_bridge_skills](https://github.com/kaixindelele/wechat_agent_bridge_skills)。本项目只是抽离了 wxbridge 部分，并在交互体验上做了一些优化。

## 本项目在原版基础上的优化

- **追问融入**：Agent 忙时发送的消息自动进入追问缓冲区，任务完成后通过 `--resume` 在同一会话上下文中处理，无需重复发起
- **独立排队**：`/排队` 前缀将消息作为独立任务排队，与追问机制互不干扰
- **危险命令拦截**：匹配 `rm`/`sudo` 等模式的 shell 命令会暂停执行，通过微信确认后才继续；关键操作（如 `rm -rf`）拒绝时直接终止 Agent
- **思考过程推送**：`showToolCalls` 开启时，Agent 完成后先发送格式化的推理链路摘要（含敏感信息脱敏），再发最终回答，方便检查意图识别是否正确
- **模型热切换**：通过 `/model <slug>` 命令在微信端实时切换模型，支持列表查看、模糊搜索、强制切换，写回配置文件持久化
- **Token 用量与费用估算**：最终回答末尾附带 token 消耗统计和按模型费率计算的美元成本
- **会话续接**：30 分钟内的消息自动复用上一次 session，保持对话连贯性

## 快速启动

### 前置条件

- **Node.js 18+**（`node -v` 确认）
- **Cursor CLI**：`curl https://cursor.com/install -fsSL | bash`，安装后 `agent --version` 确认可用
- 远程无桌面服务器需设置 `CURSOR_API_KEY` 环境变量

### 安装与配置

```bash
npm install
cp bridge.config.example.json bridge.config.json
```

编辑 `bridge.config.json`，至少设置 `cwd` 为你希望 Agent 操作的项目目录。

### 扫码绑定微信（仅首次）

```bash
npm run setup
```

用微信扫描终端二维码，确认后生成 `credentials.json`。

### 启动

```bash
npm start

# 或后台运行
nohup npm start >> wx.log 2>&1 & disown
```

## 微信交互命令

| 命令 | 说明 |
|------|------|
| `/help` | 查看帮助 |
| `/clear` | 清空会话 + 队列 + 追问 |
| `/stop` | 终止当前任务，继续处理队列 |
| `/stopall` | 终止当前任务并清空所有队列和追问 |
| `/send <路径>` | 发送服务器上的文件到微信 |
| `/model` | 查看当前模型及子命令 |
| `/model list` | 列出全部可用模型 |
| `/model search <关键词>` | 模糊搜索模型 |
| `/model <slug>` | 切换模型（写回配置，下轮生效） |
| `/cwd <路径>` | 查看/切换workspace目录，用于在不同目录下 |
| `/排队 <消息>` | 作为独立任务排队，不融入当前对话 |

直接发文字或图片即交由 Agent 处理。Agent 忙时发送的消息默认作为追问，任务完成后在同一对话上下文中处理。

## 配置说明

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `cwd` | 项目目录 | Agent 工作目录 |
| `agentPath` | `"agent"` | Cursor CLI 路径 |
| `model` | `""` | 模型 slug，留空用 Cursor 默认 |
| `force` | `true` | Agent 自动执行所有工具，无需逐个确认 |
| `agentTimeoutMs` | `1800000` | 单次请求最长运行时间（30 分钟） |
| `maxMessageLength` | `4000` | 微信单条消息最大长度，超长自动分段 |
| `enableSession` | `true` | 启用会话续接 |
| `sessionTimeoutMs` | `1800000` | 会话续接超时（30 分钟） |
| `sendThinkingHint` | `true` | 收到消息后立即回复"处理中"提示 |
| `showToolCalls` | `false` | 完成后推送思考过程摘要到微信 |
| `showTokenUsage` | `true` | 最终回答末尾附加 token 消耗和费用统计 |
| `dangerousCommandPatterns` | `["\\brm\\b", ...]` | 危险命令正则，匹配后暂停并微信确认 |
| `criticalCommandPatterns` | `["\\brm\\s+-r...", ...]` | 关键命令正则，拒绝时终止 Agent |
| `allowedUserIds` | `[]` | 允许使用的微信用户 ID 白名单（空 = 不限制） |

## 文件说明

| 文件 | 说明 |
|------|------|
| `bridge.config.json` | 运行时配置 |
| `credentials.json` | 微信登录凭据（扫码生成，勿泄露） |
| `bridge-state.json` | 运行时状态：消息游标、会话记录（自动生成） |

## 安全注意

- `force: true` 下 Agent 会自动执行读写文件、运行命令等操作
- `dangerousCommandPatterns` 提供了一层拦截保护，关键操作需微信端确认
- `credentials.json` 包含微信绑定凭据，已在 `.gitignore` 中排除
- 思考过程推送会自动脱敏 shell 命令中的密码参数
