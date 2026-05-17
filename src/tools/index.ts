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
  {
    type: 'function',
    function: {
      name: 'get_user_profile',
      description: '读取用户本地保存的持仓和个人信息档案。当用户询问自己的持仓、风险偏好等个人数据时调用。',
      parameters: { type: 'object', properties: {} },
    },
  },
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
