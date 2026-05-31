# AGENTS.md — AI Coding Agent 开发指南

## 项目概述

**AI 基金助理** (`ai-fund`) — 基于 LLM 的中国公募基金分析助手。支持 Discord Bot 和本地 CLI 两种交互方式，通过 Python + AKShare 获取基金数据，Node.js + OpenAI SDK 驱动 LLM agent 进行自然语言基金分析。

## 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| Agent 层 | TypeScript (ES2022, CommonJS) | LLM agent 调度、工具派发、对话管理 |
| API 入口 | Express 5 (Discord webhook) / readline (CLI) | 两种交互模式 |
| LLM | OpenAI SDK `openai` v4 | 兼容任意 OpenAI 接口（deepseek、moonshot 等） |
| 数据服务 | Python 3.11+ / FastAPI / AKShare | 基金行情、净值、持仓、评级数据 |
| 缓存 | Redis | Python 端 15min~24h TTL，按 key 缓存 DataFrame |
| 持久化 | MySQL 8+ | 用户档案、对话摘要（webhook 模式） / JSON 文件（CLI 模式） |
| Discord | discord.js v14 + Ed25519 签名验证 | Slash Command 交互 |
| OCR | 阿里云 OCR RecognizeAllText | 持仓截图识别 |
| 搜索 | 外部搜索 API | web_search 工具（可选） |
| 部署 | Docker Compose / PM2 + Nginx | 两种部署方式 |

## 目录结构

```
.
├── src/
│   ├── agents/
│   │   ├── executor.ts          # 核心：LLM agent 主循环，工具调用调度，内置指令路由
│   │   └── tools.ts             # 工具派发：dispatchTool() + getToolLabel()
│   ├── commands/
│   │   ├── help.ts              # /help 指令回复
│   │   ├── market.ts            # /market 指令 prompt
│   │   ├── my.ts                # /my 指令 - 展示持仓
│   │   └── new.ts               # /new 指令 - 新会话
│   ├── services/
│   │   ├── fund.ts              # 基金数据 API 客户端（调用 Python 数据服务）
│   │   ├── manager.ts           # 基金经理数据
│   │   ├── portfolio.ts         # 持仓组合分析：analyzePortfolio()
│   │   ├── ocr.ts               # OCR 调用
│   │   ├── user.ts              # 用户档案 CRUD（MySQL，webhook 模式）
│   │   ├── storage.ts           # 用户档案 CRUD（本地 JSON 文件，CLI 模式）
│   │   ├── db.ts                # MySQL 连接池（mysql2）
│   │   ├── redis.ts             # Redis 客户端（ioredis）
│   │   └── search.ts            # 网络搜索
│   ├── tools/
│   │   └── index.ts             # OpenAI function tool 定义（18 个工具）
│   ├── prompts/
│   │   ├── system.md            # 核心 system prompt（量化分析师角色）
│   │   ├── index.ts             # 加载 + 拼接 prompt 的工具函数
│   │   ├── portfolio.md         # 持仓分析 prompt
│   │   ├── my-holdings.md       # /my 命令 prompt
│   │   └── startup-summary.md   # 启动摘要 prompt
│   ├── history/
│   │   └── summary-history.ts   # 对话历史压缩（/new 时触发）
│   └── utils/
│       ├── config.ts            # 环境变量配置（dotenv）
│       ├── http.ts              # Axios 实例（akshare 数据服务）
│       └── logger.ts            # 结构化日志：[timestamp] [LEVEL] [tag] msg
├── packages/
│   ├── cli/
│   │   ├── index.ts             # CLI 入口：readline 交互循环 + spinner
│   │   └── prompts/output-format.md  # CLI 回复格式模板
│   └── discord/
│       ├── webhook-entry.ts     # Discord 入口：启动 webhook + gateway
│       ├── webhook.ts           # Express 服务，处理 /interactions
│       ├── gateway.ts           # Discord Gateway 连接
│       ├── verify.ts            # Ed25519 签名验证
│       ├── api.ts               # Discord REST API 封装
│       ├── history.ts           # 用户对话历史（Redis 缓存）
│       ├── register-commands.ts # 注册 Slash Command
│       └── prompts/output-format.md  # Discord 回复格式模板
├── server/
│   ├── main.py                  # FastAPI 数据服务（AKShare + 阿里云 OCR + Redis 缓存）
│   └── run.py                   # 快速启动入口
├── docker-compose.yml           # Docker 部署
├── Dockerfile                   # Node.js 容器
├── server/Dockerfile            # Python 容器
├── schema.sql                   # MySQL 建表语句
├── ecosystem.config.js          # PM2 进程配置
├── .env.example                 # 环境变量模板
├── tsconfig.json                # TypeScript 配置
└── package.json                 # npm 依赖和脚本
```

## 架构数据流

```
用户输入（CLI readline / Discord Slash Command）
        │
        ▼
  runAgent(userMessage)          ← executor.ts
        │
        ├─ 内置指令路由（/new /my /market /help）
        │
        ├─ 构建 messages：[system prompt + 用户档案] + history + user message
        │
        ▼
  LLM 推理循环（最多 15 轮）
        │
        ├─ 返回文本 → 结束，直接显示
        │
        └─ tool_calls → dispatchTool() 并行派发
                │
                ├─ 基金/经理/市场 → axios → Python FastAPI (AKShare)
                ├─ OCR           → axios → Python FastAPI (阿里云 OCR)
                ├─ 持仓分析      → 组合调用 fund.ts + portfolio.ts
                ├─ 用户档案      → MySQL（webhook）或 JSON 文件（CLI）
                └─ 网络搜索      → 外部搜索 API
                        │
                        ▼
              结果拼回 messages，下一轮推理
```

## 本地开发

### 必备依赖

- Node.js 20+
- Python 3.11+ / uv
- MySQL 8+ / Redis
- 阿里云 AccessKey（OCR 功能需要）

### 首次启动

```bash
npm install
cd server && uv sync && cd ..
cp .env.example .env          # 填写 LLM_API_KEY 等
mysql -u root -p < schema.sql  # 初始化数据库
```

### 开发命令

```bash
npm run server:dev  # Python 数据服务（8080 端口，热重载）
npm run dev         # CLI 模式（终端交互）
npm run webhook     # Discord webhook（3000 端口）
```

## 数据库迁移（Umzug）

迁移由 [Umzug](https://github.com/sequelize/umzug) 管理。迁移文件在 `migrations/` 目录下，按序号命名。

**工作方式**：
- `src/services/migrations.ts` 创建 Umzug 实例，用自定义 MySQL 存储（`_migrations` 表追踪已执行迁移）
- 首次读写 `conversation_summary` 列时，`user.ts` 中的 `loadSummaryFromDB()` / `saveSummaryToDB()` 自动调用 `runMigrations()`
- `runMigrations()` 只执行一次（`_applied` 标志位），检查待执行迁移并执行

**添加新迁移**：
```bash
# 1. 在 migrations/ 下新建文件，格式 002_xxx.ts
# 2. 实现 up() / down()
# 3. 在 src/services/migrations.ts 的 migrations 数组中添加导入
```

**迁移文件格式**：
```ts
import type { RunnableMigration } from 'umzug';
interface Ctx { db: { query(sql: string, params?: any[]): Promise<any> } }

export const myMigration: RunnableMigration<Ctx> = {
  name: '002_xxx',
  async up({ context: { db } }) { await db.query('ALTER TABLE ...'); },
  async down({ context: { db } }) { await db.query('ALTER TABLE ...'); },
};
```

### TypeScript 部分

1. **模块系统**: CommonJS（tsconfig target: ES2022，module: commonjs）
2. **编译输出**: `dist/`，构建脚本会将 `src/prompts/*.md` 复制到 `dist/` 对应位置
3. **路径引用**: packages/ 下的文件引用 src/ 使用相对路径，如 `../../src/agents/executor`
4. **日志**: 必须使用 `logger`（`src/utils/logger.ts`），格式为 `logger.info(tag, msg, extra?)`。tag 建议用 `agent:cli`、`agent:<userId>`、`cmd:cli`、`cmd:<userId>`
5. **错误处理**: 工具调用失败不中断整体流程，catch 后返回错误信息交给 LLM 自行处理
6. **环境变量**: 统一在 `src/utils/config.ts` 读取，禁止在其他文件直接 `process.env`

### Python 部分

1. **AKShare 调用**: 所有 AKShare 调用必须通过 `_run()` 放到线程池，避免阻塞 asyncio 事件循环
2. **缓存**: 使用 `_cached_run()` 自动缓存 DataFrame 到 Redis，TTL 由 `_TTL` 字典控制
3. **NaN 处理**: `_to_json()` 会将 NaN/Inf 转为 null
4. **依赖管理**: 使用 uv 管理，`uv pip install --upgrade akshare` 升级数据源

### Git 工作流

```bash
git checkout master && git pull
git checkout -b feature/<简短描述>
# 开发...
git checkout master && git merge <feature-branch> && git push
```

### 日志规范

开发时必须在关键逻辑中添加注释和日志。日志使用结构化格式：
```
[timestamp] [LEVEL] [tag] message {json}
```

## 工具（Function Calling）列表

Agent 可调用以下工具，定义在 `src/tools/index.ts`：

| 工具名 | 用途 | 数据源 |
|---|---|---|
| `get_fund_info` | 基金基本信息（名称、类型、净值快照） | AKShare fund_open_fund_daily_em |
| `get_fund_nav` | 净值历史走势 | AKShare fund_open_fund_info_em |
| `get_fund_manager` | 基金经理信息 | AKShare fund_manager_em |
| `get_fund_portfolio` | 持仓股票明细（按年） | AKShare fund_portfolio_hold_em |
| `get_fund_performance` | 多周期业绩+风险指标（首选） | AKShare（雪球） |
| `get_fund_profit_probability` | 历史持有盈利概率 | AKShare（雪球） |
| `get_fund_rating` | 第三方评级（1-5星） | AKShare fund_rating_all |
| `get_fund_asset_allocation` | 大类资产配置（按季） | AKShare（雪球） |
| `get_fund_industry_allocation` | 行业配置（按年） | AKShare fund_portfolio_industry_allocation_em |
| `get_fund_bond_portfolio` | 债券持仓（按年） | AKShare fund_portfolio_bond_hold_em |
| `get_fund_estimate` | 盘中实时估值 | AKShare fund_value_estimation_em |
| `get_market_index` | A股指数实时行情 | AKShare stock_zh_index_spot_em |
| `get_northbound_flow` | 北向资金流向 | AKShare stock_hsgt_fund_flow_summary_em |
| `get_sector_trend` | 行业板块K线 | AKShare stock_board_industry_hist_em |
| `read_image` | OCR 识别持仓截图 | 阿里云 OCR |
| `analyze_portfolio` | 多基金组合分析 | 组合调用 fund.ts |
| `get_user_profile` | 读取用户档案 | MySQL / JSON |
| `save_user_profile` | 保存用户档案 | MySQL / JSON |
| `web_search` | 网络搜索（可选） | SEARCH_BASE_URL |

**限制**:
- Agent 循环上限 15 轮
- web_search 上限 5 次/对话

## 常见开发任务

### 添加新工具

1. 在 `src/tools/index.ts` 的 `baseTools` 或 `marketTools` 数组中添加 tool 定义
2. 在 `src/agents/tools.ts` 的 `dispatchTool()` 和 `getToolLabel()` 中添加 case
3. 如需新的 Python 数据接口，在 `server/main.py` 中新增路由
4. 在 `src/services/` 下如果数据源不同，新建或复用 API 客户端

### 修改 System Prompt

编辑 `src/prompts/system.md`。注意构建时会把 `dist/` 下的复制过去，所以用 `npm run build` 重新构建。

### 添加内置指令

1. 在 `src/commands/` 下创建指令文件
2. 在 `src/agents/executor.ts` 的 `handleBuiltinCommand()` 中添加 case

### 运行测试

项目当前无测试框架。添加测试需要：
- 创建 `__tests__/` 目录或 `*.test.ts` 文件
- 安装 vitest 或 jest（TypeScript 测试）

## 踩坑记录

- **AKShare 限流**: 不要频繁调用，缓存 TTL 已配置合理值，不要在没缓存覆盖的端点短时间反复调用
- **端口占用**: Python 用 8080，Node.js 用 3000，注意不要冲突
- **Python 依赖**: AKShare 版本更新快，定期 `uv pip install --upgrade akshare`
- **Docker 构建**: Dockerfile 中预安装了 akshare，如果 `docker compose build` 太慢是因为 akshare 依赖多，耐心等待
- **OCR 限制**: 阿里云 OCR 单边最大 8192px，超出会自动等比压缩
- **web_search**: 仅当环境变量 `SEARCH_BASE_URL` 和 `SEARCH_API_KEY` 都配置时才会注册该工具
- **用户档案两套存储**: webhook 模式用 MySQL（传入 userId），CLI 模式用本地 JSON 文件（`src/services/storage.ts`），不要混用
- **.env 加载**: Python 从 `../.env` 加载，Node.js 从项目根 `.env` 加载；Docker 中通过 env_file 注入，不需要手动 load_dotenv
- **上下文溢出防护**: agent 循环每轮自动 `estimateTokens()` 估算上下文，超过 85 万 token 时触发 `trimContext()`，裁剪最旧的 tool 结果（数组保留前 5 条，长字段截断到 300 字符）。日志输出裁剪前后 token 数
- **数据库自动迁移**: `src/services/migrations.ts` 的 `runMigrations()` 在首次读写 `conversation_summary` 时自动执行。迁移状态记录在 `_migrations` 表中，umzug 管理版本追踪和回滚
- **全球指数数据源**: 主源 yfinance（美股+港股+日股+欧股），回退源 AKShare（东方财富）。yfinance 需要网络通畅，数据延迟 15-20 分钟。
- **黄金ETF 首次调用慢**: `ak.fund_etf_spot_em()` 需下载全量约 1500 只 ETF（约 40s），之后筛选黄金类。后续可考虑在 agent 层面缓存或定时预热。

## 已知问题

| 问题 | 影响 | 原因 | 计划 |
|---|---|---|---|
| TypeScript 编译报 umzug 错误 | 本地 `npm run build` 失败，Docker 构建正常 | `umzug` 模块未安装（仅在 Docker 中通过 pnpm 安装） | 低优先级，不影响部署 |
| `/fund/achievement` 500 | 雪球业绩数据不可用 | AKShare 雪球 API 上游问题 | 等 AKShare 升级后恢复 |
| 全球指数无实时数据 | yfinance 延迟 15-20 分钟 | Yahoo Finance 免费 API 限制 | 可接受，非交易场景够用 |
| `_to_json` 对 object-dtype Timestamp 需特殊处理 | 含时间戳列的 DataFrame 序列化失败 | pandas DataFrame 中混合类型列 | 已修复 `server/main.py:86-98`，新增 object-dtype Timestamp 检测 |

## 未来计划

### 短期（1-2 周）
- [ ] **定时预热黄金ETF缓存**: cron job 每天 8:50 调用 gold_etf 端点，确保盘中查询秒回
- [ ] **全球指数缓存**: 对 global_index 加 Redis 缓存（TTL 5min），避免每次 LLM 调用都请求 yfinance
- [ ] **修复 TypeScript 本地编译**: 安装 umzug 到 devDependencies 或调整 tsconfig 排除 migrations 目录

### 中期（1 个月）
- [ ] **再平衡定时提醒**: cron job 每周一检查用户持仓偏离度，自动推送 Discord
- [ ] **`set_financial_goal` 端到端验证**: 在 Discord 中测试目标设定→配置方案→再平衡全流程
- [ ] **`check_rebalance` 资产分类自动推断**: agent 根据基金类型字段自动归类为 stock/bond/QDII/gold，减少用户手动指定 asset_class
- [ ] **多目标支持**: 用户可出现多个财务目标（如"买房首付"+"子女教育"），各自独立配置

### 长期（3+ 个月）
- [ ] **收益跟踪**: 记录用户持仓净值历史，展示组合累计收益曲线
- [ ] **智能定投**: 根据市场估值（PE/PB 分位数）动态调整定投金额
- [ ] **税务优化提示**: 提醒持有满 1 年享受免税、利用养老金账户等
- [ ] **多用户支持**: 一个 Discord 服务器内多用户各自独立档案和目标

