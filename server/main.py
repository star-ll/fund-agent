from contextlib import asynccontextmanager
from typing import Optional
import asyncio
import io
import json
import logging
import math
import os
import time
from functools import partial

_log = logging.getLogger("uvicorn.error")

from PIL import Image, ImageFile
ImageFile.LOAD_TRUNCATED_IMAGES = True

from dotenv import load_dotenv
# 本地开发时从上级目录加载 .env，容器内由 docker-compose env_file 注入
load_dotenv(os.path.join(os.path.dirname(__file__), "../.env"))

import akshare as ak
from fastapi import FastAPI, HTTPException, Query, UploadFile, File
import pandas as pd
import redis as redis_lib

from alibabacloud_ocr_api20210707.client import Client as OcrClient
from alibabacloud_ocr_api20210707 import models as ocr_models
from alibabacloud_tea_openapi import models as open_api_models


# ---------------------------------------------------------------------------
# Redis 缓存（替代原来的内存 dict）
# ---------------------------------------------------------------------------

_redis = redis_lib.Redis(
    host=os.environ.get("REDIS_HOST", "localhost"),
    port=int(os.environ.get("REDIS_PORT", 6379)),
    password=os.environ.get("REDIS_PASSWORD") or None,
    decode_responses=True,
)

_TTL = {
    "fund_daily":    86400,
    "fund_manager":  86400,
    "fund_rank":     14400,
    "fund_nav":      14400,
    "fund_estimate":  900,
    "market_index":   120,
}


def _get_cached(key: str) -> pd.DataFrame | None:
    raw = _redis.get(key)
    if raw:
        return pd.DataFrame(json.loads(raw))
    return None


def _set_cached(key: str, df: pd.DataFrame, ttl: int = 3600) -> None:
    records = df.to_dict(orient="records")
    for row in records:
        for k, v in row.items():
            if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
                row[k] = None
    _redis.setex(key, ttl, json.dumps(records, ensure_ascii=False))


# ---------------------------------------------------------------------------
# akshare 调用统一走线程池（避免阻塞 asyncio 事件循环）
# ---------------------------------------------------------------------------

_RUN_RETRIES = 3
_RUN_RETRY_DELAY_BASE = 2  # seconds, exponential backoff: 2s, 4s, 8s


async def _run(fn, *args, **kwargs) -> pd.DataFrame:
    """在线程池中调用 akshare，失败时自动重试（最多 3 次，指数退避）。"""
    loop = asyncio.get_event_loop()
    last_exc = None
    for attempt in range(_RUN_RETRIES):
        try:
            return await loop.run_in_executor(None, partial(fn, *args, **kwargs))
        except Exception as e:
            last_exc = e
            if attempt < _RUN_RETRIES - 1:
                delay = _RUN_RETRY_DELAY_BASE * (2 ** attempt)
                fn_name = getattr(fn, "__name__", str(fn))
                _log.warning(
                    "_run attempt %d/%d for %s failed: %s, retrying in %ds",
                    attempt + 1, _RUN_RETRIES, fn_name, str(e)[:200], delay,
                )
                await asyncio.sleep(delay)
    raise last_exc


async def _cached_run(key: str, ttl_key: str, fn, *args, **kwargs) -> pd.DataFrame:
    cached = _get_cached(key)
    if cached is not None:
        return cached
    df = await _run(fn, *args, **kwargs)
    _set_cached(key, df, _TTL.get(ttl_key, 3600))
    return df


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------

def _sanitize_value(v):
    """将单个值转为 JSON 可序列化形式（None 或 str）。"""
    if v is None:
        return None
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    # pd.isna 能捕获 np.nan、pd.NaT、pd.NA 等 non-float 缺失值
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    return str(v) if not isinstance(v, str) else v


# ---------------------------------------------------------------------------
# 东方财富直连 API 回退（当 akshare 调用失败时使用）
# ---------------------------------------------------------------------------

def _fetch_eastmoney_info(fund_code: str) -> dict | None:
    """从东方财富搜索 API 获取基金基本信息（名称/类型/最新净值）。"""
    import requests as req
    url = "https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx"
    resp = req.get(url, params={"m": "1", "key": fund_code}, timeout=15)
    resp.raise_for_status()
    data = resp.json()
    datas = data.get("Datas", [])
    if not datas:
        return None
    fund = datas[0]
    base = fund.get("FundBaseInfo", {})
    if not base:
        return None
    result = {
        "基金代码": fund_code,
        "基金简称": fund.get("NAME", ""),
        "类型": base.get("FTYPE", ""),
        "日期": base.get("FSRQ", ""),
        "单位净值": str(base.get("DWJZ", "")),
        "累计净值": "",
        "日增长率": "",
    }
    # 尝试从净值历史 API 获取日增长率
    try:
        lsjz_url = "https://api.fund.eastmoney.com/f10/lsjz"
        headers = {"Referer": "https://fundf10.eastmoney.com/"}
        resp2 = req.get(lsjz_url, params={"fundCode": fund_code, "pageIndex": 1, "pageSize": 2}, headers=headers, timeout=15)
        resp2.raise_for_status()
        jz_data = resp2.json()
        jz_list = jz_data.get("Data", {}).get("LSJZList", [])
        if len(jz_list) >= 2:
            result["日增长率"] = jz_list[0].get("JZZZL", "")
            result["累计净值"] = jz_list[0].get("LJJZ", "")
    except Exception:
        pass
    return result


def _fetch_eastmoney_nav(fund_code: str, page_size: int = 30) -> list[dict]:
    """从东方财富净值历史 API 获取净值走势。"""
    import requests as req
    results = []
    url = "https://api.fund.eastmoney.com/f10/lsjz"
    headers = {"Referer": "https://fundf10.eastmoney.com/"}
    for page in range(1, 6):  # 最多取 5 页 = 150 条
        resp = req.get(url, params={"fundCode": fund_code, "pageIndex": page, "pageSize": page_size}, headers=headers, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        items = data.get("Data", {}).get("LSJZList", [])
        if not items:
            break
        for item in items:
            results.append({
                "净值日期": item.get("FSRQ", ""),
                "单位净值": item.get("DWJZ", ""),
                "日增长率": item.get("JZZZL", ""),
            })
    return results


def _to_json(df: pd.DataFrame) -> list[dict]:
    df = df.copy()
    for col in df.columns:
        if pd.api.types.is_datetime64_any_dtype(df[col]):
            df[col] = df[col].dt.strftime("%Y-%m-%d")
        # 处理 object dtype 中的 Timestamp 对象
        elif df[col].dtype == object:
            mask = df[col].apply(lambda x: isinstance(x, pd.Timestamp))
            if mask.any():
                df.loc[mask, col] = df.loc[mask, col].apply(lambda x: x.strftime("%Y-%m-%d %H:%M:%S"))
    records = df.to_dict(orient="records")
    for row in records:
        for k, v in row.items():
            row[k] = _sanitize_value(v)
    return records


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


app = FastAPI(title="AKShare Fund API", version="1.0.0", lifespan=lifespan)


# ---------------------------------------------------------------------------
# 健康检查 / 缓存管理
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok"}


@app.delete("/cache")
def clear_cache():
    _redis.flushdb()
    return {"cleared": True}


# ---------------------------------------------------------------------------
# 基金基本信息
# ---------------------------------------------------------------------------

@app.get("/fund/info")
async def fund_info(fund_code: str = Query(..., description="基金代码，例如 000001")):
    try:
        df = await _cached_run("fund_daily", "fund_daily", ak.fund_open_fund_daily_em)
        row = df[df["基金代码"] == fund_code]
        if row.empty:
            raise HTTPException(status_code=404, detail=f"基金 {fund_code} 不存在")
        return _to_json(row)[0]
    except HTTPException:
        raise
    except Exception as e:
        # 回退：东方财富直连 API
        try:
            import requests
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(None, _fetch_eastmoney_info, fund_code)
            if result:
                return result
        except Exception:
            pass
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# 基金净值历史
# ---------------------------------------------------------------------------

VALID_INDICATORS = ["单位净值走势", "累计净值走势", "累计收益率走势", "同类排名走势", "同类超额收益走势"]
VALID_PERIODS = ["1月", "3月", "6月", "1年", "3年", "5年", "今年来", "成立来"]


@app.get("/fund/nav")
async def fund_nav(
    fund_code: str = Query(..., description="基金代码"),
    indicator: str = Query("单位净值走势", description=f"数据类型：{VALID_INDICATORS}"),
    period: str = Query("成立来", description=f"时间段：{VALID_PERIODS}"),
):
    if indicator not in VALID_INDICATORS:
        raise HTTPException(status_code=400, detail=f"indicator 必须为 {VALID_INDICATORS} 之一")
    if period not in VALID_PERIODS:
        raise HTTPException(status_code=400, detail=f"period 必须为 {VALID_PERIODS} 之一")
    try:
        df = await _run(ak.fund_open_fund_info_em, symbol=fund_code, indicator=indicator, period=period)
        if df.empty:
            return []
        return _to_json(df)
    except Exception as e:
        # 回退：东方财富直连净值历史 API（仅支持单位净值走势）
        try:
            loop = asyncio.get_event_loop()
            nav_data = await loop.run_in_executor(None, _fetch_eastmoney_nav, fund_code)
            if nav_data:
                return nav_data
        except Exception:
            pass
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# 基金经理
# ---------------------------------------------------------------------------

@app.get("/fund/manager")
async def fund_manager(
    fund_code: Optional[str] = Query(None, description="基金代码，不传则返回全部经理"),
):
    try:
        df = await _cached_run("fund_manager", "fund_manager", ak.fund_manager_em)
        if fund_code:
            mask = df["现任基金代码"].astype(str).str.contains(fund_code, na=False)
            df = df[mask]
            if df.empty:
                raise HTTPException(status_code=404, detail=f"未找到基金 {fund_code} 的经理信息")
        return _to_json(df)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# 基金持仓
# ---------------------------------------------------------------------------

@app.get("/fund/portfolio")
async def fund_portfolio(
    fund_code: str = Query(..., description="基金代码"),
    date: str = Query(..., description="年份，例如 2024"),
):
    try:
        df = await _run(ak.fund_portfolio_hold_em, symbol=fund_code, date=date)
        if df.empty:
            return []
        return _to_json(df)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# 基金排行
# ---------------------------------------------------------------------------

FUND_TYPES = ["全部", "股票型", "混合型", "债券型", "指数型", "QDII", "LOF", "FOF"]


@app.get("/fund/rank")
async def fund_rank(
    symbol: str = Query("全部", description=f"基金类型：{FUND_TYPES}"),
):
    if symbol not in FUND_TYPES:
        raise HTTPException(status_code=400, detail=f"symbol 必须为 {FUND_TYPES} 之一")
    try:
        df = await _cached_run(f"fund_rank_{symbol}", "fund_rank", ak.fund_open_fund_rank_em, symbol=symbol)
        if df.empty:
            return []
        return _to_json(df)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# 基金实时估值
# ---------------------------------------------------------------------------

@app.get("/fund/estimate")
async def fund_estimate(
    symbol: str = Query("全部", description="基金类型，默认全部"),
):
    try:
        df = await _run(ak.fund_value_estimation_em, symbol=symbol)
        if df.empty:
            return []
        return _to_json(df)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# 市场行情：A股主要指数实时行情
# ---------------------------------------------------------------------------

INDEX_TYPES = ["上证系列指数", "深证系列指数", "指数成份", "中证系列指数"]

# 常用指数名称列表（LLM 可能直接传入的单个指数名），用于更友好的 400 提示
COMMON_INDEX_NAMES = {
    "上证指数", "深证成指", "创业板指", "科创50", "沪深300",
    "中证500", "中证1000", "上证50", "中证红利", "北证50",
    "国证2000", "恒生指数", "恒生科技",
}


@app.get("/market/index")
async def market_index(
    symbol: str = Query("上证系列指数", description=f"指数名称或类型，例如：上证指数、沪深300、{INDEX_TYPES}"),
):
    # 不再限制 symbol 只能是 4 个分类名；AKShare 的 stock_zh_index_spot_em
    # 同时接受分类名和个股指数名。对于明确不支持的名称给出友好提示。
    try:
        df = await _cached_run(f"market_index_{symbol}", "market_index", ak.stock_zh_index_spot_em, symbol=symbol)
        if df.empty:
            return []
        return _to_json(df)
    except Exception as e:
        _log.exception("market_index(%s) failed", symbol)
        # 如果是已知的无效指数名，返回 400 而非 500
        err_msg = str(e).lower()
        if "not found" in err_msg or "不存在" in err_msg or "empty" in err_msg:
            raise HTTPException(status_code=400, detail=f"指数 '{symbol}' 无数据或名称无效")
        raise HTTPException(status_code=500, detail=f"指数行情获取失败: {str(e)[:200]}")


# ---------------------------------------------------------------------------
# 市场行情：北向资金净流入汇总
# ---------------------------------------------------------------------------

@app.get("/market/northbound")
async def market_northbound():
    try:
        df = await _run(ak.stock_hsgt_fund_flow_summary_em)
        if df.empty:
            return []
        return _to_json(df)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# 全球指数（yfinance → stooq.com → AKShare 三级回退）
# ---------------------------------------------------------------------------


def _fetch_yfinance(symbols_map: dict) -> list[dict]:
    """主数据源：yfinance（覆盖美股+港股+日股+欧股）。"""
    import yfinance as yf
    results = []
    tickers = yf.Tickers(" ".join(symbols_map.values()))
    for name, sym in symbols_map.items():
        try:
            t = tickers.tickers.get(sym)
            if t is None:
                continue
            hist = t.history(period="2d")
            if hist.empty:
                continue
            current = hist["Close"].iloc[-1]
            prev = hist["Close"].iloc[-2] if len(hist) > 1 else current
            change_pct = ((current - prev) / prev * 100) if prev != 0 else 0
            results.append({
                "名称": name,
                "最新价": str(round(float(current), 2)),
                "涨跌幅": f"{change_pct:+.2f}%",
                "日期": str(hist.index[-1].date()),
            })
        except Exception:
            pass
    return results


def _fetch_stooq(symbols_map: dict) -> list[dict]:
    """回退源 1：stooq.com（免费、无需 API key、覆盖全球主要指数）。"""
    import requests
    results = []
    # stooq 符号映射（注意：少数符号与 yfinance 不同）
    stooq_symbols = {
        "标普500": "^spx",
        "纳斯达克": "^ndq",
        "道琼斯": "^dji",
        "恒生指数": "^hsi",
        "日经225": "^n225",
        "英国富时100": "^ftse",
        "德国DAX": "^dax",
        "法CAC40": "^cac",
    }
    # 用名称→stooq符号的反向映射，保留原 symbols_map 的名称→显示名对应
    name_to_stooq = {name: stooq_symbols[name] for name in symbols_map if name in stooq_symbols}
    if not name_to_stooq:
        return results

    query = "+".join(name_to_stooq.values())
    url = f"https://stooq.com/q/l/?s={query}&f=sd2t2ohlcv&h&e=json"
    try:
        resp = requests.get(url, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        stooq_to_name = {v: k for k, v in name_to_stooq.items()}
        for item in data.get("symbols", []):
            sym_key = item.get("symbol", "").lower()
            name = stooq_to_name.get(sym_key)
            if not name:
                continue
            close_val = item.get("close")
            open_val = item.get("open")
            if close_val is None:
                continue
            change_pct = 0.0
            if open_val and open_val != 0:
                change_pct = (close_val - open_val) / open_val * 100
            results.append({
                "名称": name,
                "最新价": str(round(float(close_val), 2)),
                "涨跌幅": f"{change_pct:+.2f}%",
                "日期": str(item.get("date", "")),
            })
    except Exception:
        pass
    return results


def _fetch_akshare_global() -> list[dict]:
    """回退源 2：akshare 东方财富全球指数。"""
    results = []
    try:
        df = ak.index_global_spot_em()
        if df is None or df.empty:
            return results
        for _, row in df.iterrows():
            results.append({
                "名称": str(row.get("名称", "")),
                "最新价": str(row.get("最新价", "")),
                "涨跌幅": str(row.get("涨跌幅", "")),
            })
    except Exception:
        pass
    return results


@app.get("/market/global_index")
@app.get("/market/global")  # 别名兼容
async def market_global_index():
    """获取全球主要指数最新行情（三级回退：yfinance → stooq → akshare）。"""
    symbols = {
        "标普500": "^GSPC",
        "纳斯达克": "^IXIC",
        "道琼斯": "^DJI",
        "恒生指数": "^HSI",
        "日经225": "^N225",
        "英国富时100": "^FTSE",
        "德国DAX": "^GDAXI",
        "法CAC40": "^FCHI",
    }

    # 主数据源：yfinance
    loop = asyncio.get_event_loop()
    results = await loop.run_in_executor(None, _fetch_yfinance, symbols)

    # 回退 1：stooq.com（免费、无需 API key）
    if not results:
        results = await loop.run_in_executor(None, _fetch_stooq, symbols)

    # 回退 2：akshare 东方财富
    if not results:
        results = await loop.run_in_executor(None, _fetch_akshare_global)

    return results


# ---------------------------------------------------------------------------
# 黄金 ETF（AKShare：国内黄金 ETF 行情）
# ---------------------------------------------------------------------------

@app.get("/fund/gold_etf")
async def fund_gold_etf():
    """获取国内黄金 ETF 实时行情。"""
    try:
        df = await _run(ak.fund_etf_spot_em)
        if df.empty:
            return []
        # 筛选出黄金类 ETF（名称含"金"或"黄金"）
        mask = df["名称"].str.contains("金|黄金", na=False)
        gold = df[mask]
        if not gold.empty:
            # 只返回关键字段（排除时间戳列避免序列化问题）
            gold = gold[["代码", "名称", "最新价", "涨跌幅", "成交量", "成交额"]]
        return _to_json(gold) if not gold.empty else _to_json(df.head(50))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# 市场行情：指定行业板块历史K线（天天基金/东方财富）
# ---------------------------------------------------------------------------

@app.get("/market/sector")
async def market_sector(
    symbol: str = Query(..., description="行业名称，例如：互联网服务"),
    start_date: str = Query(..., description="开始日期，格式 YYYYMMDD"),
    end_date: str = Query(..., description="结束日期，格式 YYYYMMDD"),
    period: str = Query("daily", description="周期：daily / weekly / monthly"),
):
    try:
        df = await _run(
            ak.stock_board_industry_hist_em,
            symbol=symbol,
            start_date=start_date,
            end_date=end_date,
            period=period,
            adjust="",
        )
        if df.empty:
            return []
        return _to_json(df)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# 基金风险分析（雪球：年度+阶段收益、最大回撤、同类排名）
# ---------------------------------------------------------------------------

@app.get("/fund/achievement")
async def fund_achievement(fund_code: str = Query(..., description="基金代码")):
    try:
        cache_key = f"fund_achievement_{fund_code}"
        cached = _get_cached(cache_key)
        if cached is not None:
            return _to_json(cached)
        df = await _run(ak.fund_individual_achievement_xq, symbol=fund_code)
        if df.empty:
            return []
        _set_cached(cache_key, df, _TTL["fund_nav"])
        return _to_json(df)
    except KeyError:
        return []
    except Exception:
        # 雪球 API 不稳定，失败时返回空而非 500
        return []


# ---------------------------------------------------------------------------
# 基金数据分析（雪球：年化波动率、夏普比率、同类风险收益比）
# ---------------------------------------------------------------------------

@app.get("/fund/analysis")
async def fund_analysis(fund_code: str = Query(..., description="基金代码")):
    try:
        cache_key = f"fund_analysis_{fund_code}"
        cached = _get_cached(cache_key)
        if cached is not None:
            return _to_json(cached)
        df = await _run(ak.fund_individual_analysis_xq, symbol=fund_code)
        if df.empty:
            return []
        _set_cached(cache_key, df, _TTL["fund_nav"])
        return _to_json(df)
    except KeyError:
        return []
    except Exception:
        # 雪球 API 不稳定，失败时返回空而非 500
        return []


# ---------------------------------------------------------------------------
# 基金盈利概率（雪球：持有满 X 时间的历史盈利概率及平均收益）
# ---------------------------------------------------------------------------

@app.get("/fund/profit-probability")
async def fund_profit_probability(fund_code: str = Query(..., description="基金代码")):
    try:
        cache_key = f"fund_profit_prob_{fund_code}"
        cached = _get_cached(cache_key)
        if cached is not None:
            return _to_json(cached)
        df = await _run(ak.fund_individual_profit_probability_xq, symbol=fund_code)
        if df.empty:
            return []
        _set_cached(cache_key, df, _TTL["fund_nav"])
        return _to_json(df)
    except KeyError:
        return []
    except Exception:
        # 雪球 API 不稳定，失败时返回空而非 500
        return []


# ---------------------------------------------------------------------------
# 基金行业配置（天天基金：持仓行业占净值比例，按季度）
# ---------------------------------------------------------------------------

@app.get("/fund/industry")
async def fund_industry(
    fund_code: str = Query(..., description="基金代码"),
    date: str = Query(..., description="年份，例如 2024"),
):
    try:
        df = await _run(ak.fund_portfolio_industry_allocation_em, symbol=fund_code, date=date)
        if df.empty:
            return []
        return _to_json(df)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# 债券持仓（天天基金：债券名称、占净值比例、持仓市值）
# ---------------------------------------------------------------------------

@app.get("/fund/bond-portfolio")
async def fund_bond_portfolio(
    fund_code: str = Query(..., description="基金代码"),
    date: str = Query(..., description="年份，例如 2023"),
):
    try:
        df = await _run(ak.fund_portfolio_bond_hold_em, symbol=fund_code, date=date)
        if df.empty:
            return []
        return _to_json(df)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# 基金评级（天天基金：上证/招商/济安评级，缓存整表按代码过滤）
# ---------------------------------------------------------------------------

@app.get("/fund/rating")
async def fund_rating(fund_code: str = Query(..., description="基金代码")):
    try:
        df = await _cached_run("fund_rating_all", "fund_manager", ak.fund_rating_all)
        row = df[df["代码"].astype(str) == fund_code]
        if row.empty:
            raise HTTPException(status_code=404, detail=f"基金 {fund_code} 暂无评级数据")
        return _to_json(row)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# 大类资产配置（雪球：股票/现金/其他仓位占比，按季度日期）
# ---------------------------------------------------------------------------

@app.get("/fund/hold-detail")
async def fund_hold_detail(
    fund_code: str = Query(..., description="基金代码"),
    date: str = Query(..., description="季度日期，格式 20231231"),
):
    try:
        df = await _run(ak.fund_individual_detail_hold_xq, symbol=fund_code, date=date)
        if df.empty:
            return []
        return _to_json(df)
    except Exception:
        # 雪球 API 不稳定，失败时返回空而非 500
        return []


# ---------------------------------------------------------------------------
# OCR（阿里云 RecognizeAllText）
# ---------------------------------------------------------------------------

def _make_ocr_client() -> OcrClient:
    cfg = open_api_models.Config(
        access_key_id=os.environ.get("ALIYUN_ACCESS_KEY_ID", ""),
        access_key_secret=os.environ.get("ALIYUN_ACCESS_KEY_SECRET", ""),
    )
    cfg.endpoint = "ocr-api.cn-hangzhou.aliyuncs.com"
    return OcrClient(cfg)


def _resize_if_needed(data: bytes) -> bytes:
    """阿里云 OCR 限制单边最大 8192px，超出则等比压缩。"""
    img = Image.open(io.BytesIO(data))
    max_side = max(img.width, img.height)
    if max_side <= 8000:
        return data
    ratio = 8000 / max_side
    new_size = (int(img.width * ratio), int(img.height * ratio))
    img = img.resize(new_size, Image.LANCZOS)
    buf = io.BytesIO()
    fmt = img.format or "JPEG"
    img.save(buf, format=fmt)
    return buf.getvalue()


def _do_ocr(data: bytes) -> str:
    data = _resize_if_needed(data)
    client = _make_ocr_client()
    request = ocr_models.RecognizeAllTextRequest(
        type="General",
        body=io.BytesIO(data),
    )
    response = client.recognize_all_text(request)
    data_obj = response.body.data
    if not data_obj:
        return ""
    if data_obj.content:
        return data_obj.content.strip()
    if data_obj.sub_images:
        return "\n".join(s.content for s in data_obj.sub_images if s.content).strip()
    return ""


@app.post("/ocr")
async def ocr_image(file: UploadFile = File(..., description="图片文件，支持 PNG / JPG")):
    """使用阿里云 OCR 识别图片文字。"""
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="只支持图片文件（image/*）")
    if not os.environ.get("ALIYUN_ACCESS_KEY_ID"):
        raise HTTPException(status_code=500, detail="未配置 ALIYUN_ACCESS_KEY_ID")
    try:
        data = await file.read()
        loop = asyncio.get_event_loop()
        text = await loop.run_in_executor(None, _do_ocr, data)
        return {"text": text}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
