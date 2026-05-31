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
