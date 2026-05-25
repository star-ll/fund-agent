import { getFundInfo, getFundNav, getFundAchievement, getFundAnalysis, getFundProfitProbability, getFundRating, getFundIndustry, getFundBondPortfolio, getFundHoldDetail, getFundEstimate, getMarketIndex, getNorthboundFlow, getSectorTrend } from '../services/fund';
import { getFundManager } from '../services/manager';
import { getFundPortfolio, analyzePortfolio } from '../services/portfolio';
import { extractText } from '../services/ocr';
import { loadProfile, saveProfile } from '../services/storage';
import { loadProfileFromDB, saveProfileToDB } from '../services/user';
import { webSearch } from '../services/search';

export function getToolLabel(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'get_fund_info':              return `正在查询基金: ${args.fund_code}`;
    case 'get_fund_nav':               return `正在获取净值历史: ${args.fund_code}${args.period ? `（${args.period}）` : ''}`;
    case 'get_fund_manager':           return `正在查询基金经理: ${args.fund_code}`;
    case 'get_fund_portfolio':         return `正在获取持仓明细: ${args.fund_code}${args.date ? `（${args.date}）` : ''}`;
    case 'get_fund_performance':       return `正在获取业绩数据: ${args.fund_code}`;
    case 'get_fund_profit_probability': return `正在获取盈利概率: ${args.fund_code}`;
    case 'get_fund_rating':            return `正在获取基金评级: ${args.fund_code}`;
    case 'get_fund_asset_allocation':  return `正在获取资产配置: ${args.fund_code}`;
    case 'get_fund_industry_allocation': return `正在获取行业配置: ${args.fund_code}`;
    case 'get_fund_bond_portfolio':    return `正在获取债券持仓: ${args.fund_code}`;
    case 'get_fund_estimate':          return `正在获取基金估值: ${args.symbol ?? '全部'}`;
    case 'get_market_index':           return `正在获取指数行情: ${args.symbol ?? '上证系列指数'}`;
    case 'get_northbound_flow':        return '正在获取北向资金数据';
    case 'get_sector_trend':           return `正在获取行业走势: ${args.symbol}`;
    case 'get_user_profile':           return '正在读取用户档案';
    case 'save_user_profile':          return '正在保存用户档案';
    case 'read_image':                 return `正在识别图片: ${args.file_path}`;
    case 'analyze_portfolio': {
      const holdings = args.holdings as Array<{ fund_code: string }>;
      return `正在分析持仓组合: ${holdings.map((h) => h.fund_code).join('、')}`;
    }
    case 'web_search':                 return `正在搜索: ${args.query}`;
    default:                           return `${name}…`;
  }
}


export async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  userId?: string,
): Promise<{callMessage: string, data: unknown}> {
  switch (name) {
    case 'get_fund_info':
      return { callMessage: getToolLabel(name, args), data: await getFundInfo(args.fund_code as string) };

    case 'get_fund_nav':
      return {
        callMessage: getToolLabel(name, args),
        data: await getFundNav(args.fund_code as string, '单位净值走势', (args.period as string) ?? '成立来'),
      };

    case 'get_fund_manager':
      return { callMessage: getToolLabel(name, args), data: await getFundManager(args.fund_code as string) };

    case 'get_fund_portfolio':
      return { callMessage: getToolLabel(name, args), data: await getFundPortfolio(args.fund_code as string, args.date as string) };

    // 业绩：年化收益、最大回撤、同类排名 + 波动率、夏普比率
    case 'get_fund_performance': {
      const [achievement, analysis] = await Promise.all([
        getFundAchievement(args.fund_code as string),
        getFundAnalysis(args.fund_code as string),
      ]);
      return { callMessage: getToolLabel(name, args), data: { achievement, analysis } };
    }

    case 'get_fund_profit_probability':
      return { callMessage: getToolLabel(name, args), data: await getFundProfitProbability(args.fund_code as string) };

    case 'get_fund_rating':
      return { callMessage: getToolLabel(name, args), data: await getFundRating(args.fund_code as string) };

    case 'get_fund_asset_allocation':
      return { callMessage: getToolLabel(name, args), data: await getFundHoldDetail(args.fund_code as string, args.date as string) };

    case 'get_fund_industry_allocation':
      return { callMessage: getToolLabel(name, args), data: await getFundIndustry(args.fund_code as string, args.date as string) };

    case 'get_fund_bond_portfolio':
      return { callMessage: getToolLabel(name, args), data: await getFundBondPortfolio(args.fund_code as string, args.date as string) };

    case 'get_user_profile':
      if (userId) {
        return { callMessage: getToolLabel(name, args), data: (await loadProfileFromDB(userId)) ?? { message: '暂无档案，请先提供持仓信息。' } };
      }
      return { callMessage: getToolLabel(name, args), data: loadProfile() ?? { message: '暂无用户档案，请先告知持仓信息或上传截图。' } };

    case 'save_user_profile':
      if (userId) {
        return { callMessage: getToolLabel(name, args), data: await saveProfileToDB(userId, args as Parameters<typeof saveProfileToDB>[1]) };
      }
      return { callMessage: getToolLabel(name, args), data: await saveProfile(args as Parameters<typeof saveProfile>[0]) };

    case 'read_image':
      return { callMessage: getToolLabel(name, args), data: { text: await extractText(args.file_path as string) } };

    case 'analyze_portfolio': {
      const holdings = args.holdings as Array<{ fund_code: string; shares: number; cost: number }>;
      return {
        callMessage: getToolLabel(name, args),
        data: await analyzePortfolio(holdings.map((h) => ({ fundCode: h.fund_code, shares: h.shares, cost: h.cost }))),
      };
    }

    case 'get_fund_estimate':
      return { callMessage: getToolLabel(name, args), data: await getFundEstimate(args.symbol as string | undefined) };

    case 'get_market_index':
      return { callMessage: getToolLabel(name, args), data: await getMarketIndex(args.symbol as string | undefined) };

    case 'get_northbound_flow':
      return { callMessage: getToolLabel(name, args), data: await getNorthboundFlow() };

    case 'get_sector_trend':
      return {
        callMessage: getToolLabel(name, args),
        data: await getSectorTrend(
          args.symbol as string,
          args.start_date as string,
          args.end_date as string,
          (args.period as string) ?? 'daily',
        ),
      };

    case 'web_search':
      return { callMessage: getToolLabel(name, args), data: await webSearch(args.query as string, args.max_results as number | undefined) };

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
