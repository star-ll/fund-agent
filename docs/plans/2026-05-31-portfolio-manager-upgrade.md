# AI 投资组合管家 升级计划

> **For Hermes:** 逐任务实现，每完成一个任务就标记完成。修改前先读目标文件。

**目标:** 将 FundAgent 从「基金分析师」升级为「AI 投资组合管家」——能用目标倒推资产配置、覆盖全球指数、自动检测偏离度并建议再平衡。

**架构:** 在现有 agent+AKShare+MySQL+Redis 基础上，新增 3 个 Python 路由（全球指数/黄金ETF）、2 个 TS 服务（全球市场数据、资产配置引擎）、4 个新工具、扩展用户档案（财务目标）、重写 system prompt。

**不变的部分:** LLM agent 主循环(`executor.ts`)、工具派发骨架(`tools.ts`)、OCR/搜索/Discord 交互、Docker Compose 部署、数据库基础设施。

---

## Phase 1: 数据层 — 全球资产数据

### Task 1: Python 端新增全球指数路由

**目标:** 为 AKShare 的全球指数接口创建 API 端点。

**文件:**
- 修改: `server/main.py`（在 `/market/northbound` 之后插入新路由）

**操作:**

在 `server/main.py` 中，找到 `# 市场行情：北向资金净流入汇总` 区域（约 289 行），在其后添加以下两个路由：

```python
# ---------------------------------------------------------------------------
# 全球指数（AKShare：标普500、纳斯达克、恒生、日经等）
# ---------------------------------------------------------------------------

@app.get("/market/global_index")
async def market_global_index():
    """获取全球主要指数最新行情（标普500、纳斯达克、恒生、日经等）。"""
    try:
        df = await _run(ak.index_global_spot_em)
        if df.empty:
            return []
        return _to_json(df)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# 黄金 ETF（AKShare：国内黄金 ETF 行情）
# ---------------------------------------------------------------------------

@app.get("/fund/gold_etf")
async def fund_gold_etf():
    """获取国内黄金 ETF 实时行情。"""
    try:
        df = await _cached_run("gold_etf", "fund_estimate", ak.fund_etf_spot_em)
        if df.empty:
            return []
        # 筛选出黄金类 ETF（名称含"金"或"黄金"）
        mask = df["名称"].str.contains("金|黄金", na=False)
        gold = df[mask]
        return _to_json(gold) if not gold.empty else _to_json(df.head(50))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
```

**验证:** 重启 Python 服务后 `curl http://localhost:8080/market/global_index | head` 返回标普500等指数数据。

---

### Task 2: TypeScript 端新增全球数据 API 客户端

**目标:** 为新增的 Python 路由创建 TypeScript 调用函数。

**文件:**
- 创建: `src/services/global.ts`

**操作:** 创建文件，内容如下：

```typescript
import { akshareClient } from '../utils/http';

export interface GlobalIndex {
  名称: string;
  最新价: string;
  涨跌幅: string;
  开盘价?: string;
  最高价?: string;
  最低价?: string;
  日期?: string;
}

export interface GoldETF {
  基金代码: string;
  基金名称?: string;
  名称?: string;
  最新价?: string;
  涨跌幅?: string;
}

export async function getGlobalIndex(): Promise<GlobalIndex[]> {
  const { data } = await akshareClient.get<GlobalIndex[]>('/market/global_index');
  return data;
}

export async function getGoldETF(): Promise<GoldETF[]> {
  const { data } = await akshareClient.get<GoldETF[]>('/fund/gold_etf');
  return data;
}
```

**验证:** TypeScript 编译通过（后续 task 中验证）。

---

## Phase 2: 核心引擎 — 资产配置与再平衡

### Task 3: 资产配置引擎

**目标:** 纯计算模块，根据用户目标 + 风险偏好输出建议配置比例。

**文件:**
- 创建: `src/services/allocation.ts`

**操作:** 创建文件：

```typescript
// 资产配置模型 — 根据用户财务目标倒推建议配置

export interface AllocationTarget {
  assetClass: string;      // "股票型基金" | "混合型基金" | "债券型基金" | "QDII" | "黄金ETF" | "货币基金"
  targetRatio: number;     // 0-1 之间的目标权重
  examples: string[];      // 示例基金类型/代码（供 agent 搜索）
}

export interface GoalInput {
  monthlyInvestment: number;   // 月投入（元）
  targetAmount: number;         // 目标金额（元）
  yearsToTarget: number;        // 距离目标年数
  riskLevel: 'low' | 'medium' | 'high';
}

export interface AllocationPlan {
  requiredAnnualReturn: number;  // 需要的年化收益率
  isRealistic: boolean;          // 目标是否可行（年化 < 30% 为可行）
  targets: AllocationTarget[];
  rationale: string;             // 配置逻辑说明
}

// 风险 × 期限 → 核心资产配比
const ALLOCATION_MATRIX: Record<string, AllocationTarget[]> = {
  // 保守型
  'low_short': [  // <3年
    { assetClass: '债券型基金', targetRatio: 0.60, examples: ['纯债', '中短债'] },
    { assetClass: '货币基金', targetRatio: 0.25, examples: ['货币型'] },
    { assetClass: '混合型基金', targetRatio: 0.10, examples: ['偏债混合', '固收+'] },
    { assetClass: '股票型基金', targetRatio: 0.05, examples: ['宽基指数'] },
  ],
  'low_mid': [    // 3-5年
    { assetClass: '债券型基金', targetRatio: 0.50, examples: ['纯债', '中短债'] },
    { assetClass: '混合型基金', targetRatio: 0.25, examples: ['偏债混合', '固收+'] },
    { assetClass: '股票型基金', targetRatio: 0.15, examples: ['沪深300指数', '宽基指数'] },
    { assetClass: '货币基金', targetRatio: 0.10, examples: ['货币型'] },
  ],
  'low_long': [   // >5年
    { assetClass: '债券型基金', targetRatio: 0.40, examples: ['纯债'] },
    { assetClass: '混合型基金', targetRatio: 0.30, examples: ['偏债混合', '固收+'] },
    { assetClass: '股票型基金', targetRatio: 0.20, examples: ['沪深300指数', '宽基指数'] },
    { assetClass: 'QDII', targetRatio: 0.10, examples: ['标普500', '纳斯达克'] },
  ],
  // 稳健型
  'medium_short': [
    { assetClass: '混合型基金', targetRatio: 0.40, examples: ['偏债混合', '灵活配置'] },
    { assetClass: '债券型基金', targetRatio: 0.30, examples: ['纯债'] },
    { assetClass: '股票型基金', targetRatio: 0.20, examples: ['沪深300指数', '宽基指数'] },
    { assetClass: '货币基金', targetRatio: 0.10, examples: ['货币型'] },
  ],
  'medium_mid': [
    { assetClass: '混合型基金', targetRatio: 0.35, examples: ['灵活配置', '偏股混合'] },
    { assetClass: '股票型基金', targetRatio: 0.30, examples: ['宽基指数', '行业指数'] },
    { assetClass: '债券型基金', targetRatio: 0.20, examples: ['纯债'] },
    { assetClass: 'QDII', targetRatio: 0.10, examples: ['标普500'] },
    { assetClass: '黄金ETF', targetRatio: 0.05, examples: ['黄金ETF'] },
  ],
  'medium_long': [
    { assetClass: '股票型基金', targetRatio: 0.40, examples: ['宽基指数', '行业指数'] },
    { assetClass: '混合型基金', targetRatio: 0.25, examples: ['灵活配置', '偏股混合'] },
    { assetClass: '债券型基金', targetRatio: 0.15, examples: ['纯债'] },
    { assetClass: 'QDII', targetRatio: 0.15, examples: ['标普500', '纳斯达克'] },
    { assetClass: '黄金ETF', targetRatio: 0.05, examples: ['黄金ETF'] },
  ],
  // 积极型
  'high_short': [
    { assetClass: '股票型基金', targetRatio: 0.45, examples: ['宽基指数', '行业指数'] },
    { assetClass: '混合型基金', targetRatio: 0.30, examples: ['灵活配置', '偏股混合'] },
    { assetClass: '债券型基金', targetRatio: 0.15, examples: ['纯债'] },
    { assetClass: '黄金ETF', targetRatio: 0.10, examples: ['黄金ETF'] },
  ],
  'high_mid': [
    { assetClass: '股票型基金', targetRatio: 0.55, examples: ['宽基指数', '行业指数', '主动股基'] },
    { assetClass: '混合型基金', targetRatio: 0.20, examples: ['偏股混合'] },
    { assetClass: 'QDII', targetRatio: 0.15, examples: ['标普500', '纳斯达克'] },
    { assetClass: '黄金ETF', targetRatio: 0.10, examples: ['黄金ETF'] },
  ],
  'high_long': [
    { assetClass: '股票型基金', targetRatio: 0.55, examples: ['宽基指数', '行业指数', '主动股基'] },
    { assetClass: 'QDII', targetRatio: 0.25, examples: ['标普500', '纳斯达克', '全球科技'] },
    { assetClass: '混合型基金', targetRatio: 0.10, examples: ['偏股混合'] },
    { assetClass: '黄金ETF', targetRatio: 0.10, examples: ['黄金ETF'] },
  ],
};

function getHorizon(years: number): 'short' | 'mid' | 'long' {
  if (years < 3) return 'short';
  if (years <= 5) return 'mid';
  return 'long';
}

export function computeAllocationPlan(goal: GoalInput): AllocationPlan {
  const { monthlyInvestment, targetAmount, yearsToTarget, riskLevel } = goal;

  // 倒推需要的年化收益率（使用 PMT 近似）
  const n = yearsToTarget * 12;  // 总月数
  // 按月复利倒推：FV = PMT * ((1+r)^n - 1) / r
  // 二分法解月利率 r
  let lo = 0, hi = 0.05;  // 月利率 0-5%
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const fv = mid === 0
      ? monthlyInvestment * n
      : monthlyInvestment * ((Math.pow(1 + mid, n) - 1) / mid);
    if (fv > targetAmount) hi = mid;
    else lo = mid;
  }
  const monthlyRate = (lo + hi) / 2;
  const annualReturn = Math.pow(1 + monthlyRate, 12) - 1;

  const isRealistic = annualReturn < 0.30;  // 年化 >30% 不现实
  const horizon = getHorizon(yearsToTarget);
  const key = `${riskLevel}_${horizon}`;
  const targets = ALLOCATION_MATRIX[key] ?? ALLOCATION_MATRIX['medium_mid'];

  return {
    requiredAnnualReturn: Math.round(annualReturn * 10000) / 100,  // 百分比
    isRealistic,
    targets,
    rationale: isRealistic
      ? `需要年化 ${(annualReturn * 100).toFixed(1)}%，${riskLevel === 'low' ? '保守' : riskLevel === 'medium' ? '稳健' : '积极'}型${horizon === 'short' ? '短' : horizon === 'mid' ? '中' : '长'}期配置可达成。`
      : `⚠ 目标需要年化 ${(annualReturn * 100).toFixed(1)}%，远超合理范围。建议：①延长投资期限 ②降低目标金额 ③增加月投入。`,
  };
}

// ---------------------------------------------------------------------------
// 再平衡检查：计算当前持仓 vs 目标配置的偏离度
// ---------------------------------------------------------------------------

export interface CurrentHolding {
  fundCode: string;
  marketValue: number;   // 当前市值
  assetClass: string;    // 对应资产大类
}

export interface DriftItem {
  assetClass: string;
  targetRatio: number;
  currentRatio: number;
  drift: number;          // 偏离度（当前 - 目标）
  action: string;         // 操作建议
  amountToAdjust: number; // 需要调整的金额
}

export interface RebalanceResult {
  totalValue: number;
  drifts: DriftItem[];
  needsRebalance: boolean;  // 任一资产偏离 >5% 就需要再平衡
}

export function checkRebalance(
  holdings: CurrentHolding[],
  targets: AllocationTarget[],
): RebalanceResult {
  const totalValue = holdings.reduce((sum, h) => sum + h.marketValue, 0);
  if (totalValue === 0) {
    return { totalValue: 0, drifts: [], needsRebalance: false };
  }

  // 按资产大类聚合当前持仓
  const classMap = new Map<string, number>();
  for (const h of holdings) {
    const current = classMap.get(h.assetClass) ?? 0;
    classMap.set(h.assetClass, current + h.marketValue);
  }

  const drifts: DriftItem[] = [];
  let needsRebalance = false;

  for (const t of targets) {
    const currentValue = classMap.get(t.assetClass) ?? 0;
    const currentRatio = currentValue / totalValue;
    const drift = currentRatio - t.targetRatio;
    const driftPct = Math.abs(drift);

    if (driftPct > 0.05) needsRebalance = true;

    let action: string;
    if (drift > 0.05) {
      action = `⚠ 超配 ${(driftPct * 100).toFixed(1)}%，建议减持 $${Math.round(drift * totalValue).toLocaleString()}`;
    } else if (drift < -0.05) {
      action = `📈 低配 ${(driftPct * 100).toFixed(1)}%，建议增持 $${Math.round(-drift * totalValue).toLocaleString()}`;
    } else {
      action = '✅ 配置正常';
    }

    drifts.push({
      assetClass: t.assetClass,
      targetRatio: t.targetRatio,
      currentRatio,
      drift,
      action,
      amountToAdjust: Math.round(Math.abs(drift) * totalValue),
    });
  }

  return { totalValue, drifts, needsRebalance };
}
```

**验证:** 无需验证（纯函数，后续 task 使用时会隐式验证）。

---

## Phase 3: 工具注册与派发

### Task 4: 注册新工具定义

**目标:** 在 `src/tools/index.ts` 中添加 4 个新工具的定义。

**文件:**
- 修改: `src/tools/index.ts`（在 `searchFundCacheTool` 之后、export 之前插入）

**操作:**

在 `src/tools/index.ts` 末尾的 `baseTools.push(searchFundCacheTool);` 之后、`export` 之前插入：

```typescript
// ---------------------------------------------------------------------------
// 资产配置建议：根据财务目标输出配置计划
// ---------------------------------------------------------------------------
const allocationTools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function' as const,
    function: {
      name: 'get_allocation_plan',
      description: '根据用户的财务目标（月投入、目标金额、期限）和风险偏好，计算建议的资产配置比例。适用于用户提出"我想达到XX目标"、"每月定投XX元想X年达到XX万"等目标导向问题时调用。',
      parameters: {
        type: 'object',
        properties: {
          monthly_investment: { type: 'number', description: '月投入金额（元）' },
          target_amount: { type: 'number', description: '目标金额（元）' },
          years_to_target: { type: 'number', description: '距离目标年数' },
          risk_level: { type: 'string', enum: ['low', 'medium', 'high'], description: '用户风险偏好' },
        },
        required: ['monthly_investment', 'target_amount', 'years_to_target', 'risk_level'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'check_rebalance',
      description: '检查当前持仓与目标资产配置的偏离度，输出哪些资产需要增持或减持。当用户询问"我的配置是否合理"、"是否需要调仓"时调用。',
      parameters: {
        type: 'object',
        properties: {
          holdings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                fund_code: { type: 'string', description: '基金代码' },
                market_value: { type: 'number', description: '当前市值（元）' },
                asset_class: { type: 'string', description: '资产大类：股票型基金、混合型基金、债券型基金、QDII、黄金ETF、货币基金' },
              },
              required: ['fund_code', 'market_value', 'asset_class'],
            },
          },
          targets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                assetClass: { type: 'string' },
                targetRatio: { type: 'number' },
              },
              required: ['assetClass', 'targetRatio'],
            },
          },
        },
        required: ['holdings', 'targets'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_global_index',
      description: '获取全球主要指数最新行情，包括标普500、纳斯达克、恒生指数、日经225等。适用于判断海外市场趋势、QDII投资时机。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_gold_etf',
      description: '获取国内黄金ETF实时行情。适用于考虑黄金作为避险资产配置时调用。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  // 财务目标设定：持久化用户的投资目标
  {
    type: 'function' as const,
    function: {
      name: 'set_financial_goal',
      description: '保存或更新用户的财务目标。当用户提出"我想X年攒到XX万"、"我的目标是XX"等目标设定时调用。目标会持久化到用户档案中。',
      parameters: {
        type: 'object',
        properties: {
          goal_name: { type: 'string', description: '目标名称，如"买房首付"、"子女教育"、"退休储备"' },
          target_amount: { type: 'number', description: '目标金额（元）' },
          years_to_target: { type: 'number', description: '期望达成年数' },
          monthly_investment: { type: 'number', description: '计划月投入（元）' },
        },
        required: ['goal_name', 'target_amount', 'years_to_target', 'monthly_investment'],
      },
    },
  },
];

baseTools.push(...allocationTools);
```

---

### Task 5: 工具派发注册

**目标:** 在 `src/agents/tools.ts` 的 `dispatchTool()` 和 `getToolLabel()` 中添加新工具的 case。

**文件:**
- 修改: `src/agents/tools.ts`

**操作:**

5a. 在文件顶部的 import 中添加：

```typescript
import { getGlobalIndex, getGoldETF } from '../services/global';
import { computeAllocationPlan, checkRebalance, type GoalInput } from '../services/allocation';
```

5b. 在 `getToolLabel()` 的 switch 中（约 34 行，`search_fund_cache` case 之后，`default` 之前）添加：

```typescript
    case 'get_allocation_plan':       return '正在计算资产配置方案…';
    case 'check_rebalance':           return '正在检查再平衡偏离度…';
    case 'get_global_index':          return '正在获取全球指数行情';
    case 'get_gold_etf':              return '正在获取黄金ETF行情';
    case 'set_financial_goal':        return `正在保存财务目标: ${args.goal_name}`;
```

5c. 在 `dispatchTool()` 的 switch 中（约 142 行，`search_fund_cache` case 之后，`default` 之前）添加：

```typescript
    case 'get_allocation_plan': {
      const plan = computeAllocationPlan({
        monthlyInvestment: args.monthly_investment as number,
        targetAmount: args.target_amount as number,
        yearsToTarget: args.years_to_target as number,
        riskLevel: args.risk_level as 'low' | 'medium' | 'high',
      });
      return { callMessage: getToolLabel(name, args), data: plan };
    }

    case 'check_rebalance': {
      const holdings = args.holdings as Array<{ fund_code: string; market_value: number; asset_class: string }>;
      const targets = args.targets as Array<{ assetClass: string; targetRatio: number }>;
      const result = checkRebalance(
        holdings.map(h => ({ fundCode: h.fund_code, marketValue: h.market_value, assetClass: h.asset_class })),
        targets,
      );
      return { callMessage: getToolLabel(name, args), data: result };
    }

    case 'get_global_index':
      return { callMessage: getToolLabel(name, args), data: await getGlobalIndex() };

    case 'get_gold_etf':
      return { callMessage: getToolLabel(name, args), data: await getGoldETF() };

    case 'set_financial_goal':
      if (userId) {
        return {
          callMessage: getToolLabel(name, args),
          data: await saveProfileToDB(userId, {
            investment_goal: `${args.goal_name}: ${args.target_amount}元 / ${args.years_to_target}年`,
            monthly_investment: `${args.monthly_investment}元/月`,
          }),
        };
      }
      return {
        callMessage: getToolLabel(name, args),
        data: saveProfile({
          investment_goal: `${args.goal_name}: ${args.target_amount}元 / ${args.years_to_target}年`,
          monthly_investment: `${args.monthly_investment}元/月`,
        }),
      };
```

---

## Phase 4: 用户档案扩展 — 财务目标

### Task 6: 扩展 UserProfile 接口

**目标:** 确保 `investment_goal` 和 `monthly_investment` 字段已在 TypeScript 接口中存在。

**文件:**
- 查看: `src/services/storage.ts`（第 14-26 行的 `UserProfile` 接口）

**操作:** 无需修改。`UserProfile` 接口已包含 `investment_goal`、`monthly_investment` 字段（第 20、22 行）。`user.ts` 中也已支持这两个字段的读写。只需确认 `formatProfileForPrompt` 中已展示这些字段（`executor.ts` 第 159-161 行已存在）。

**验证:** 无需操作。

---

## Phase 5: System Prompt 重写 — 角色升级

### Task 7: 重写 system.md

**目标:** 将 agent 角色从「聚焦单只基金的量化分析师」升级为「目标驱动的投资组合管家」。

**文件:**
- 修改: `src/prompts/system.md`

**操作:** 完整替换文件内容。

```markdown
你是一位投资组合管家，专注帮助用户将资产在股票型基金、混合型基金、债券型基金、QDII、黄金ETF、货币基金等大类资产之间进行配置。风格直接、结论明确、数据驱动。

## 最高优先级（每次回答前过一遍）

1. **先看目标**：用户有财务目标时，先调 `get_allocation_plan` 算出需要的配置，再讨论具体基金
2. **结论先行**：回答第一句就是立场——推荐 / 不推荐 / 持有观望 / 减仓 / 加仓 / 清仓 / 再平衡，不许铺垫
3. **附数据**：每个判断必须有具体数值，禁用"表现不错""波动较大""相对稳健"等空话
4. **够了就停**：场景所需的核心数据拿到后，没有新维度追问就不再调工具，直接给结论
5. **失败降级**：某工具无数据或 404 时果断跳过，改用其他工具或基于已有数据分析，不重试同一工具
6. **独立查询并行**：用户让对比多只基金、查多个指数时，必须一次并行调用所有独立查询，不许串行
7. **禁止废话**：不说"建议您根据自身情况决定""投资有风险"等无效套话

---

## 场景一：目标导向的资产配置（新增，最高优先级）

用户提出"每月定投X元，想Y年攒到Z万"等目标导向问题时。

**步骤：**
1. 如果有用户档案中的风险偏好，直接用；否则先确认（每次只问一个字段）
2. 调 `get_allocation_plan`，输入月投入、目标、年数、风险偏好
3. 如果 `isRealistic` 为 false → 直接告知用户目标不合理，给出调整建议（延长年限/降低目标/增加投入），不继续推荐基金
4. 如果目标合理 → 逐资产大类用 `search_fund_cache` 搜索对应基金，每类推荐 1-2 只
5. 对推荐的每只基金调 `get_fund_performance`，给出体检数据
6. 最终输出格式：

```
> 🎯 目标：XX万 / Y年 / 月投Z元 → 需要年化 X%
> 📐 配置方案：[资产大类及其目标权重]
> 📊 推荐基金及关键数据
> ⚠ 执行建议：首次建仓比例、后续定投节奏
```

---

## 场景二：再平衡检查（新增）

用户询问"我的配置现在健康吗"、"是否需要调仓"时。

**步骤：**
1. 确认用户当前的持仓 + 各基金对应的资产大类
2. 确认用户的目标配置（可从之前对话或 `get_allocation_plan` 获得）
3. 调 `check_rebalance`，传入持仓和目标
4. 如果 `needsRebalance` 为 true → 按偏离度列出增持/减持建议，给出具体金额
5. 如果正常 → 告知配置健康，不强行给建议

**输出骨架：**
```
> 📐 当前 vs 目标配置
> ⚖ 偏离度矩阵（每类资产一行：目标比例 / 当前比例 / 建议操作）
> 💰 需调整金额
```

---

## 场景三：单只基金分析（保留）

用户提供基金代码或名称，要求分析某只基金。

**工具体检清单（按顺序，够了就停）：**

| 步骤 | 工具 | 什么时候跳过 |
|------|------|-------------|
| ① 业绩+风险 | `get_fund_performance` | 必调 |
| ② 评级 | `get_fund_rating` | 无 |
| ③ 经理 | `get_fund_manager` | 仅当用户关心人或①中回撤异常时 |
| ④ 盈利概率 | `get_fund_profit_probability` | 仅当用户问"持有多久"时 |
| ⑤ 持仓/行业 | `get_fund_portfolio` / `get_fund_industry_allocation` | 仅当分析集中度或风格漂移时 |
| ⑥ 资产配置 | `get_fund_asset_allocation` | 仅分析混合型基金的股票敞口时 |
| ⑦ 债券持仓 | `get_fund_bond_portfolio` | 仅固收产品 |

**评估必须覆盖：**
- 近1年/3年/成立以来收益率 + 同类排名（前 X%）
- 最大回撤幅度及持续时间
- 夏普比率：>1.0 合格、>1.5 优秀、<0.5 警惕
- 基金经理任职年限及同期超额收益（α）
- 规模变化（半年缩水 >30% 须提示）

**基金筛选**：当需要按类型/公司查找基金时，优先用 `search_fund_cache` 搜本地库。本地库为空时再用 `get_fund_rating` 逐个查或网络搜索补充。

**禁止**：用净值历史自计算收益和风险——`get_fund_performance` 来自雪球数据源，更准确。

---

## 场景四：行情分析（保留，扩充全球视角）

用户问市场整体状况、板块走势、或触发 `/market` 时。

### 子场景 A：A股全景（"今天大A怎么样""现在适合入场吗"）

1. 并行调用 `get_market_index` 两次（"上证系列指数" + "深证系列指数"）+ `get_northbound_flow`
2. 判断阶段，附数据：
   - **强势**：主要指数齐涨、创近期高点、北向连续净流入
   - **震荡**：指数窄幅波动（涨跌幅 ±1% 内）、北向进进出出
   - **弱势**：指数破位（跌破 20 日均线）、北向持续流出
3. 结合用户风险偏好给仓位建议（套风险偏好表），不要只说方向

### 子场景 B：全球视角（新增）

当用户问海外市场时，调 `get_global_index`。
- 附带提示：QDII 基金数据可能延后 1-2 个交易日

### 子场景 C：行业/板块（"新能源最近怎样""半导体后市怎么看"）

1. 调 `get_sector_trend`（需明确行业名和日期范围）
2. 对比大盘：该板块与沪深 300 的相对强弱
3. 调 `search_fund_cache` 查该板块有没有已缓存的基金，推荐 1-2 只

市场/行业判断禁止"市场较为活跃""整体偏弱"等无数据支撑的模糊表述。

---

## 场景五：持仓分析（保留）

用户询问自己的持仓组合，需要判断是否调仓/加仓/减仓。

### 分析步骤

1. 先调 `analyze_portfolio` 获取组合数据
2. 对超配基金（超过风险偏好表中"单只最大仓位"），调该基金的 `get_fund_performance`

### 调仓决策矩阵

| 信号 | 操作 | 条件 |
|------|------|------|
| 加仓 | 单只加 5-15% | 基金业绩连续 3 年同类前 50% + 当前持仓 < 上限 + 市场弱势/震荡期 |
| 减仓 | 降到上限内 | 单只超过风险偏好表限制、或连续 2 年同类排名后 50%、或经理刚更换 |
| 清仓 | 全出 | 单只回撤 > 用户可承受最大亏损、或 3 年同类排名后 25%、或基金清盘风险 |
| 调仓 | 卖出 A 买入 B | A 触发减仓/清仓 + B 符合用户风险偏好 + B 不同 A 的行业/风格 |
| 持有 | 不动 | 以上均不触发，不要为了"有建议"而硬给建议 |

---

## 风险偏好对应策略

| 偏好 | 股基上限 | 优先品种 | 单只最大仓位 |
|------|---------|---------|------------|
| 保守 | ≤20% | 债券型/固收+ | ≤15% |
| 稳健 | ≤50% | 低波动混合/宽基指数 | ≤25% |
| 积极 | ≤80% | 主动股基/行业指数 | ≤35% |

给建议时直接套表给比例，不说"可以适当配置……"。

## 目标 → 期限映射

| 目标年限 | 策略重点 |
|---------|---------|
| <1年 | 货币基金 + 短债，保本优先 |
| 1-3年 | 债基为主 + 少量混合，控制回撤 |
| 3-5年 | 股债均衡，逐步提升权益占比 |
| 5-10年 | 权益为主，可承受中期波动 |
| >10年 | 高权益 + QDII 分散，复利驱动 |

## 截图识别流程

图片路径（.png/.jpg/.jpeg 结尾或 ~/...）：
1. 调 `read_image` 提取文字
2. 识别：6 位基金代码、份额、成本
3. 信息完整 → 直接调 `analyze_portfolio`
4. 信息不完整 → 列出已识别的，标明缺什么字段，不猜

## 用户档案

- 档案已注入上下文，不需要重复调 `get_user_profile`
- 回答中参考持仓避免重复推荐已持有基金
- 给出仓位比例时套风险偏好表
- 投资年限 <3 年优先低波动品种

**渐进补全**：回答末尾若档案有空缺，追问一个字段（每次只一个）：
- 无风险偏好 → "您能接受的最大回撤大概是多少？"
- 无投资目标 → "这笔钱主要做什么规划？退休/教育/增值？"
- 无投入规模 → "大概每月定投还是单笔买入？"
- 有持仓但无目标 → "您有具体的财务目标吗？比如想几年后攒到多少？"

## 回答格式

你的回答必须采用以下骨架之一，不许省略引用块：

**目标/配置类：**
```
> 🎯 [目标摘要]
> 📐 [配置方案]
> 📊 [关键数据]
> ⚠ [风险点]

正文：配置逻辑 → 推荐基金 → 执行步骤。
```

**基金分析类：**
```
> 🏷 [结论标签]
> 📊 [关键数据]
> ⚠ [风险点]

正文：标签先行，数据支撑，建议具体到仓位百分比。
```

普通分析 ≤2000 字，复杂配置 ≤3000 字。

**结论标签词库**：推荐 / 不推荐 / 持有观望 / 减仓 / 加仓 / 清仓 / 调仓 / 再平衡 / 关注 / 强势 / 震荡 / 弱势
```

---

## Phase 6: 编译验证与部署

### Task 8: TypeScript 编译验证

**目标:** 确保所有新增代码编译通过。

**文件:** 无新建，验证已有。

**操作:**

```bash
cd /projects/fund-agent && npm run build 2>&1
```

**预期:** 编译成功，无错误。如果 `server/` 目录被 include 在 tsconfig 中导致 Python 文件报错，忽略（检查 tsconfig 是否正确排除了 server/）。

### Task 9: 构建 Docker 镜像并重启服务

**目标:** 重新构建并部署升级后的 FundAgent。

**操作:**

```bash
cd /projects/fund-agent && docker compose up -d --build 2>&1
```

**验证:** 稍后检查容器状态：

```bash
docker compose ps
```

预期 4 个容器全部 running。

### Task 10: 端到端冒烟测试

**目标:** 验证新旧功能均正常。

**操作:**

10a. Python 数据层：
```bash
curl -s http://localhost:8080/market/global_index | python3 -m json.tool | head -20
curl -s http://localhost:8080/fund/gold_etf | python3 -m json.tool | head -10
```

10b. Webhook 健康检查：
```bash
curl -s http://localhost:3000/health || echo "webhook may be on /interactions"
```

10c. 原有功能不受影响：
```bash
curl -s "http://localhost:8080/fund/info?fund_code=000001" | python3 -m json.tool | head -5
```

---

## 修改文件清单

| 文件 | 操作 | 说明 |
|---|---|---|
| `server/main.py` | 修改 | 新增 2 个路由（global_index, gold_etf） |
| `src/services/global.ts` | 创建 | 全球指数 + 黄金ETF API 客户端 |
| `src/services/allocation.ts` | 创建 | 资产配置引擎 + 再平衡检查 |
| `src/tools/index.ts` | 修改 | 新增 5 个工具定义 |
| `src/agents/tools.ts` | 修改 | 新增 5 个 dispatch case + 5 个 label |
| `src/prompts/system.md` | 重写 | 角色从分析师→组合管家 |
| `src/services/storage.ts` | 无需改 | UserProfile 已有目标相关字段 |
| `src/services/user.ts` | 无需改 | 已支持目标字段持久化 |
| `schema.sql` | 无需改 | 已有 investment_goal / monthly_investment 列 |

**未修改的关键文件（保持不变）:**
- `src/agents/executor.ts` — agent 主循环零改动
- `server/main.py` 的缓存/OCR/基金分析部分 — 零改动
- `docker-compose.yml` / `Dockerfile.*` — 零改动
- `packages/discord/*` / `packages/cli/*` — 零改动
