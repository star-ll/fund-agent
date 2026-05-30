import { akshareClient } from '../utils/http';
import { getFundCache, saveManagerInfo, saveFundInfo } from './fund-cache';

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
  if (fundCode) {
    // 先查缓存
    const cached = await getFundCache(fundCode);
    if (cached?.manager_name) {
      return [{
        序号: '',
        姓名: cached.manager_name,
        所属公司: cached.fund_company ?? '',
        现任基金代码: fundCode,
        现任基金: cached.fund_name ?? '',
        累计从业时间: cached.manager_tenure ? `${cached.manager_tenure}年` : '',
        现任基金资产总规模: '',
        现任基金最佳回报: cached.manager_best_return ?? '',
      }];
    }
  }

  // 调 API
  const { data } = await akshareClient.get<ManagerInfo[]>('/fund/manager', {
    params: fundCode ? { fund_code: fundCode } : undefined,
  });

  // 回写缓存
  if (fundCode && data.length > 0) {
    const m = data[0];
    const tenureMatch = m.累计从业时间?.match(/([\d.]+)/);
    await saveManagerInfo(fundCode, {
      manager_name: m.姓名,
      manager_tenure: tenureMatch ? parseFloat(tenureMatch[1]) : undefined,
      manager_best_return: m.现任基金最佳回报,
    });
    // 同时补全公司信息
    if (m.所属公司) {
      await saveFundInfo(fundCode, {
        fund_company: m.所属公司,
        fund_name: m.现任基金,
      });
    }
  }

  return data;
}
