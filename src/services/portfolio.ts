import { getFundNav, getFundAchievement, getFundAnalysis } from './fund';

export interface Holding {
  fundCode: string;
  shares: number;
  cost: number;
}

export interface PortfolioSummary {
  totalCost: number;
  totalMarketValue: number;
  totalReturnRate: number;
}

export interface PortfolioHoldingDetail {
  fundCode: string;
  shares: number;
  cost: number;
  currentNav: number;
  marketValue: number;
  weight: number;
  returnRate: number;
  achievement: object[];
  analysis: object[];
}

export interface PortfolioResult {
  summary: PortfolioSummary;
  holdings: PortfolioHoldingDetail[];
}

export interface PortfolioHolding {
  股票代码: string;
  股票名称: string;
  占净值比例: string;
  持股数: string;
  持仓市值: string;
}

export async function getFundPortfolio(fundCode: string, date: string): Promise<PortfolioHolding[]> {
  const { akshareClient } = await import('../utils/http');
  const { data } = await akshareClient.get<PortfolioHolding[]>('/fund/portfolio', {
    params: { fund_code: fundCode, date },
  });
  return data;
}

export async function analyzePortfolio(holdings: Holding[]): Promise<PortfolioResult> {
  // 并行获取每只基金的净值快照、业绩数据和风险分析
  const results = await Promise.all(
    holdings.map(async (h) => {
      const [navList, achievement, analysis] = await Promise.all([
        getFundNav(h.fundCode, '单位净值走势', '1月'),
        getFundAchievement(h.fundCode).catch(() => []),
        getFundAnalysis(h.fundCode).catch(() => []),
      ]);
      const currentNav = navList.length > 0 ? parseFloat(navList[navList.length - 1].单位净值) : 1;
      const marketValue = h.shares * currentNav;
      const returnRate = (marketValue - h.cost) / h.cost;
      return { ...h, currentNav, marketValue, returnRate, achievement, analysis };
    }),
  );

  const totalCost = results.reduce((sum, h) => sum + h.cost, 0);
  const totalMarketValue = results.reduce((sum, h) => sum + h.marketValue, 0);
  const totalReturnRate = totalCost > 0 ? (totalMarketValue - totalCost) / totalCost : 0;

  const holdingDetails: PortfolioHoldingDetail[] = results.map((h) => ({
    fundCode: h.fundCode,
    shares: h.shares,
    cost: h.cost,
    currentNav: h.currentNav,
    marketValue: h.marketValue,
    weight: totalMarketValue > 0 ? h.marketValue / totalMarketValue : 0,
    returnRate: h.returnRate,
    achievement: h.achievement,
    analysis: h.analysis,
  }));

  return {
    summary: { totalCost, totalMarketValue, totalReturnRate },
    holdings: holdingDetails,
  };
}
