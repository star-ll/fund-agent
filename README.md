# AI 基金助理

基于 LLM 的基金分析助手，支持 Discord 和本地 CLI 两种使用方式。用户可以通过自然语言查询基金信息、分析持仓组合、识别持仓截图，AI 会自动调用相关工具完成分析并回复。

## 功能

- **基金查询**：基本信息、净值历史、年化收益、最大回撤、夏普比率等量化指标
- **基金经理**：从业年限、管理规模、历史最佳回报
- **持仓分析**：多只基金组合的整体收益、回撤、波动率
- **OCR 识别**：上传持仓截图，自动提取基金代码和份额，直接进行分析
- **用户档案**：记录持仓、风险偏好、投资年限等信息，支持跨对话记忆
- **Discord 集成**：通过 `/ask` Slash Command 接收消息，异步处理后回复

## 架构

```
Discord / CLI
     │
     ▼
Node.js Webhook (port 3000)   ←→   MySQL（用户档案、持仓）
     │                         ←→   Redis（对话历史缓存）
     ▼
LLM（OpenAI 兼容接口）
     │ tool calls
     ▼
Python AKShare Server (port 8080)   ←  基金数据 + 阿里云 OCR
```

## 目录结构

```
.
├── src/
│   ├── agents/executor.ts      # LLM agent，工具调度
│   ├── services/
│   │   ├── db.ts               # MySQL 连接池
│   │   ├── redis.ts            # Redis 客户端
│   │   ├── user.ts             # 用户档案读写（webhook 模式）
│   │   ├── storage.ts          # 用户档案读写（CLI 模式，本地文件）
│   │   ├── fund.ts             # 基金数据
│   │   ├── manager.ts          # 基金经理数据
│   │   ├── portfolio.ts        # 持仓分析
│   │   └── ocr.ts              # OCR 调用
│   ├── discord/
│   │   ├── verify.ts           # Ed25519 签名验证
│   │   └── api.ts              # Discord followup 消息发送
│   ├── tools/index.ts          # LLM tool 定义
│   ├── prompts/                # system prompt
│   ├── webhook.ts              # Express 服务（Discord 模式）
│   ├── webhook-entry.ts        # webhook 入口
│   └── index.ts                # CLI 入口
├── server/
│   └── main.py                 # FastAPI，封装 AKShare + 阿里云 OCR
├── schema.sql                  # 数据库建表语句
├── ecosystem.config.js         # PM2 进程配置
└── .env.example                # 环境变量模板
```

## 本地开发

**依赖：** Node.js 20+、Python 3.11+、uv、MySQL 8+、Redis

```bash
# 安装 Node 依赖
npm install

# 安装 Python 依赖
cd server && uv sync && cd ..

# 复制并填写环境变量
cp .env.example .env

# 初始化数据库（首次）
mysql -u root -p < schema.sql

# 启动 Python 数据服务
npm run server:dev

# 启动 Discord webhook（另一个终端）
npm run webhook

# 或者使用 CLI 模式
npm run dev
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `LLM_BASE_URL` | OpenAI 兼容接口地址 |
| `LLM_API_KEY` | API Key |
| `LLM_MODEL` | 模型名称，如 `gpt-4o` |
| `AKSHARE_BASE_URL` | Python 数据服务地址，默认 `http://localhost:8080` |
| `ALIYUN_ACCESS_KEY_ID` | 阿里云 AccessKey（OCR 功能） |
| `ALIYUN_ACCESS_KEY_SECRET` | 阿里云 AccessSecret |
| `DISCORD_PUBLIC_KEY` | Discord 应用 Public Key（General Information 页） |
| `DISCORD_APP_ID` | Discord 应用 ID |
| `DISCORD_BOT_TOKEN` | Discord Bot Token |
| `MYSQL_HOST` | MySQL 主机 |
| `MYSQL_PORT` | MySQL 端口，默认 3306 |
| `MYSQL_USER` | MySQL 用户名 |
| `MYSQL_PASSWORD` | MySQL 密码 |
| `MYSQL_DATABASE` | 数据库名，默认 `ai_fund` |
| `REDIS_HOST` | Redis 主机，默认 `localhost` |
| `REDIS_PORT` | Redis 端口，默认 6379 |
| `REDIS_PASSWORD` | Redis 密码（可选） |
| `PORT` | HTTP 服务端口，默认 3000 |

## 部署

详见 [docs/deployment.md](docs/deployment.md)，包含 Docker 和 PM2 两种方式，以及 Discord 配置步骤。
