import { akshareClient } from '../utils/http';
import { getFundCache, saveFundInfo, saveRatingInfo } from './fund-cache';

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
  // 先查缓存
  const cached = await getFundCache(fundCode);
  if (cached?.rating_shanghai || cached?.rating_merchants || cached?.rating_jian) {
    return [{
      代码: fundCode,
      简称: cached.fund_name ?? '',
      基金经理: cached.manager_name ?? '',
      基金公司: cached.fund_company ?? '',
      上海证券: cached.rating_shanghai ?? '',
      招商证券: cached.rating_merchants ?? '',
      济安金信: cached.rating_jian ?? '',
      手续费: '',
      类型: cached.fund_type_raw ?? '',
    }];
  }

  // 调 API 取数据
  const { data } = await akshareClient.get<FundRating[]>('/fund/rating', {
    params: { fund_code: fundCode },
  });

  // 回写缓存：评级 + 类型 + 公司
  if (data.length > 0) {
    const r = data[0];
    await saveRatingInfo(fundCode, {
      rating_shanghai: r.上海证券,
      rating_merchants: r.招商证券,
      rating_jian: r.济安金信,
    });
    // 同时写入类型和公司（rating 数据里有）
    await saveFundInfo(fundCode, {
      fund_name: r.简称,
      fund_type: r.类型,
      fund_company: r.基金公司,
    });
  }

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

// 基金净值估算（东方财富：盘中实时估算值和偏差）
export interface FundEstimate {
  基金代码: string;
  基金名称: string;
  估算值: string;
  估算增长率: string;
  估算偏差: string;
}

// A股指数实时行情
export interface MarketIndex {
  名称: string;
  最新价: string;
  涨跌幅: string;
  成交额: string;
}

// 北向资金净流入
export interface NorthboundFlow {
  日期: string;
  北向资金: string;
  沪股通: string;
  深股通: string;
}

// 行业板块历史K线
export interface SectorTrend {
  日期: string;
  开盘: string;
  收盘: string;
  涨跌幅: string;
  成交额: string;
}

export async function getFundEstimate(symbol = '全部'): Promise<FundEstimate[]> {
  const { data } = await akshareClient.get<FundEstimate[]>('/fund/estimate', {
    params: { symbol },
  });
  return data;
}

export async function getMarketIndex(symbol = '上证系列指数'): Promise<MarketIndex[]> {
  const { data } = await akshareClient.get<MarketIndex[]>('/market/index', {
    params: { symbol },
  });
  return data;
}

export async function getNorthboundFlow(): Promise<NorthboundFlow[]> {
  const { data } = await akshareClient.get<NorthboundFlow[]>('/market/northbound');
  return data;
}

export async function getSectorTrend(
  symbol: string,
  startDate: string,
  endDate: string,
  period = 'daily',
): Promise<SectorTrend[]> {
  const { data } = await akshareClient.get<SectorTrend[]>('/market/sector', {
    params: { symbol, start_date: startDate, end_date: endDate, period },
  });
  return data;
}
