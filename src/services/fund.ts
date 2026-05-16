import { akshareClient } from '../utils/http';

export interface FundInfo {
  基金代码: string;
  基金简称: string;
  类型: string;
  日期: string;
  单位净值: string;
  累计净值: string;
  日增长率: string;
}

export interface FundNav {
  净值日期: string;
  单位净值: string;
  日增长率: string;
}

export interface FundMetrics {
  annualReturn: number;
  maxDrawdown: number;
  volatility: number;
  sharpeRatio: number;
}

export async function getFundInfo(fundCode: string): Promise<FundInfo> {
  const { data } = await akshareClient.get<FundInfo>('/fund/info', {
    params: { fund_code: fundCode },
  });
  return data;
}

export async function getFundNav(
  fundCode: string,
  indicator = '单位净值走势',
  period = '成立来',
): Promise<FundNav[]> {
  const { data } = await akshareClient.get<FundNav[]>('/fund/nav', {
    params: { fund_code: fundCode, indicator, period },
  });
  return data;
}

export function calcMetrics(navList: FundNav[]): FundMetrics {
  if (navList.length < 2) return { annualReturn: 0, maxDrawdown: 0, volatility: 0, sharpeRatio: 0 };

  const navs = navList.map((h) => parseFloat(h.单位净值));
  const returns = navs.slice(1).map((nav, i) => (nav - navs[i]) / navs[i]);

  const totalReturn = (navs[navs.length - 1] - navs[0]) / navs[0];
  const years = navList.length / 250;
  const annualReturn = Math.pow(1 + totalReturn, 1 / years) - 1;

  let maxDrawdown = 0;
  let peak = navs[0];
  for (const nav of navs) {
    if (nav > peak) peak = nav;
    const drawdown = (peak - nav) / peak;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
  const volatility = Math.sqrt(variance) * Math.sqrt(250);

  const riskFreeRate = 0.02;
  const sharpeRatio = volatility > 0 ? (annualReturn - riskFreeRate) / volatility : 0;

  return { annualReturn, maxDrawdown, volatility, sharpeRatio };
}
