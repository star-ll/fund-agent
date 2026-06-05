import type OpenAI from 'openai';
import { config } from '../utils/config';

const baseTools: OpenAI.Chat.ChatCompletionTool[] = [
  // 基金基本信息：名称、类型、净值快照，不含历史数据
  {
    type: 'function',
    function: {
      name: 'get_fund_info',
      description: '获取基金基本信息，包括名称、类型、单位净值、累计净值等',
      parameters: {
        type: 'object',
        properties: {
          fund_code: { type: 'string', description: '基金代码，例如 000001' },
        },
        required: ['fund_code'],
      },
    },
  },
  // 净值历史走势，适合查看净值曲线；风险收益指标请用 get_fund_performance
  {
    type: 'function',
    function: {
      name: 'get_fund_nav',
      description: '获取基金净值历史走势数据',
      parameters: {
        type: 'object',
        properties: {
          fund_code: { type: 'string', description: '基金代码' },
          period: {
            type: 'string',
            enum: ['1月', '3月', '6月', '1年', '3年', '5年', '今年来', '成立来'],
            description: '数据时间段，默认成立来',
          },
        },
        required: ['fund_code'],
      },
    },
  },
  // 基金经理：从业年限、管理规模、历史最佳回报
  {
    type: 'function',
    function: {
      name: 'get_fund_manager',
      description: '获取基金经理信息，包括从业年限、管理规模、最佳回报等',
      parameters: {
        type: 'object',
        properties: {
          fund_code: { type: 'string', description: '基金代码' },
        },
        required: ['fund_code'],
      },
    },
  },
  // 基金持仓股票明细，按季度披露；date 传年份即可，取该年最新一期
  {
    type: 'function',
    function: {
      name: 'get_fund_portfolio',
      description: '获取基金持仓股票明细，包括持仓比例和市值',
      parameters: {
        type: 'object',
        properties: {
          fund_code: { type: 'string', description: '基金代码' },
          date: { type: 'string', description: '年份，例如 2024' },
        },
        required: ['fund_code', 'date'],
      },
    },
  },
  // 评估单只基金性能时的首选工具：来自雪球数据源，比自计算净值更准确
  // 同时返回 achievement（年度+阶段收益、最大回撤、同类排名）和 analysis（波动率、夏普比率、同类风险对比）
  {
    type: 'function',
    function: {
      name: 'get_fund_performance',
      description: '获取基金多周期业绩数据，包括年度收益率、阶段收益率、最大回撤、年化波动率、夏普比率及同类排名。评估单只基金表现时优先调用此工具，数据来自雪球，比净值历史自计算更准确。',
      parameters: {
        type: 'object',
        properties: {
          fund_code: { type: 'string', description: '基金代码' },
        },
        required: ['fund_code'],
      },
    },
  },
  // 历史任意时点买入，持有满 X 时间后的盈利概率；适合给用户建议持有时长
  {
    type: 'function',
    function: {
      name: 'get_fund_profit_probability',
      description: '获取历史任意时点买入、持有满 X 时间后的盈利概率及平均收益。适用于建议持有时长、判断当前是否适合持有。',
      parameters: {
        type: 'object',
        properties: {
          fund_code: { type: 'string', description: '基金代码' },
        },
        required: ['fund_code'],
      },
    },
  },
  // 第三方评级：上海证券、招商证券、济安金信（1-5 星）；推荐时用作佐证
  {
    type: 'function',
    function: {
      name: 'get_fund_rating',
      description: '获取基金第三方评级，包括上海证券、招商证券、济安金信评级（1-5星）。筛选推荐基金时提供佐证。',
      parameters: {
        type: 'object',
        properties: {
          fund_code: { type: 'string', description: '基金代码' },
        },
        required: ['fund_code'],
      },
    },
  },
  // 大类资产配置：股票/现金/其他仓位比例；判断混合型基金实际股票敞口
  {
    type: 'function',
    function: {
      name: 'get_fund_asset_allocation',
      description: '获取基金大类资产配置比例（股票/现金/其他），按季度披露。适用于判断基金实际股票仓位，分析混合型基金的风险敞口。',
      parameters: {
        type: 'object',
        properties: {
          fund_code: { type: 'string', description: '基金代码' },
          date: { type: 'string', description: '季度日期，格式 20231231' },
        },
        required: ['fund_code', 'date'],
      },
    },
  },
  // 行业配置：分析持仓集中度、多只基金的行业重叠风险
  {
    type: 'function',
    function: {
      name: 'get_fund_industry_allocation',
      description: '获取基金持仓的行业配置比例，按占净值比例降序排列。适用于分析持仓集中度、多只基金之间的行业重叠风险。',
      parameters: {
        type: 'object',
        properties: {
          fund_code: { type: 'string', description: '基金代码' },
          date: { type: 'string', description: '年份，例如 2024' },
        },
        required: ['fund_code', 'date'],
      },
    },
  },
  // 债券持仓明细：适用于债券型/混合型基金的信用风险和久期分析
  {
    type: 'function',
    function: {
      name: 'get_fund_bond_portfolio',
      description: '获取债券型/混合型基金的债券持仓明细，包括债券名称、占净值比例、持仓市值。适用于分析固收产品的信用风险和久期结构。',
      parameters: {
        type: 'object',
        properties: {
          fund_code: { type: 'string', description: '基金代码' },
          date: { type: 'string', description: '年份，例如 2023' },
        },
        required: ['fund_code', 'date'],
      },
    },
  },
  // OCR 识别持仓截图，提取文字后由 LLM 解析基金代码/份额/成本，再调 analyze_portfolio
  {
    type: 'function',
    function: {
      name: 'read_image',
      description:
        '对图片文件进行 OCR 识别，提取其中的文字内容。适用于基金持仓截图，识别后可解析出基金代码、份额、持仓成本等信息，再调用 analyze_portfolio 进行分析。',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: '图片文件路径，支持绝对路径或 ~ 开头的路径，支持 PNG / JPG',
          },
        },
        required: ['file_path'],
      },
    },
  },
  // 多基金组合分析：加权收益、整体回撤、波动率；需要 shares + cost 才能算权重
  {
    type: 'function',
    function: {
      name: 'analyze_portfolio',
      description: '分析投资者持仓组合，计算总收益、各基金权重，并为每只基金单独展示多周期业绩和风险指标（来自雪球数据源）。',
      parameters: {
        type: 'object',
        properties: {
          holdings: {
            type: 'array',
            description: '持仓列表',
            items: {
              type: 'object',
              properties: {
                fund_code: { type: 'string' },
                shares: { type: 'number', description: '持有份额' },
                cost: { type: 'number', description: '持仓成本（元）' },
              },
              required: ['fund_code', 'shares', 'cost'],
            },
          },
        },
        required: ['holdings'],
      },
    },
  },
  // 持久化用户档案（持仓、风险偏好等），新数据与已有数据合并；档案会在每次对话的 system prompt 中自动注入，无需主动读取
  {
    type: 'function',
    function: {
      name: 'save_user_profile',
      description:
        '保存或更新用户的持仓和个人信息档案。当用户提供持仓信息、风险偏好、个人背景时调用。新数据会与已有数据合并，holdings 按基金代码去重。',
      parameters: {
        type: 'object',
        properties: {
          holdings: {
            type: 'array',
            description: '持仓列表（可只传需要更新的部分）',
            items: {
              type: 'object',
              properties: {
                fund_code: { type: 'string' },
                shares: { type: 'number', description: '持有份额' },
                cost: { type: 'number', description: '持仓总成本（元）' },
                note: { type: 'string', description: '备注' },
              },
              required: ['fund_code'],
            },
          },
          risk_level: { type: 'string', enum: ['low', 'medium', 'high'], description: '风险承受能力' },
          investment_years: { type: 'number', description: '投资年限' },
          target_return: { type: 'string', description: '目标年化收益率，如 10%' },
          max_loss_tolerance: { type: 'string', description: '可承受最大亏损，如 20%' },
          notes: { type: 'string', description: '其他个人备注' },
        },
      },
    },
  },
];

// 仅在配置了搜索服务时启用，避免 LLM 在无搜索能力时仍尝试调用
const marketTools: OpenAI.Chat.ChatCompletionTool[] = [
  // 盘中实时估值：查某只或某类基金的实时估算净值和涨跌
  {
    type: 'function',
    function: {
      name: 'get_fund_estimate',
      description: '获取基金盘中实时净值估算，包括估算值、估算增长率和估算偏差。适用于交易日盘中查询基金实时涨跌情况。',
      parameters: {
        type: 'object',
        properties: {
          symbol: {
            type: 'string',
            enum: ['全部', '股票型', '混合型', '债券型', '指数型', 'QDII', 'ETF联接', 'LOF', '场内交易基金'],
            description: '基金类型，默认全部',
          },
        },
      },
    },
  },
  // A股主要指数实时行情，市场概览的基础数据；适合判断当天市场强弱
  {
    type: 'function',
    function: {
      name: 'get_market_index',
      description: '获取A股主要指数实时行情，包括上证、深证、中证等系列指数的最新价、涨跌幅和成交额。适用于判断市场整体趋势和风险偏好。',
      parameters: {
        type: 'object',
        properties: {
          symbol: {
            type: 'string',
            enum: ['上证系列指数', '深证系列指数', '指数成份', '中证系列指数', '上证指数', '深证成指', '创业板指', '科创50', '沪深300', '中证500', '上证50'],
            description: '指数名称或类型。分类：上证系列指数/深证系列指数/指数成份/中证系列指数。个股：上证指数/沪深300/创业板指/科创50 等',
          },
        },
      },
    },
  },
  // 北向资金是外资情绪先行指标，连续流入/流出对市场风格有明显影响
  {
    type: 'function',
    function: {
      name: 'get_northbound_flow',
      description: '获取北向资金（沪深港通）近期净流入数据。北向资金是外资情绪先行指标，持续净流入通常预示市场偏强。适用于市场情绪分析和调仓时机判断。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  // 查特定行业近期涨跌趋势；需要指定行业名称，不适合全行业扫描
  {
    type: 'function',
    function: {
      name: 'get_sector_trend',
      description: '获取指定行业板块的历史K线数据，包括涨跌幅和成交额。适用于分析特定行业近期走势，判断行业轮动方向。行业名称示例：互联网服务、新能源、医药生物。',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: '行业名称，例如：互联网服务' },
          start_date: { type: 'string', description: '开始日期，格式 YYYYMMDD，例如 20250101' },
          end_date: { type: 'string', description: '结束日期，格式 YYYYMMDD' },
          period: {
            type: 'string',
            enum: ['daily', 'weekly', 'monthly'],
            description: '周期，默认 daily',
          },
        },
        required: ['symbol', 'start_date', 'end_date'],
      },
    },
  },
];

baseTools.push(...marketTools);

// 仅在配置了搜索服务时启用，避免 LLM 在无搜索能力时仍尝试调用
const webSearchTool: OpenAI.Chat.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'web_search',
    description: '搜索互联网获取实时信息，适用于查询基金新闻、市场动态、政策资讯等最新内容',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        max_results: { type: 'number', description: '返回结果数量，默认 5' },
      },
      required: ['query'],
    },
  },
};

// 本地基金知识库搜索：优先查询本地数据库，命中则无需调 API
const searchFundCacheTool: OpenAI.Chat.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'search_fund_cache',
    description:
      '搜索本地基金知识库，按类型、公司、关键词查找已缓存的基金。适用于查找"有哪些债券型基金"、"某公司旗下的基金"等需要筛选基金的场景。优先使用此工具，比逐个调用 get_fund_info 更高效。',
    parameters: {
      type: 'object',
      properties: {
        category_l1: {
          type: 'string',
          enum: ['股票型', '混合型', '债券型', '指数型', 'QDII', 'FOF', '货币型', '其他'],
          description: '一级基金分类',
        },
        category_l2: {
          type: 'string',
          description: '二级分类，如 偏股混合、纯债、灵活配置、指数增强等',
        },
        fund_company: { type: 'string', description: '基金公司名称' },
        keyword: { type: 'string', description: '搜索关键词，匹配基金名称或代码' },
        limit: { type: 'number', description: '返回数量上限，默认 20，最大 50' },
      },
    },
  },
};

baseTools.push(searchFundCacheTool);

// ---------------------------------------------------------------------------
// 资产配置 & 再平衡 & 全球市场 & 财务目标
// ---------------------------------------------------------------------------
const allocationTools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function' as const,
    function: {
      name: 'get_allocation_plan',
      description: '根据用户的财务目标（月投入、目标金额、期限）和风险偏好，计算建议的资产配置比例。适用于用户提出"我想达到XX目标"、"每月定投XX元想X年达到XX万"等目标导向问题时调用。',
      parameters: {
        type: 'object',
        properties: {
          monthly_investment: { type: 'number', description: '月投入金额（元）' },
          target_amount: { type: 'number', description: '目标金额（元）' },
          years_to_target: { type: 'number', description: '距离目标年数' },
          risk_level: { type: 'string', enum: ['low', 'medium', 'high'], description: '用户风险偏好' },
        },
        required: ['monthly_investment', 'target_amount', 'years_to_target', 'risk_level'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'check_rebalance',
      description: '检查当前持仓与目标资产配置的偏离度，输出哪些资产需要增持或减持。当用户询问"我的配置是否合理"、"是否需要调仓"时调用。',
      parameters: {
        type: 'object',
        properties: {
          holdings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                fund_code: { type: 'string', description: '基金代码' },
                market_value: { type: 'number', description: '当前市值（元）' },
                asset_class: { type: 'string', description: '资产大类：股票型基金、混合型基金、债券型基金、QDII、黄金ETF、货币基金' },
              },
              required: ['fund_code', 'market_value', 'asset_class'],
            },
          },
          targets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                assetClass: { type: 'string' },
                targetRatio: { type: 'number' },
              },
              required: ['assetClass', 'targetRatio'],
            },
          },
        },
        required: ['holdings', 'targets'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_global_index',
      description: '获取全球主要指数最新行情，包括标普500、纳斯达克、恒生指数、日经225等。适用于判断海外市场趋势、QDII投资时机。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_gold_etf',
      description: '获取国内黄金ETF实时行情。适用于考虑黄金作为避险资产配置时调用。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'set_financial_goal',
      description: '保存或更新用户的财务目标。当用户提出"我想X年攒到XX万"、"我的目标是XX"等目标设定时调用。目标会持久化到用户档案中。',
      parameters: {
        type: 'object',
        properties: {
          goal_name: { type: 'string', description: '目标名称，如"买房首付"、"子女教育"、"退休储备"' },
          target_amount: { type: 'number', description: '目标金额（元）' },
          years_to_target: { type: 'number', description: '期望达成年数' },
          monthly_investment: { type: 'number', description: '计划月投入（元）' },
        },
        required: ['goal_name', 'target_amount', 'years_to_target', 'monthly_investment'],
      },
    },
  },
];

baseTools.push(...allocationTools);

// ---------------------------------------------------------------------------
// 净值预警
// ---------------------------------------------------------------------------
const alertTools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function' as const,
    function: {
      name: 'set_price_alert',
      description:
        '为基金设置净值预警。当基金净值涨破或跌破目标价位时提醒用户。适用于用户说"帮我盯着"、"XX基金跌到X元提醒我"、"净值到X就告诉我"等场景。',
      parameters: {
        type: 'object',
        properties: {
          fund_code: { type: 'string', description: '基金代码，例如 000001' },
          direction: {
            type: 'string',
            enum: ['above', 'below'],
            description: 'above=涨破提醒, below=跌破提醒',
          },
          target_nav: { type: 'number', description: '目标净值' },
          note: { type: 'string', description: '备注（可选），如"抄底位置"' },
        },
        required: ['fund_code', 'direction', 'target_nav'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_price_alerts',
      description: '查看用户已设置的所有净值预警，包括已触发和未触发的。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'check_price_alerts',
      description:
        '检查所有活跃预警是否触发。会获取基金最新净值并与目标价位比较，返回触发结果。适用于用户问"我的预警到了吗"、"检查下有没有触发的"时调用。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'delete_price_alert',
      description: '删除指定预警。当用户说"取消预警"、"不用盯这只了"时调用。',
      parameters: {
        type: 'object',
        properties: {
          alert_id: { type: 'number', description: '预警ID，从 get_price_alerts 获取' },
        },
        required: ['alert_id'],
      },
    },
  },
];

baseTools.push(...alertTools);

if(config.search.baseURL) {
  baseTools.push(webSearchTool)
}

export const tools: OpenAI.Chat.ChatCompletionTool[] = baseTools
