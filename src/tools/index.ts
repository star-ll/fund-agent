import type OpenAI from 'openai';

export const tools: OpenAI.Chat.ChatCompletionTool[] = [
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
  {
    type: 'function',
    function: {
      name: 'get_fund_nav',
      description: '获取基金净值历史数据，并返回年化收益率、最大回撤、波动率、夏普比率等指标',
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
  {
    type: 'function',
    function: {
      name: 'analyze_portfolio',
      description: '分析投资者持仓组合，计算总收益、年化收益、最大回撤、波动率等',
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
];
