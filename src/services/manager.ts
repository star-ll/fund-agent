import { akshareClient } from '../utils/http';

export interface ManagerInfo {
  序号: string;
  姓名: string;
  所属公司: string;
  现任基金代码: string;
  现任基金: string;
  累计从业时间: string;
  现任基金资产总规模: string;
  现任基金最佳回报: string;
}

export async function getFundManager(fundCode?: string): Promise<ManagerInfo[]> {
  const { data } = await akshareClient.get<ManagerInfo[]>('/fund/manager', {
    params: fundCode ? { fund_code: fundCode } : undefined,
  });
  return data;
}
