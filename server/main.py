from contextlib import asynccontextmanager
from typing import Optional
import asyncio
import io
import json
import math
import os
import time
from functools import partial

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
}


def _get_cached(key: str) -> pd.DataFrame | None:
    raw = _redis.get(key)
    if raw:
        return pd.DataFrame(json.loads(raw))
    return None


def _set_cached(key: str, df: pd.DataFrame, ttl: int = 3600) -> None:
    _redis.setex(key, ttl, json.dumps(df.to_dict(orient="records"), ensure_ascii=False))


# ---------------------------------------------------------------------------
# akshare 调用统一走线程池（避免阻塞 asyncio 事件循环）
# ---------------------------------------------------------------------------

async def _run(fn, *args, **kwargs) -> pd.DataFrame:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, partial(fn, *args, **kwargs))


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

def _to_json(df: pd.DataFrame) -> list[dict]:
    df = df.copy()
    for col in df.columns:
        if pd.api.types.is_datetime64_any_dtype(df[col]):
            df[col] = df[col].dt.strftime("%Y-%m-%d")
        else:
            df[col] = df[col].astype(str)
    records = df.to_dict(orient="records")
    for row in records:
        for k, v in row.items():
            if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
                row[k] = None
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


@app.get("/market/index")
async def market_index(
    symbol: str = Query("上证系列指数", description=f"指数类型：{INDEX_TYPES}"),
):
    if symbol not in INDEX_TYPES:
        raise HTTPException(status_code=400, detail=f"symbol 必须为 {INDEX_TYPES} 之一")
    try:
        df = await _run(ak.stock_zh_index_spot_em, symbol=symbol)
        if df.empty:
            return []
        return _to_json(df)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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
            return cached.to_dict(orient="records")
        df = await _run(ak.fund_individual_achievement_xq, symbol=fund_code)
        if df.empty:
            return []
        _set_cached(cache_key, df, _TTL["fund_nav"])
        return _to_json(df)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# 基金数据分析（雪球：年化波动率、夏普比率、同类风险收益比）
# ---------------------------------------------------------------------------

@app.get("/fund/analysis")
async def fund_analysis(fund_code: str = Query(..., description="基金代码")):
    try:
        cache_key = f"fund_analysis_{fund_code}"
        cached = _get_cached(cache_key)
        if cached is not None:
            return cached.to_dict(orient="records")
        df = await _run(ak.fund_individual_analysis_xq, symbol=fund_code)
        if df.empty:
            return []
        _set_cached(cache_key, df, _TTL["fund_nav"])
        return _to_json(df)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# 基金盈利概率（雪球：持有满 X 时间的历史盈利概率及平均收益）
# ---------------------------------------------------------------------------

@app.get("/fund/profit-probability")
async def fund_profit_probability(fund_code: str = Query(..., description="基金代码")):
    try:
        cache_key = f"fund_profit_prob_{fund_code}"
        cached = _get_cached(cache_key)
        if cached is not None:
            return cached.to_dict(orient="records")
        df = await _run(ak.fund_individual_profit_probability_xq, symbol=fund_code)
        if df.empty:
            return []
        _set_cached(cache_key, df, _TTL["fund_nav"])
        return _to_json(df)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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
