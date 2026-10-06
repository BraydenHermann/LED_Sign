import os
import io
import json as _json
import asyncio
import struct
import datetime
import shutil
import tempfile
import math
import glob
import time
import unicodedata
from typing import List, Optional, Any, Union
from fastapi import FastAPI, HTTPException, Request, BackgroundTasks
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from bleak import BleakClient, BleakScanner
from PIL import Image, ImageDraw, ImageFont
from loy_web_protocol import LOYWebProtocol
from calendar_service import CalendarService


def hex_to_rgb_global(hex_str: Optional[str], default=(0,0,0)):
    if not hex_str: return default
    hex_str = hex_str.lstrip('#')
    if len(hex_str) != 6: return default
    try:
        return tuple(int(hex_str[i:i+2], 16) for i in (0, 2, 4))
    except ValueError:
        return default

def normalize_for_sign(text: str) -> str:
    """Strip diacritics/accents so hardware-limited signs receive pure ASCII.
    e.g. 'SÃ©bastien' â†’ 'Sebastien', 'naÃ¯ve' â†’ 'naive', 'Å“' â†’ 'oe'
    """
    if not text:
        return text
    text = text.replace('Å“', 'oe').replace('Å’', 'OE').replace('Ã¦', 'ae').replace('Ã†', 'AE')
    text = text.replace('â€™', "'").replace('â€˜', "'").replace('â€œ', '"').replace('â€', '"')
    text = text.replace('â€“', '-').replace('â€”', '-').replace('â€¦', '...')
    return ''.join(
        c for c in unicodedata.normalize('NFD', text)
        if unicodedata.category(c) != 'Mn'
    )

def save_preview(img: Image.Image, path: str):
    """Atomically save image so uvicorn never serves a half-written file."""
    dir_ = os.path.dirname(path)
    with tempfile.NamedTemporaryFile(suffix='.png', dir=dir_, delete=False) as tmp:
        tmp_path = tmp.name
    try:
        img.save(tmp_path)
        shutil.move(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass
        raise

ble_lock = asyncio.Lock()
# Selecting a saved slot updates the shared current.gif/current.png preview.
# Keep those file swaps ordered when a user taps several presets in quick
# succession, otherwise two requests can remove each other's active preview.
preset_switch_lock = asyncio.Lock()

async def cancel_active_worker():
    global active_scroller_task
    if active_scroller_task and not active_scroller_task.done():
        task = active_scroller_task
        active_scroller_task = None
        task.cancel()
        try:
            await asyncio.wait_for(task, timeout=1.5)
        except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
            pass
        await asyncio.sleep(0.05)

async def write_large_gatt_char(client: BleakClient, char_uuid: str, data: bytes, response: bool = True, chunk_size: Optional[int] = None, delay: float = 0.002):
    """Writes a potentially large bytearray/bytes payload by chunking it.
    Protected by ble_lock to prevent concurrent BLE operations on Windows.
    """
    if not client or not getattr(client, "is_connected", False):
        raise RuntimeError("Sign is not connected")
    try:
        async with ble_lock:
            if chunk_size is None:
                mtu = getattr(client, "mtu_size", 23)
                chunk_size = max(20, min(244, mtu - 3))
                
            if len(data) <= chunk_size:
                await client.write_gatt_char(char_uuid, bytearray(data), response=response)
                return
            for i in range(0, len(data), chunk_size):
                chunk = data[i:i+chunk_size]
                is_last = (i + chunk_size >= len(data))
                await client.write_gatt_char(char_uuid, bytearray(chunk), response=(response and is_last))
                if delay > 0:
                    await asyncio.sleep(delay)
    except Exception as e:
        print(f"[BLE write_large_gatt_char error] {e}")
        raise

def save_preview_bytes(data: bytes, path: str):
    """Publish complete previews; never truncate a GIF being served."""
    with tempfile.NamedTemporaryFile(dir=os.path.dirname(path), delete=False) as tmp:
        tmp.write(data)
        temporary = tmp.name
    try:
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

async def safe_write_gatt_char(char_uuid: str, data: Union[bytes, bytearray], response: bool = True):
    global connected_client, connection_ready
    if connected_client and connected_client.is_connected and getattr(connected_client, "_backend", None):
        try:
            async with ble_lock:
                await connected_client.write_gatt_char(char_uuid, bytearray(data), response=response)
        except Exception as e:
            print(f"[safe_write_gatt_char error] {e}")
            raise
    else:
        raise RuntimeError("Sign is not connected")

async def stop_all_playback(blank: bool = False):
    """Halts the onboard hardware playlist engine and clock."""
    global connected_client, connection_ready
    if connected_client and connected_client.is_connected and connection_ready:
        try:
            await safe_write_gatt_char(protocol.WRITE_UUID, protocol.stop_playlist_command(), response=True)
            await asyncio.sleep(0.02)
            await safe_write_gatt_char(protocol.WRITE_UUID, protocol.clock_off_command(), response=True)
            await asyncio.sleep(0.02)
            if blank:
                await safe_write_gatt_char(protocol.WRITE_UUID, protocol.clear_all_command(), response=True)
                await asyncio.sleep(0.02)
        except Exception as e:
            print(f"[stop_all_playback error] {e}")

app = FastAPI()
_calendar_bg_task = None
@app.on_event("startup")
async def startup_event():
    global current_display_mode, active_scroller_task
    current_display_mode = "none"
    print("LED Sign Server running!")
