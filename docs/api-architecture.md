# API 架构与回退策略

## 数据源分层

fund-agent 的 Python 数据服务（`server/main.py`）采用**多级回退**架构，确保单个数据源故障不影响服务可用性。

```
┌─────────────────────────────────────────────────┐
│                  API 端点                        │
├──────────┬──────────┬──────────┬────────────────┤
│ 全球指数  │ 基金信息  │ 净值历史  │ 雪球分析       │
│          │          │          │                │
│ yfinance │ akshare  │ akshare  │ akshare (雪球) │
│   ↓      │   ↓      │   ↓      │   ↓            │
│ stooq    │ 东方财富  │ 东方财富  │ 优雅降级([])   │
│   ↓      │ 直连API  │ 直连API  │                │
│ akshare  │          │          │                │
└──────────┴──────────┴──────────┴────────────────┘
```

---

## 端点详情

### `/market/global_index` — 全球指数行情

三级回退链：**yfinance → stooq.com → akshare**

| 层 | 数据源 | 覆盖范围 | 可靠性 | 备注 |
|----|--------|---------|--------|------|
| 主 | yfinance | 美股/港股/日股/欧股（8个指数） | 中 | Yahoo Finance 有频率限制 |
| 回退1 | stooq.com | 同上 | 高 | **免费、无需 API key**，波兰金融数据服务商 |
| 回退2 | akshare | 东方财富全球指数 | 低 | 依赖东方财富页面结构，**当前经常挂** |

stooq 符号映射：
```
标普500 → ^spx    纳斯达克 → ^ndq    道琼斯 → ^dji
恒生指数 → ^hsi   日经225 → ^n225    英国富时 → ^ftse
德国DAX → ^dax    法CAC40 → ^cac
```

### `/fund/info` — 基金基本信息

两路：**akshare（全量表）→ 东方财富直连搜索API**

东方财富回退可获取：基金名称、类型、最新净值、日增长率、累计净值。

使用的东方财富 API：
- `https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx` — 基金搜索（名称+类型+净值）
- `https://api.fund.eastmoney.com/f10/lsjz` — 净值历史（补充日增长率）

### `/fund/nav` — 基金净值历史

两路：**akshare → 东方财富直连 lsjz API**

回退最多取 5 页 × 30 条 = 150 条净值记录。

### `/fund/achievement` `/fund/analysis` `/fund/profit-probability` `/fund/hold-detail` — 雪球分析

单数据源（雪球），失败时**优雅降级返回空列表 `[]`** 而非 HTTP 500。

依赖 Redis 缓存（TTL 4小时），只要之前成功过一次就能继续服务。

---

## 维护原则

1. **永远加回退，不要只依赖单一爬虫**。AKShare 底层爬取东方财富/雪球页面，上游网站改版就会挂。
2. **优先免费无认证的数据源**（如 stooq.com），降低运维成本。
3. **回退尽量用直连 API**（如东方财富 `lsjz`），而非经过 akshare 中间层——少一层依赖少一个故障点。
4. **雪球端点天然脆弱**（反爬严格），不做多层回退，改为优雅降级 + Redis 缓存兜底。
5. **新增端点时同步更新本文档**。

---

## 相关文件

- `server/main.py` — 所有端点实现
- `server/pyproject.toml` — Python 依赖（含 yfinance, requests）
- `src/services/global.ts` — TypeScript 侧全球指数调用
- `src/services/fund.ts` — TypeScript 侧基金数据调用
