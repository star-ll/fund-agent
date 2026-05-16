from contextlib import asynccontextmanager
from typing import Optional
import asyncio
import io
import math
import os
import time
from functools import partial

from PIL import Image, ImageFile
ImageFile.LOAD_TRUNCATED_IMAGES = True  # 兼容部分 App 生成的不规范 JPEG

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), "../.env"))

import akshare as ak
from fastapi import FastAPI, HTTPException, Query, UploadFile, File
import pandas as pd

from alibabacloud_ocr_api20210707.client import Client as OcrClient
from alibabacloud_ocr_api20210707 import models as ocr_models
from alibabacloud_tea_openapi import models as open_api_models


# ---------------------------------------------------------------------------
# 内存缓存
# ---------------------------------------------------------------------------

_cache: dict[str, tuple[pd.DataFrame, float]] = {}
_CACHE_TTL = 3600


def _get_cached(key: str) -> pd.DataFrame | None:
    if key in _cache:
        df, ts = _cache[key]
        if time.time() - ts < _CACHE_TTL:
            return df
    return None


def _set_cached(key: str, df: pd.DataFrame) -> None:
    _cache[key] = (df, time.time())


# ---------------------------------------------------------------------------
# akshare 调用统一走线程池（避免阻塞 asyncio 事件循环）
# ---------------------------------------------------------------------------

async def _run(fn, *args, **kwargs) -> pd.DataFrame:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, partial(fn, *args, **kwargs))


async def _cached_run(key: str, fn, *args, **kwargs) -> pd.DataFrame:
    cached = _get_cached(key)
    if cached is not None:
        return cached
    df = await _run(fn, *args, **kwargs)
    _set_cached(key, df)
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
    _cache.clear()
    return {"cleared": True}


# ---------------------------------------------------------------------------
# 基金基本信息
# ---------------------------------------------------------------------------

@app.get("/fund/info")
async def fund_info(fund_code: str = Query(..., description="基金代码，例如 000001")):
    try:
        df = await _cached_run("fund_daily", ak.fund_open_fund_daily_em)
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
        df = await _cached_run("fund_manager", ak.fund_manager_em)
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
        df = await _cached_run(f"fund_rank_{symbol}", ak.fund_open_fund_rank_em, symbol=symbol)
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
