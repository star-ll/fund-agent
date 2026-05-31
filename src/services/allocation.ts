// 资产配置模型 — 根据用户财务目标倒推建议配置

export interface AllocationTarget {
  assetClass: string;      // "股票型基金" | "混合型基金" | "债券型基金" | "QDII" | "黄金ETF" | "货币基金"
  targetRatio: number;     // 0-1 之间的目标权重
  examples?: string[];     // 示例基金类型/代码（供 agent 搜索）
}

export interface GoalInput {
  monthlyInvestment: number;   // 月投入（元）
  targetAmount: number;         // 目标金额（元）
  yearsToTarget: number;        // 距离目标年数
  riskLevel: 'low' | 'medium' | 'high';
}

export interface AllocationPlan {
  requiredAnnualReturn: number;  // 需要的年化收益率（百分比）
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

  // 倒推需要的年化收益率（使用 PMT 二分法）
  const n = yearsToTarget * 12;  // 总月数
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
    requiredAnnualReturn: Math.round(annualReturn * 10000) / 100,  // 百分比，保留两位小数
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
      action = `⚠ 超配 ${(driftPct * 100).toFixed(1)}%，建议减持 ¥${Math.round(drift * totalValue).toLocaleString()}`;
    } else if (drift < -0.05) {
      action = `📈 低配 ${(driftPct * 100).toFixed(1)}%，建议增持 ¥${Math.round(-drift * totalValue).toLocaleString()}`;
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
