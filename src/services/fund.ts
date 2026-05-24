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

// 年度+阶段业绩：区间收益、最大回撤、同类排名（来自雪球）
export interface FundAchievement {
  业绩类型: string;
  周期: string;
  本产品区间收益: string;
  本产品最大回撒: string;
  周期收益同类排名: string;
}

// 风险收益分析：年化波动率、夏普比率、同类对比（来自雪球）
export interface FundAnalysis {
  周期: string;
  较同类风险收益比: string;
  较同类抗风险波动: string;
  年化波动率: string;
  年化夏普比率: string;
  最大回撤: string;
}

// 历史持有盈利概率
export interface FundProfitProbability {
  持有时长: string;
  盈利概率: string;
  平均收益: string;
}

// 基金评级
export interface FundRating {
  代码: string;
  简称: string;
  基金经理: string;
  基金公司: string;
  上海证券: string;
  招商证券: string;
  济安金信: string;
  手续费: string;
  类型: string;
}

// 行业配置
export interface FundIndustryAllocation {
  行业类别: string;
  占净值比例: string;
  市值: string;
  截止时间: string;
}

// 债券持仓
export interface FundBondPortfolio {
  债券代码: string;
  债券名称: string;
  占净值比例: string;
  持仓市值: string;
  季度: string;
}

// 大类资产配置（股票/现金/其他）
export interface FundHoldDetail {
  资产类型: string;
  仓位占比: string;
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

export async function getFundAchievement(fundCode: string): Promise<FundAchievement[]> {
  const { data } = await akshareClient.get<FundAchievement[]>('/fund/achievement', {
    params: { fund_code: fundCode },
  });
  return data;
}

export async function getFundAnalysis(fundCode: string): Promise<FundAnalysis[]> {
  const { data } = await akshareClient.get<FundAnalysis[]>('/fund/analysis', {
    params: { fund_code: fundCode },
  });
  return data;
}

export async function getFundProfitProbability(fundCode: string): Promise<FundProfitProbability[]> {
  const { data } = await akshareClient.get<FundProfitProbability[]>('/fund/profit-probability', {
    params: { fund_code: fundCode },
  });
  return data;
}

export async function getFundRating(fundCode: string): Promise<FundRating[]> {
  const { data } = await akshareClient.get<FundRating[]>('/fund/rating', {
    params: { fund_code: fundCode },
  });
  return data;
}

export async function getFundIndustry(fundCode: string, date: string): Promise<FundIndustryAllocation[]> {
  const { data } = await akshareClient.get<FundIndustryAllocation[]>('/fund/industry', {
    params: { fund_code: fundCode, date },
  });
  return data;
}

export async function getFundBondPortfolio(fundCode: string, date: string): Promise<FundBondPortfolio[]> {
  const { data } = await akshareClient.get<FundBondPortfolio[]>('/fund/bond-portfolio', {
    params: { fund_code: fundCode, date },
  });
  return data;
}

export async function getFundHoldDetail(fundCode: string, date: string): Promise<FundHoldDetail[]> {
  const { data } = await akshareClient.get<FundHoldDetail[]>('/fund/hold-detail', {
    params: { fund_code: fundCode, date },
  });
  return data;
}
