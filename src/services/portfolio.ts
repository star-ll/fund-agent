import { akshareClient } from '../utils/http';
import { getFundNav, calcMetrics } from './fund';

export interface Holding {
  fundCode: string;
  shares: number;
  cost: number;
}

export interface PortfolioMetrics {
  totalCost: number;
  totalMarketValue: number;
  totalReturnRate: number;
  annualReturn: number;
  maxDrawdown: number;
  volatility: number;
}

export interface PortfolioHolding {
  股票代码: string;
  股票名称: string;
  占净值比例: string;
  持股数: string;
  持仓市值: string;
}

export async function getFundPortfolio(fundCode: string, date: string): Promise<PortfolioHolding[]> {
  const { data } = await akshareClient.get<PortfolioHolding[]>('/fund/portfolio', {
    params: { fund_code: fundCode, date },
  });
  return data;
}

export async function analyzePortfolio(holdings: Holding[]): Promise<PortfolioMetrics> {
  const results = await Promise.all(
    holdings.map(async (h) => {
      const navList = await getFundNav(h.fundCode);
      const metrics = calcMetrics(navList);
      const currentNav = navList.length > 0 ? parseFloat(navList[navList.length - 1].单位净值) : 1;
      return { ...h, currentNav, metrics };
    }),
  );

  const totalCost = results.reduce((sum, h) => sum + h.cost, 0);
  const totalMarketValue = results.reduce((sum, h) => sum + h.shares * h.currentNav, 0);
  const totalReturnRate = (totalMarketValue - totalCost) / totalCost;

  const weights = results.map((h) => (h.shares * h.currentNav) / totalMarketValue);
  const annualReturn = results.reduce((sum, h, i) => sum + h.metrics.annualReturn * weights[i], 0);
  const maxDrawdown = results.reduce((sum, h, i) => sum + h.metrics.maxDrawdown * weights[i], 0);
  const volatility = results.reduce((sum, h, i) => sum + h.metrics.volatility * weights[i], 0);

  return { totalCost, totalMarketValue, totalReturnRate, annualReturn, maxDrawdown, volatility };
}
