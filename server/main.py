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
import gemini_service


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
last_notified_event_id = None
last_pushed_event_id = None

async def calendar_background_loop():
    global current_display_mode, last_notified_event_id, last_pushed_event_id
    
    while True:
        await asyncio.sleep(10)
        
        if preset_switch_lock.locked():
            continue
            
        try:
            if not (os.path.exists(calendar_service.token_path) or (calendar_service.creds is not None and calendar_service.creds.valid)):
                continue

            events = calendar_service.get_today_events(clean_name=True)
            if not events:
                continue
                
            now_local = datetime.datetime.now().astimezone()
            
            target_event = None
            for ev in events:
                if ev.get('response_status', '').lower() == 'declined':
                    continue
                start_iso = ev.get('start_iso')
                end_iso = ev.get('end_iso')
                if not start_iso or not end_iso:
                    continue
                
                try:
                    start_dt = datetime.datetime.fromisoformat(start_iso)
                    end_dt = datetime.datetime.fromisoformat(end_iso)
                except ValueError:
                    continue
                
                if start_dt - datetime.timedelta(minutes=5) <= now_local <= end_dt:
                    target_event = ev
                    break
                    
            if target_event:
                event_id = target_event['id']
                summary = target_event.get('summary', 'Event')
                time_str = target_event.get('time', '')
                
                if last_notified_event_id != event_id:
                    last_notified_event_id = event_id
                    try:
                        from win11toast import toast
                        start_dt = datetime.datetime.fromisoformat(target_event['start_iso'])
                        minutes_until = max(0, round((start_dt - now_local).total_seconds() / 60.0))
                        time_label = 'now' if minutes_until <= 1 else f'in {minutes_until} min'
                        icon_path = os.path.abspath(os.path.join(STATIC_DIR, '..', '..', 'client', 'public', 'favicon.ico'))
                        toast('Upcoming Meeting', f'{summary} starts {time_label}', duration='short', icon=icon_path if os.path.exists(icon_path) else None)
                    except Exception as e:
                        print(f"[calendar] Notification error: {e}")
                
                if last_pushed_event_id != event_id:
                    last_pushed_event_id = event_id
                    try:
                        req = PushTextRequest(text=f"{summary} ||| {time_str}")
                        await push_text(req)
                        print(f"[auto-push] Pushed calendar event to sign: {summary}")
                    except Exception as e:
                        print(f"[auto-push] Failed to push calendar event: {e}")
        except Exception as e:
            print(f"[calendar] Background loop error: {e}")

@app.on_event("startup")
async def startup_event():
    print("LED Sign Server running!")

protocol = LOYWebProtocol()
calendar_service = CalendarService()

# Hardware State
connected_client: Optional[BleakClient] = None
connection_ready: bool = False
active_scroller_task: Optional[asyncio.Task] = None
frames_sent: int = 0
PANEL_W = 64
PANEL_H = 20

# Dashboard State
current_display_mode: str = "static"

current_width: int = 64
current_speed: int = 8
brightness: int = 15
power: bool = True
start_time = datetime.datetime.now()
ui_last_seen_monotonic: float = 0.0

# Clock State (last pushed clock configuration)
current_clock_color: str = "#ffffff"
current_clock_bg_color: str = "#000000"
current_clock_format: str = "24h"
current_clock_show_seconds: bool = True
current_clock_style: str = "default"

# Hardware Slots State
# Hardware Slots State
hardware_slots_state = {i: {"slot_id": i, "occupied": False, "key": ""} for i in range(60)}
notification_buffer = bytearray()

# Reconnect state
last_connected_mac: str = ""
_reconnect_task: Optional[asyncio.Task] = None


@app.post("/ui-heartbeat")
async def ui_heartbeat():
    """Lets the desktop launcher know an LED Sign browser tab is already open."""
    global ui_last_seen_monotonic
    ui_last_seen_monotonic = time.monotonic()
    return {"status": "ok"}


@app.get("/ui-open")
async def ui_open():
    return {"open": (time.monotonic() - ui_last_seen_monotonic) < 15.0}

async def _auto_reconnect(mac: str, delay: float = 4.0):
    """Background task: waits `delay` seconds then tries to reconnect to `mac`."""
    global connected_client, connection_ready, _reconnect_task
    await asyncio.sleep(delay)
    if connected_client and connected_client.is_connected:
        print(f"[auto_reconnect] Already reconnected, skipping.")
        _reconnect_task = None
        return
    print(f"[auto_reconnect] Attempting reconnect to {mac}...")
    try:
        req = ConnectRequest(address=mac)
        result = await _connect_internal(req)
        print(f"[auto_reconnect] Reconnect result: {result}")
    except Exception as e:
        print(f"[auto_reconnect] Reconnect failed: {e}")
    _reconnect_task = None

def notification_handler(sender, data: bytearray):
    global hardware_slots_state, notification_buffer
    try:
        notification_buffer.extend(data)
        while len(notification_buffer) >= 10:
            idx = notification_buffer.find(b'\xaa\x55')
            if idx == -1:
                notification_buffer.clear()
                break
            if idx > 0:
                del notification_buffer[:idx]
            if len(notification_buffer) < 10:
                break

            pkt_len = struct.unpack('<H', notification_buffer[4:6])[0]
            total_pkt_len = pkt_len + 4
            if len(notification_buffer) < total_pkt_len:
                break

            packet = bytes(notification_buffer[:total_pkt_len])
            del notification_buffer[:total_pkt_len]

            cmd_type = packet[8]
            sub_type = packet[9]
            cmd = packet[10]

            if cmd_type == 0x81 and sub_type == 0x83 and cmd == 0x35:
                payload = packet[10:-2] if len(packet) > 12 else packet[10:]
                if len(payload) > 3 and payload[0] == 0x35 and payload[1] == 0x81:
                    entries = payload[3:]
                elif len(payload) > 2 and payload[0] == 0x81:
                    entries = payload[2:]
                elif len(payload) > 1:
                    entries = payload[1:]
                else:
                    entries = b''

                i = 0
                while i + 21 <= len(entries):
                    s_id = entries[i]
                    s_key = entries[i+1:i+21]
                    is_occ = any(b != 0 for b in s_key)
                    if 0 <= s_id < 60:
                        hardware_slots_state[s_id] = {
                            "slot_id": s_id,
                            "occupied": is_occ,
                            "key": s_key.hex()
                        }
                    i += 21
                occ_slots = [s for s, v in hardware_slots_state.items() if v.get("occupied")]
                print(f"[notification_handler] Hardware slot inventory updated. Occupied slots: {occ_slots}")
    except Exception as e:
        print(f"[notification_handler error] {e}")


# Enable CORS for frontend Vite dev server (port 5173) to backend communication
cors_origins_env = os.getenv("LED_SIGN_CORS_ORIGINS", "")
if cors_origins_env:
    allow_origins = [o.strip() for o in cors_origins_env.split(",")]
else:
    allow_origins = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8000",
        "http://127.0.0.1:8000"
    ]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
if not os.path.exists(STATIC_DIR):
    os.makedirs(STATIC_DIR)

# Small in-memory status map for browser-side progress while a preset is being
# written to a hardware slot. Entries are keyed by a client-generated id.
save_progress: dict[str, dict[str, Any]] = {}

# Mount static folder so frontend can read preview images
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

class ConnectRequest(BaseModel):
    address: str

class PushTextRequest(BaseModel):
    text: Optional[Any] = ""
    textColor: Optional[Any] = "#FFFFFF"
    bgColor: Optional[Any] = "#000000"
    animation: Optional[Any] = "static"
    speed: Optional[Any] = None
    rotation: Optional[Any] = 0
    mirror: Optional[Any] = False
    spacing: Optional[Any] = 1
    views: Optional[Any] = 1
    mode: Optional[Any] = "text"
    pixels: Optional[Any] = None
    pixelsRgbB64: Optional[str] = None
    fileType: Optional[Any] = None
    frameDurationMs: Optional[Any] = None  # Exact per-frame delay for GIF/video animations
    name: Optional[Any] = None
    id: Optional[Any] = None

    model_config = {"extra": "allow"}

class RenderTextPreviewRequest(BaseModel):
    text: Optional[str] = ""
    textColor: Optional[str] = "#FFFFFF"
    bgColor: Optional[str] = "#000000"

class ProcessGifRequest(BaseModel):
    imgSrc: str
    canvasX: float
    canvasY: float
    zoom: float
    dwBase: float
    dhBase: float
    bgColor: Optional[str] = "#000000"

class ProcessVideoRequest(BaseModel):
    videoB64: str
    canvasX: float
    canvasY: float
    zoom: float
    dwBase: float
    dhBase: float
    bgColor: Optional[str] = "#000000"

class GeminiAttachment(BaseModel):
    data: str
    mimeType: Optional[str] = "image/png"

class GeminiGenerateRequest(BaseModel):
    prompt: str
    mediaType: Optional[str] = "gif"
    attachments: Optional[List[GeminiAttachment]] = None
    apiKey: Optional[str] = None
    style: Optional[str] = None

class GeminiConfigRequest(BaseModel):
    apiKey: Optional[str] = None
    model: Optional[str] = None
    imageModel: Optional[str] = None
    defaultMode: Optional[str] = None

def process_gif_pixels(img_src: str, x: float, y: float, w: float, h: float, bg_color: str) -> tuple:
    import base64
    from io import BytesIO
    
    # Extract base64 part
    if "," in img_src:
        _, base64_data = img_src.split(",", 1)
    else:
        base64_data = img_src
    
    gif_bytes = base64.b64decode(base64_data)
    img = Image.open(BytesIO(gif_bytes))
    
    gif_duration_ms = img.info.get("duration", 100)
    delay_sec = gif_duration_ms / 1000.0
    recommended_speed = (0.4 - delay_sec) / 0.025
    recommended_speed = max(1, min(15, int(round(recommended_speed))))
    # Store actual gif_duration_ms for precise per-frame timing
    actual_duration_ms = gif_duration_ms
    
    num_frames = getattr(img, "n_frames", 1)
    if num_frames > 300:
        raise ValueError(f"GIF is too long ({num_frames} frames). Maximum supported is 300 frames.")
    
    def hex_to_rgb(hex_str: Optional[str]):
        if not hex_str:
            return (0, 0, 0)
        hex_str = hex_str.lstrip('#')
        if len(hex_str) != 6:
            return (0, 0, 0)
        return tuple(int(hex_str[i:i+2], 16) for i in (0, 2, 4))
        
    bg_rgb = hex_to_rgb(bg_color)
    
    gif_bytes = base64.b64decode(base64_data)
    img = Image.open(BytesIO(gif_bytes))
    
    # Use seek() to correctly apply GIF disposal and compositing per-frame
    extracted_frames = []
    frame_durations_ms = []
    n_frames = getattr(img, "n_frames", 1)
    for i in range(n_frames):
        try:
            img.seek(i)
            extracted_frames.append(img.copy().convert("RGBA"))
            frame_durations_ms.append(max(16, int(img.info.get("duration", gif_duration_ms) or gif_duration_ms)))
        except EOFError:
            break
            
    num_frames = len(extracted_frames)
    if num_frames > 300:
        raise ValueError(f"GIF is too long ({num_frames} frames). Maximum supported is 300 frames.")
    
    frames_list = []
    for f in range(num_frames):
        composite_frame = extracted_frames[f]
        
        panel = Image.new("RGBA", (64, 20), bg_rgb + (255,))
        w_val = max(1, int(round(w)))
        h_val = max(1, int(round(h)))
        frame_resized = composite_frame.resize((w_val, h_val), Image.Resampling.LANCZOS)
        
        x_val = int(round(x))
        y_val = int(round(y))
        panel.paste(frame_resized, (x_val, y_val), frame_resized)
        
        panel_rgb = panel.convert("RGB")
        pixel_data = list(panel_rgb.getdata())
        
        frame_pixels = []
        for r_val, g_val, b_val in pixel_data:
            if bg_color == '#000000' and r_val < 16 and g_val < 16 and b_val < 16:
                frame_pixels.append(0)
            else:
                rounded_r = min(255, max(0, int(round(r_val / 16.0)) * 16))
                rounded_g = min(255, max(0, int(round(g_val / 16.0)) * 16))
                rounded_b = min(255, max(0, int(round(b_val / 16.0)) * 16))
                frame_pixels.append(f"#{rounded_r:02x}{rounded_g:02x}{rounded_b:02x}")
                
        frames_list.append(frame_pixels)
        
    final_pixels = []
    for r in range(20):
        for f in range(num_frames):
            start_idx = r * 64
            for c in range(64):
                final_pixels.append(frames_list[f][start_idx + c])
                
    return final_pixels, recommended_speed, actual_duration_ms, frame_durations_ms


@app.post("/process-gif")
async def process_gif(req: ProcessGifRequest):
    try:
        w = req.dwBase * req.zoom
        h = req.dhBase * req.zoom
        pixels, speed, duration_ms, frame_durations_ms = process_gif_pixels(req.imgSrc, req.canvasX, req.canvasY, w, h, req.bgColor or "#000000")
        # Return the RGB pixels directly â€” process_gif_pixels() already renders full-color
        # RGB frames. Applying quantize_frames() here (MAXCOVERAGE â†’ 3 colors) was causing
        # drastic color corruption (e.g. beer mug GIF turning mostly yellow on re-save).
        import base64; b = bytearray(); [b.extend((int(p[1:3],16),int(p[3:5],16),int(p[5:7],16)) if p and isinstance(p, str) and p.startswith("#") else (0,0,0)) for p in pixels]; rgb64 = base64.b64encode(b).decode("ascii"); return {"pixels": pixels, "pixelsRgbB64": rgb64, "speed": speed, "frameDurationMs": duration_ms, "frameDurationsMs": frame_durations_ms}
    except Exception as e:
        print(f"Error processing GIF: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/process-video")
def process_video(req: ProcessVideoRequest):
    """Decode uploaded video locally instead of seeking once per frame in the browser."""
    import base64
    temp_path = None
    cap = None
    try:
        import cv2
        raw = base64.b64decode(req.videoB64)
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as temp:
            temp.write(raw)
            temp_path = temp.name

        cap = cv2.VideoCapture(temp_path)
        if not cap.isOpened():
            raise ValueError("Unable to decode video")
        fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
        fps = max(1.0, min(60.0, fps))
        frame_duration_ms = max(16, int(round(1000 / fps)))
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        if total_frames > 300:
            raise ValueError(f"Video is too long ({total_frames} frames). Maximum supported is 300 frames.")
        step = 1.0
        bg_rgb = hex_to_rgb_global(req.bgColor or "#000000")
        width = max(1, int(round(req.dwBase * req.zoom)))
        height = max(1, int(round(req.dhBase * req.zoom)))
        x = int(round(req.canvasX))
        y = int(round(req.canvasY))
        frames = []
        # Extract all frames up to the hardware limit
        source_index = 0
        while len(frames) < total_frames:
            ok, bgr = cap.read()
            if not ok:
                break
            source_index += 1
            if source_index - 1 < int(len(frames) * step):
                continue
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            source = Image.fromarray(rgb, "RGB")
            panel = Image.new("RGB", (PANEL_W, PANEL_H), bg_rgb)
            panel.paste(source.resize((width, height), Image.Resampling.LANCZOS), (x, y))
            pixels = []
            for r, g, b in panel.getdata():
                if (req.bgColor or "#000000").lower() == "#000000" and r < 16 and g < 16 and b < 16:
                    pixels.append(0)
                else:
                    pixels.append(f"#{min(255, max(0, int(round(r / 16.0)) * 16)):02x}{min(255, max(0, int(round(g / 16.0)) * 16)):02x}{min(255, max(0, int(round(b / 16.0)) * 16)):02x}")
            frames.append(pixels)
        cap.release()
        if not frames:
            raise ValueError("Video contains no readable frames")
        stitched = []
        for row in range(PANEL_H):
            for frame in frames:
                stitched.extend(frame[row * PANEL_W:(row + 1) * PANEL_W])
        import base64; b = bytearray(); [b.extend((int(p[1:3],16),int(p[3:5],16),int(p[5:7],16)) if p and isinstance(p, str) and p.startswith("#") else (0,0,0)) for p in stitched]; rgb64 = base64.b64encode(b).decode("ascii"); return {"pixels": stitched, "pixelsRgbB64": rgb64, "frameDurationMs": frame_duration_ms, "frameDurationsMs": [frame_duration_ms] * len(frames)}
    except Exception as e:
        print(f"Error processing video: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if cap is not None:
            cap.release()
        if temp_path:
            try:
                os.unlink(temp_path)
            except OSError:
                pass


@app.get("/api/gemini/status")
@app.get("/gemini-status")
async def gemini_status():
    try:
        return gemini_service.check_status()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/gemini/config")
@app.post("/gemini-config")
async def gemini_config(req: GeminiConfigRequest):
    try:
        data = {}
        if req.apiKey is not None:
            data["api_key"] = req.apiKey
        if req.model is not None:
            data["model"] = req.model
        if req.imageModel is not None:
            data["image_model"] = req.imageModel
        if req.defaultMode is not None:
            data["default_mode"] = req.defaultMode
        return gemini_service.save_config(data)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/gemini/generate")
@app.post("/gemini-generate")
async def gemini_generate(req: GeminiGenerateRequest):
    try:
        prompt = req.prompt.strip()
        if not prompt:
            raise ValueError("Prompt cannot be empty.")
        media_type = (req.mediaType or "gif").lower()
        attachments = [{"data": a.data, "mimeType": a.mimeType or "image/png"} for a in (req.attachments or [])]
        
        def _run_gen():
            if media_type == "image":
                return gemini_service.generate_still_image(prompt, attachments=attachments, api_key=req.apiKey)
            elif media_type == "video":
                return gemini_service.generate_video(prompt, attachments=attachments, api_key=req.apiKey)
            else:
                return gemini_service.generate_animated_gif(prompt, attachments=attachments, api_key=req.apiKey)

        return await asyncio.to_thread(_run_gen)
    except Exception as e:
        print(f"Error in gemini_generate: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/status")
async def get_status():
    global connected_client, connection_ready, frames_sent, current_display_mode, current_width, current_speed, brightness, power
    global current_clock_color, current_clock_bg_color, current_clock_format, current_clock_show_seconds, current_clock_style
    
    connected = connected_client is not None and connected_client.is_connected and connection_ready
    address = connected_client.address if connected else None
    
    preview_url = None
    preview_ts = 0
    if connected:
        gif_path = os.path.join(STATIC_DIR, "current.gif")
        png_path = os.path.join(STATIC_DIR, "current.png")
        if os.path.exists(gif_path):
            preview_url = "/static/current.gif"
            try:
                preview_ts = os.path.getmtime(gif_path)
            except Exception:
                pass
        elif os.path.exists(png_path):
            preview_url = "/static/current.png"
            try:
                preview_ts = os.path.getmtime(png_path)
            except Exception:
                pass
        
    calendar_connected = os.path.exists(calendar_service.token_path) or (calendar_service.creds is not None and calendar_service.creds.valid)
    
    uptime_delta = datetime.datetime.now() - start_time
    hours, remainder = divmod(int(uptime_delta.total_seconds()), 3600)
    minutes, seconds = divmod(remainder, 60)
    uptime_str = f"{hours}h {minutes}m {seconds}s"
    
    return {
        "connected": connected,
        "api_version": 4,
        "address": address,
        "preview_url": preview_url,
        "preview_ts": preview_ts,
        "calendar_connected": calendar_connected,
        "uptime": uptime_str,
        "frames": frames_sent,
        "power": power,
        "speed": current_speed,
        "brightness": brightness,
        "width": current_width,
        "display_mode": current_display_mode,
        "clock_color": current_clock_color,
        "clock_bg_color": current_clock_bg_color,
        "clock_format": current_clock_format,
        "clock_show_seconds": current_clock_show_seconds,
        "clock_style": current_clock_style
    }


connect_lock = asyncio.Lock()

async def _connect_internal(req: ConnectRequest):
    global connected_client, connection_ready
    target_mac = (req.address or "").strip().upper()
    if connected_client and connected_client.is_connected:
        if not target_mac or (connected_client.address and connected_client.address.upper() == target_mac):
            connection_ready = True
            return {"status": "success", "connected": True, "address": connected_client.address}

    connection_ready = False
    if connected_client:
        try:
            if connected_client.is_connected:
                await connected_client.stop_notify(protocol.NOTIFY_UUID)
                await connected_client.disconnect()
        except Exception:
            pass
        connected_client = None
        await asyncio.sleep(0.5)

    client = None

    try:
        target_mac = (req.address or "").strip().upper()
        print(f"[connect] Target LED sign: {target_mac or 'auto-discover'}...")

        def on_disconnect(c):
            global connected_client, connection_ready, last_connected_mac, _reconnect_task
            addr = getattr(c, 'address', 'unknown')
            print(f"[BLE] Device disconnected callback: {addr}")
            connected_client = None
            connection_ready = False
            # Schedule background auto-reconnect
            mac_to_reconnect = last_connected_mac or (addr if addr != 'unknown' else '')
            if mac_to_reconnect and (_reconnect_task is None or _reconnect_task.done()):
                print(f"[BLE] Scheduling auto-reconnect to {mac_to_reconnect} in 4s...")
                loop = asyncio.get_event_loop()
                _reconnect_task = loop.create_task(_auto_reconnect(mac_to_reconnect, delay=4.0))

        client = None
        last_connect_error = None
        max_attempts = 2

        for attempt in range(max_attempts):
            found_device = None
            stop_event = asyncio.Event()

            def detection_callback(device, adv_data):
                nonlocal found_device
                addr = device.address.upper()
                name = (device.name or adv_data.local_name or "").upper()
                services = [s.lower() for s in (adv_data.service_uuids or [])]

                if target_mac:
                    if addr == target_mac:
                        found_device = device
                        stop_event.set()
                else:
                    is_sign = (
                        "0000fff0-0000-1000-8000-00805f9b34fb" in services
                        or "HELLO" in name
                        or "SIGN" in name
                        or name.startswith("YS")
                        or name.startswith("TL")
                        or name.startswith("LOY")
                    )
                    if is_sign:
                        found_device = device
                        stop_event.set()

            scanner = BleakScanner(detection_callback=detection_callback, scanning_mode="active")
            try:
                await scanner.start()
                try:
                    scan_wait = 4.0 if target_mac else 6.0
                    await asyncio.wait_for(stop_event.wait(), timeout=scan_wait)
                except asyncio.TimeoutError:
                    pass
            except Exception as scan_err:
                print(f"[connect] Scanner error: {scan_err}")
            finally:
                try:
                    await scanner.stop()
                except Exception:
                    pass

            if not found_device and target_mac:
                print(f"[connect] Attempt {attempt + 1}: Sign {target_mac} not detected in live scan; attempting direct address connection...")
                found_device = target_mac
            elif not found_device:
                print(f"[connect] Attempt {attempt + 1}: Auto-discover sign not found in scan, retrying...")
                await asyncio.sleep(1.0)
                continue

            try:
                c = BleakClient(found_device, disconnected_callback=on_disconnect)
                await c.connect(timeout=8.0)
                if c.is_connected:
                    # Validate that the connected device actually has the LOY WRITE characteristic!
                    write_char = None
                    for s in c.services:
                        for ch in s.characteristics:
                            if ch.uuid.lower() == protocol.WRITE_UUID.lower():
                                write_char = ch
                                break
                        if write_char:
                            break
                    if not write_char:
                        print(f"[connect] Connected device {getattr(c, 'address', '')} is missing WRITE_UUID {protocol.WRITE_UUID}!")
                        try:
                            await c.disconnect()
                        except Exception:
                            pass
                        raise Exception(f"Device {getattr(c, 'address', '')} is not a valid LED sign (missing characteristic {protocol.WRITE_UUID}).")

                    client = c
                    break
            except Exception as ce:
                last_connect_error = ce
                import traceback; traceback.print_exc(); print(f"[connect] Attempt {attempt + 1} connection failed: {ce}")
                try:
                    await c.disconnect()
                except Exception:
                    pass
                if attempt < max_attempts - 1:
                    await asyncio.sleep(1.0)

        if not client or not client.is_connected:
            raise Exception(
                f"Could not connect to sign after {max_attempts} attempts. "
                f"Last error: {last_connect_error or 'Device not found in range'}. "
                "Try: 1) Toggle your PC Bluetooth off and on, 2) Power cycle the sign, 3) Remove the sign from Windows Bluetooth settings and re-pair."
            )

        client_address = client.address

        # Subscribe to notifications for slot query replies
        try:
            await client.start_notify(protocol.NOTIFY_UUID, notification_handler)
            print("[connect] Subscribed to NOTIFY_UUID notifications.")
        except Exception as ne:
            print(f"[connect] Warning starting notify: {ne}")

        connected_client = client

        # Ensure sign display is powered on
        try:
            await safe_write_gatt_char(protocol.WRITE_UUID, protocol.power_command(True), response=False)
            await asyncio.sleep(0.05)
        except Exception:
            pass

        # Stop any hardware clock and halt boot playlist immediately upon connection
        await stop_all_playback(blank=False)
        try:
            # Query hardware slot inventory (first 12 slots only)
            await safe_write_gatt_char(protocol.WRITE_UUID, protocol.build_query_slots_command(0, 12), response=False)
            await asyncio.sleep(0.05)
        except Exception as se:
            print(f"[connect] Warning initializing slots: {se}")

        connection_ready = True
        last_connected_mac = client_address.upper() if client_address else ""
        return {"status": "success", "address": client_address}
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        print(f"[connect] FAILED: {type(e).__name__}: {e}")
        if connected_client == client or not (connected_client and connected_client.is_connected):
            connected_client = None
            connection_ready = False
        raise HTTPException(status_code=408, detail=f"{type(e).__name__}: {e}")

@app.post("/connect")
async def connect(req: ConnectRequest):
    async with connect_lock:
        return await _connect_internal(req)

@app.post("/disconnect")
async def disconnect():
    global connected_client, connection_ready, current_display_mode
    connection_ready = False
    if connected_client:
        try:
            await connected_client.stop_notify(protocol.NOTIFY_UUID)
        except Exception:
            pass
        try:
            await connected_client.disconnect()
        except Exception:
            pass
        connected_client = None
        await asyncio.sleep(0.5)
        
    current_display_mode = "none"
        
    return {"status": "success"}

@app.get("/hardware-slots")
async def get_hardware_slots(mac: str = ""):
    global connected_client, connection_ready, hardware_slots_state
            
    current_mac = (mac or (connected_client.address if connected_client else "") or "").replace(':', '').lower()
    slots_res = []
    for slot_id in range(12):
        slot_data = hardware_slots_state.get(slot_id, {"slot_id": slot_id, "occupied": False})
        slot_info = dict(slot_data)
        slot_info["slot_id"] = slot_id

        json_path = None
        gif_path = None
        if current_mac:
            jf = os.path.join(STATIC_DIR, f"preset_{current_mac}_{slot_id}.json")
            gf = os.path.join(STATIC_DIR, f"preset_{current_mac}_{slot_id}.gif")
            if os.path.exists(jf): json_path = jf
            if os.path.exists(gf): gif_path = gf

        if json_path and os.path.exists(json_path):
            try:
                with open(json_path, "r") as fj:
                    slot_info["preset_data"] = _json.load(fj)
                    # Older video uploads cached compact stitched RGB without
                    # preview pixels. Recover those rows for the card player.
                    cached = slot_info["preset_data"]
                    if cached.get("pixelsRgbB64") and not cached.get("pixels"):
                        import base64
                        rgb = base64.b64decode(cached["pixelsRgbB64"])
                        cached["pixels"] = ["#" + rgb[i:i + 3].hex() for i in range(0, len(rgb), 3)]
                        cached.pop("pixelsRgbB64", None)
                    slot_info["occupied"] = True
            except Exception:
                pass
        if gif_path and os.path.exists(gif_path):
            rel_name = os.path.basename(gif_path)
            slot_info["preview_url"] = f"/static/{rel_name}"
            slot_info["occupied"] = True

        if not json_path and not gif_path:
            slot_info["occupied"] = False
            slot_info["preset_data"] = None
            slot_info["preview_url"] = None

        slots_res.append(slot_info)
    return {"slots": slots_res}
@app.post("/clear")
async def clear():
    global connected_client, connection_ready, active_scroller_task, current_display_mode, current_width
    
    # Cancel any active scrolling/flipper task cleanly
    await cancel_active_worker()
        
    if connected_client and connected_client.is_connected and connection_ready:
        try:
            await stop_all_playback(blank=True)
            await safe_write_gatt_char(protocol.WRITE_UUID, protocol.session_start_command(), response=True)
            await asyncio.sleep(0.02)
            await safe_write_gatt_char(protocol.WRITE_UUID, protocol.clear_all_command(), response=True)
            await asyncio.sleep(0.02)
            await safe_write_gatt_char(protocol.WRITE_UUID, protocol.session_end_command(), response=True)
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
            
    # Clear dashboard preview
    try:
        gif_path = os.path.join(STATIC_DIR, "current.gif")
        if os.path.exists(gif_path):
            try:
                os.remove(gif_path)
            except Exception:
                pass
        black_img = Image.new("RGB", (PANEL_W, PANEL_H), "#000000")
        black_img.save(os.path.join(STATIC_DIR, "current.png"))
        current_width = PANEL_W
        current_display_mode = "static"
        global frames_sent
        frames_sent += 1
    except Exception:
        pass
        
    return {"status": "success"}

@app.post("/power")
async def set_power(on: bool):
    global connected_client, connection_ready, power
    if connected_client and connected_client.is_connected and connection_ready:
        try:
            packet = protocol.power_command(on)
            await safe_write_gatt_char(protocol.WRITE_UUID, packet, response=True)
            power = on
            return {"status": "success"}
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
    power = on
    return {"status": "success"}

@app.post("/brightness")
async def set_brightness(level: int):
    global connected_client, connection_ready, brightness
    if connected_client and connected_client.is_connected and connection_ready:
        try:
            packet = protocol.brightness_command(level)
            await safe_write_gatt_char(protocol.WRITE_UUID, packet, response=True)
            brightness = level
            return {"status": "success"}
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
    brightness = level
    return {"status": "success"}

@app.post("/speed")
async def set_speed(level: int):
    global current_speed
    current_speed = level
    return {"status": "success"}

@app.post("/preset")
async def play_preset(id: int, mac: str = ""):
    async with preset_switch_lock:
        return await _play_preset(id, mac)


async def _play_preset(id: int, mac: str = ""):
    print(f"[DEBUG] /preset called with id={id}, mac={mac}")
    global connected_client, connection_ready, active_scroller_task, current_display_mode, frames_sent
    import json as _json

    if not connected_client or not connected_client.is_connected or not connection_ready:
        raise HTTPException(status_code=409, detail="Sign is not connected")

    # Cancel any active scroller/animation task
    if active_scroller_task:
        active_scroller_task.cancel()
        active_scroller_task = None

    try:
        mac_str = (mac or (connected_client.address if connected_client else "") or "").replace(':', '').lower()
        json_path = os.path.join(STATIC_DIR, f"preset_{mac_str}_{id}.json")
        gif_path  = os.path.join(STATIC_DIR, f"preset_{mac_str}_{id}.gif")
        if not os.path.exists(json_path) and not os.path.exists(gif_path):
            raise HTTPException(status_code=404, detail=f"Slot {id + 1} has no saved preset")
        current_display_mode = f"preset-{id}"

        # Update live preview from saved file
        current_gif = os.path.join(STATIC_DIR, "current.gif")
        current_png = os.path.join(STATIC_DIR, "current.png")
        if os.path.exists(json_path):
            with open(json_path, "r") as fj:
                preset_data = _json.load(fj)
            
            if preset_data.get("mode") == "clock":
                now = datetime.datetime.now()
                fmt = preset_data.get("timeFormat", "12h")
                c_style = preset_data.get("clockStyle", "default") or "default"
                c_color = preset_data.get("textColor", "#FFFFFF")
                c_bg = preset_data.get("bgColor", "#000000")
                show_sec = preset_data.get("showSeconds", True)
                if show_sec is None: show_sec = True

                preview_img, _ = render_clock_frame(now, fmt, c_style, c_color, c_bg, show_sec)
                preview_img.save(current_png, format="PNG")
                if os.path.exists(current_gif):
                    try: os.remove(current_gif)
                    except Exception: pass

                if connected_client and connected_client.is_connected and connection_ready:
                    if active_scroller_task:
                        active_scroller_task.cancel()
                        active_scroller_task = None
                    try:
                        await safe_write_gatt_char(protocol.WRITE_UUID, protocol.power_command(True), response=True)
                        await asyncio.sleep(0.05)
                    except Exception:
                        pass
                    if c_style == 'default':
                        await safe_write_gatt_char(protocol.WRITE_UUID, protocol.clock_on_command(), response=True)
                    else:
                        await set_clock(on=True, color=c_color, bg_color=c_bg, format=fmt, show_seconds=show_sec, clock_style=c_style)
                current_display_mode = "clock"
                frames_sent += 1
                return {"status": "success"}

            anim_name = preset_data.get("animation")
            is_anim = preset_data.get("fileType") in ("gif", "video") or (preset_data.get("pixels") and len(preset_data.get("pixels")) > 1280) or (anim_name and anim_name not in ("static", "show now"))
            
            if is_anim:
                if os.path.exists(gif_path):
                    shutil.copy(gif_path, current_gif)
                if os.path.exists(current_png):
                    try: os.remove(current_png)
                    except Exception: pass
            else:
                if os.path.exists(gif_path):
                    try:
                        im = Image.open(gif_path)
                        im.seek(0)
                        im.convert("RGB").save(current_png)
                    except Exception:
                        pass
                if os.path.exists(current_gif):
                    try: os.remove(current_gif)
                    except Exception: pass
        frames_sent += 1

        if connected_client and connected_client.is_connected and connection_ready:
            # Ensure display power is awake and any active clock mode is exited before selecting slot
            try:
                await safe_write_gatt_char(protocol.WRITE_UUID, protocol.power_command(True), response=True)
                await asyncio.sleep(0.05)
                await safe_write_gatt_char(protocol.WRITE_UUID, protocol.clock_off_command(), response=True)
                await asyncio.sleep(0.1)
            except Exception:
                pass
            # Tell sign to display this specific saved slot in continuous single mode
            select_pkt = protocol.build_slot_select_command(id)
            await safe_write_gatt_char(protocol.WRITE_UUID, select_pkt, response=True)
            await asyncio.sleep(0.05)
            play_pkt = protocol.build_user_slot_play_command(id, loop_mode=0)
            await safe_write_gatt_char(protocol.WRITE_UUID, play_pkt, response=True)
            await asyncio.sleep(0.05)

        return {"status": "success"}
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/scan")
async def scan_devices():
    global connected_client, connection_ready
    try:
        found_map = {}

        # If currently connected to a sign, include it directly so user can see it
        if connected_client and connected_client.is_connected and connected_client.address:
            cur_addr = connected_client.address.upper()
            found_map[cur_addr] = {
                "name": "LED Sign (Connected)",
                "adv_name": getattr(connected_client, "name", None) or "LED Sign",
                "address": connected_client.address,
                "rssi": -40,
                "is_led": True
            }

        def on_detected(device, adv_data):
            addr = device.address.upper()
            name = (device.name or adv_data.local_name or "").strip()
            services = [s.lower() for s in (adv_data.service_uuids or [])]
            rssi = adv_data.rssi or -99

            is_led = (
                addr.startswith("FF:24:10:29:")
                or "0000fff0-0000-1000-8000-00805f9b34fb" in services
                or "0000ffe0-0000-1000-8000-00805f9b34fb" in services
                or "HELLO" in name.upper()
                or "SIGN" in name.upper()
                or "LOY" in name.upper()
                or name.upper().startswith("YS")
                or name.upper().startswith("TL")
                or name.upper().startswith("LEO")
            )

            display_name = name or ("LED Sign" if is_led else "")
            if not display_name and not is_led:
                return

            if addr not in found_map:
                found_map[addr] = {
                    "name": display_name,
                    "adv_name": adv_data.local_name or (name if name else None),
                    "address": device.address,
                    "rssi": rssi,
                    "is_led": is_led
                }
            else:
                if name:
                    found_map[addr]["name"] = name
                if is_led:
                    found_map[addr]["is_led"] = True
                if adv_data.local_name:
                    found_map[addr]["adv_name"] = adv_data.local_name
                if rssi and rssi > -99:
                    found_map[addr]["rssi"] = rssi

        await BleakScanner.discover(timeout=8.0, return_adv=True, detection_callback=on_detected)

        results = list(found_map.values())
        results.sort(key=lambda x: (0 if x["is_led"] else 1, -(x.get("rssi") or -99)))
        print(f"[scan] Returning {len(results)} device(s) ({sum(1 for r in results if r['is_led'])} LED sign(s))")
        return results
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/auth/url")
async def auth_url():
    try:
        url = calendar_service.get_auth_url()
        return {"url": url}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/auth/callback")
async def auth_callback(code: str):
    try:
        calendar_service.fetch_token(code)
        return HTMLResponse(content="<h1>Authentication successful! You can close this window now.</h1><script>window.close();</script>")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/auth/logout")
async def logout():
    try:
        if os.path.exists(calendar_service.token_path):
            os.remove(calendar_service.token_path)
        calendar_service.creds = None
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/calendar/today")
async def get_today_events(clean_name: bool = True):
    try:
        events = calendar_service.get_today_events(clean_name=clean_name)
        if events is None:
            return {"events": []}
        return {"events": events}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

async def scroller_worker(text_img: Image.Image, text_color: str):
    """Background task to push scrolling frames to hardware and update preview."""
    global connected_client, connection_ready, current_speed, current_width, frames_sent, current_display_mode
    tw, th = text_img.size
    full_w = tw + PANEL_W
    # Create 1-bit canvas for scrolling
    canvas = Image.new('1', (full_w, PANEL_H), 0)
    canvas.paste(text_img, (PANEL_W, 0))
    try:
        while True:
            # Shift by 2 pixels for smoothness
            for offset in range(0, full_w, 2):
                if not connected_client or not connected_client.is_connected or not connection_ready:
                    print("[scroller] Connection lost. Stopping scroller.")
                    return
                
                frame = Image.new('1', (PANEL_W, PANEL_H), 0)
                frame.paste(canvas, (-offset, 0))
                
                pixels = list(frame.getdata())
                bitmap = [1 if p > 0 else 0 for p in pixels]
                packet = protocol.bitmap_command(bitmap, PANEL_W, PANEL_H, color=text_color)
                
                # Start Session
                await connected_client.write_gatt_char(protocol.WRITE_UUID, protocol.session_start_command(), response=True)
                await asyncio.sleep(0.002)
                
                # Write the whole packet and let Bleak handle MTU chunking
                await connected_client.write_gatt_char(protocol.WRITE_UUID, bytearray(packet), response=False)
                await asyncio.sleep(0.02)
                
                # Speed control delay
                delay = max(0.02, 0.2 - (current_speed * 0.012))
                await asyncio.sleep(delay) 
    except asyncio.CancelledError:
        print("[scroller] Stopped.")
    except Exception as e:
        print(f"[scroller] Error: {e}")

def extract_frames(pixels: List[Any], num_frames: int) -> List[List[Any]]:
    width = 64 * num_frames
    frames = [[] for _ in range(num_frames)]
    for r in range(20):
        row_start = r * width
        for f in range(num_frames):
            frame_row = pixels[row_start + f * 64 : row_start + (f + 1) * 64]
            frames[f].extend(frame_row)
    return frames

def quantize_frames(frames_pixels: List[List[Any]], bg_color_hex: str) -> List[List[Optional[str]]]:
    def hex_to_rgb(hex_str: Optional[str]):
        if not hex_str:
            return (0, 0, 0)
        hex_str = hex_str.lstrip('#')
        if len(hex_str) != 6:
            return (0, 0, 0)
        return tuple(int(hex_str[i:i+2], 16) for i in (0, 2, 4))

    def rgb_to_hex(rgb):
        return f"#{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}"

    bg_color_hex = (bg_color_hex or "#000000").lower()
    bg_rgb = hex_to_rgb(bg_color_hex)
    
    num_frames = len(frames_pixels)
    if num_frames == 0:
        return []
        
    canonical_frames = []
    for f_pix in frames_pixels:
        frame_canon = []
        for p in f_pix:
            val = None
            if p is None or p == 0 or p == "0" or p == "#000000" or p is False:
                val = bg_color_hex if bg_color_hex != "#000000" else None
            elif isinstance(p, str) and p.startswith("#"):
                val = p.lower()
            elif isinstance(p, (int, float)) and not isinstance(p, bool):
                if math.isnan(p):
                    val = bg_color_hex if bg_color_hex != "#000000" else None
                elif p > 0.4:
                    val = "#ffffff"
                else:
                    val = bg_color_hex if bg_color_hex != "#000000" else None
            elif p is True:
                val = "#ffffff"
            else:
                val = "#ffffff"
            
            frame_canon.append(val)
        canonical_frames.append(frame_canon)

    width = 64 * num_frames
    height = 20
    
    # Build all_rgbs row-by-row of the stitched image
    all_rgbs = []
    for r in range(height):
        for f in range(num_frames):
            for c in range(64):
                val = canonical_frames[f][r * 64 + c]
                if val is None:
                    all_rgbs.append(bg_rgb)
                else:
                    all_rgbs.append(hex_to_rgb(val))
    
    pil_img = Image.new("RGB", (width, height))
    pil_img.putdata(all_rgbs)
    
    # 6 colors preserves full fidelity (e.g. red background, yellow beer, white foam, accents)
    # while keeping BLE packet count small enough (<=6 packets/frame) to prevent dropped packets.
    quantized_img = pil_img.quantize(colors=6, method=Image.Quantize.MAXCOVERAGE)
    rgb_quantized = quantized_img.convert("RGB")
    quantized_rgbs = list(rgb_quantized.getdata())
    
    quantized_frames_list = []
    for f in range(num_frames):
        frame_pixels = []
        for r in range(20):
            row_start = r * width
            for c in range(64):
                rgb_val = quantized_rgbs[row_start + f * 64 + c]
                hex_val = rgb_to_hex(rgb_val)
                
                orig_idx = r * 64 + c
                if canonical_frames[f][orig_idx] is None:
                    frame_pixels.append(None)
                else:
                    frame_pixels.append(hex_val)
        quantized_frames_list.append(frame_pixels)
        
    return quantized_frames_list


def save_gif_preview(frames_pixels: List[List[Any]], bg_color_hex: str, delay_sec: float, path: str):
    """Slices the stitched pixels, creates PIL images, and atomically saves as animated GIF."""
    if not frames_pixels:
        return
    if hasattr(frames_pixels[0], "save"):
        pil_frames = frames_pixels
    else:
        def hex_to_rgb(hex_str: Optional[str]):
            if not hex_str:
                return (0, 0, 0)
            hex_str = hex_str.lstrip('#')
            if len(hex_str) != 6:
                return (255, 255, 255)
            return tuple(int(hex_str[i:i+2], 16) for i in (0, 2, 4))
            
        bg_rgb = hex_to_rgb(bg_color_hex)
        pil_frames = []
        
        for f_pixels in frames_pixels:
            frame_rgbs = []
            for p in f_pixels:
                if p is None or p == 0 or p == "0" or p == "#000000" or p is False:
                    frame_rgbs.append(bg_rgb)
                elif isinstance(p, str) and p.startswith("#"):
                    frame_rgbs.append(hex_to_rgb(p))
                else:
                    frame_rgbs.append((255, 255, 255) if p else bg_rgb)
                    
            img = Image.new("RGB", (64, 20))
            img.putdata(frame_rgbs)
            pil_frames.append(img)
        
    if not pil_frames:
        return
        
    duration_ms = int(delay_sec * 1000)
    
    dir_ = os.path.dirname(path)
    with tempfile.NamedTemporaryFile(suffix='.gif', dir=dir_, delete=False) as tmp:
        tmp_path = tmp.name
    try:
        pil_frames[0].save(
            tmp_path,
            save_all=True,
            append_images=pil_frames[1:],
            duration=duration_ms,
            loop=0,
            optimize=False
        )
        shutil.move(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass
        raise

async def animation_worker(frames_pixels: List[List[Any]], bg_color_hex: str, speed: int, frame_duration_ms: Optional[float] = None):
    """Background task to loop animation frames on physical sign over BLE."""
    global connected_client, connection_ready
    
    bg_color_hex = (bg_color_hex or "#000000").lower()
    
    try:
        # Pre-calculate packets for each frame
        frame_packets = []
        for f_pixels in frames_pixels:
            packets = []
            
            # 1. Foreground Colors
            pixel_colors = []
            for p in f_pixels:
                if p is None or p == 0 or p == "0" or p == "#000000" or p is False:
                    pixel_colors.append(None)
                elif isinstance(p, str) and p.startswith("#"):
                    pixel_colors.append(p.lower())
                else:
                    pixel_colors.append("#ffffff")
                    
            # 2. Clear/Background (inverted bitmap - only write background color where foreground is not)
            bg_bitmap = [1 if (pixel_colors[idx] is None or pixel_colors[idx] == bg_color_hex) else 0 for idx in range(len(pixel_colors))]
            bg_packet = protocol.bitmap_command(bg_bitmap, PANEL_W, PANEL_H, color=bg_color_hex)
            packets.append(bg_packet)
                    
            unique_colors = set([c for c in pixel_colors if c is not None and c != bg_color_hex])
            for color in unique_colors:
                bitmap = [1 if pixel_colors[idx] == color else 0 for idx in range(len(pixel_colors))]
                packet = protocol.bitmap_command(bitmap, PANEL_W, PANEL_H, color=color)
                packets.append(packet)
                
            frame_packets.append(packets)
            
        # Use exact frame duration if provided (from GIF metadata or video duration/numFrames),
        # otherwise fall back to speed-slider formula.
        if frame_duration_ms is not None and frame_duration_ms > 0:
            delay = max(0.016, frame_duration_ms / 1000.0)  # min ~60fps
            print(f"[animation_worker] Using exact frame duration: {frame_duration_ms:.1f}ms ({1000/frame_duration_ms:.1f}fps)")
        else:
            delay = max(0.01, (80 - speed * 5) / 1000.0)
            print(f"[animation_worker] Using speed-based delay: {delay*1000:.0f}ms (speed={speed})")
        
        if connected_client and connected_client.is_connected and connection_ready:
            await connected_client.write_gatt_char(protocol.WRITE_UUID, protocol.clock_off_command(), response=True)
            await asyncio.sleep(0.05)
            
        frame_idx = 0
        num_frames = len(frame_packets)
        
        while True:
            if not connected_client or not connected_client.is_connected or not connection_ready:
                print("[animation_worker] Connection lost. Stopping animation.")
                break
                
            frame_start = asyncio.get_event_loop().time()
            
            # Start session for the frame
            await safe_write_gatt_char(protocol.WRITE_UUID, protocol.session_start_command(), response=False)
            
            packets = frame_packets[frame_idx]
            
            # Send all color bitmap packets back-to-back as ONE atomic burst
            for packet in packets:
                await write_large_gatt_char(connected_client, protocol.WRITE_UUID, bytearray(packet), response=False, delay=0.0)
                    
            # End/commit session for the frame to display all pixels atomically
            await safe_write_gatt_char(protocol.WRITE_UUID, protocol.session_end_command(), response=True)
            
            frame_idx = (frame_idx + 1) % num_frames
            
            # Calculate elapsed time and compensate sleep duration
            elapsed = asyncio.get_event_loop().time() - frame_start
            sleep_time = max(0.002, delay - elapsed)
            await asyncio.sleep(sleep_time)
            
    except asyncio.CancelledError:
        print("[animation_worker] Stopped.")
    except Exception as e:
        print(f"[animation_worker] Error: {e}")

async def push_ystp_to_display(ystp_files: List[bytes]):
    """Pushes full-fidelity 24-bit RGB YSTP frame(s) to live display RAM (0xC5).
    Renders all 64x20 pixels simultaneously in a single atomic hardware refresh!
    """
    global connected_client, connection_ready
    if not connected_client or not connected_client.is_connected or not connection_ready:
        return
        
    try:
        hw_addr = 0xC5
        num_files = len(ystp_files)
        CHUNK_SIZE = 960

        # Turn off clock mode if active
        await connected_client.write_gatt_char(protocol.WRITE_UUID, protocol.clock_off_command(), response=True)
        await asyncio.sleep(0.05)

        # 1. Session Init for live display RAM (0xC5)
        session_pkt = protocol.build_file_transfer_session_init(hw_addr=hw_addr, num_files=num_files)
        await write_large_gatt_char(connected_client, protocol.WRITE_UUID, session_pkt, response=True)
        await asyncio.sleep(0.05)

        # 2. Transfer each YSTP file (frame)
        for fi, ystp in enumerate(ystp_files):
            ystp_chunk_count = (len(ystp) + CHUNK_SIZE - 1) // CHUNK_SIZE
            ystp_hdr = protocol.build_file_header(hw_addr=hw_addr, file_index=fi)
            await write_large_gatt_char(connected_client, protocol.WRITE_UUID, ystp_hdr, response=True)
            await asyncio.sleep(0.03)

            for ci in range(ystp_chunk_count):
                chunk = ystp[ci * CHUNK_SIZE : (ci + 1) * CHUNK_SIZE]
                pkt = protocol.build_file_transfer_chunk(
                    hw_addr=hw_addr, file_index=fi, chunk_index=ci,
                    total_chunks=ystp_chunk_count, data=chunk, chunk_size=CHUNK_SIZE)
                await write_large_gatt_char(connected_client, protocol.WRITE_UUID, pkt, response=True)
                await asyncio.sleep(0.02)

        await asyncio.sleep(0.05)

        # 3. Commit Flush to display RAM (0xC5)
        flush_pkt = protocol.build_packet(bytes([0x08, 0x02, 0x00, hw_addr]), cmd_type=0xC1, sub_type=0x02)
        await write_large_gatt_char(connected_client, protocol.WRITE_UUID, flush_pkt, response=True)
        await asyncio.sleep(0.03)

        # 4. Activate live display RAM (Packet [119]: 35 19 C5 ...)
        config_bytes = bytes([0x01, 0x99, 0x01, 0x99, 0x01, 0x99, 0x01, 0x99, 0x01, 0x99, 0x01, 0x99, 0x01, 0x99, 0x02, 0x02, 0x50, 0x73, 0x01, 0x98])
        save_payload = bytes([0x35, 0x19, hw_addr]) + config_bytes + bytes([0, 0, 0, 0])
        save_pkt = protocol.build_packet(save_payload, cmd_type=0xC1, sub_type=0x02)
        await write_large_gatt_char(connected_client, protocol.WRITE_UUID, save_pkt, response=True)
        print(f"[push_ystp_to_display] Rendered {num_files} frame(s) to 0xC5 live display RAM successfully.")
    except Exception as e:
        print(f"[push_ystp_to_display] Error: {e}")

def transform_image(img: Image.Image, rotation: int = 0, mirror: bool = False) -> Image.Image:
    if mirror:
        img = img.transpose(Image.FLIP_LEFT_RIGHT)
    if rotation == 90:
        img = img.transpose(Image.ROTATE_90)
    elif rotation == 180:
        img = img.transpose(Image.ROTATE_180)
    elif rotation == 270:
        img = img.transpose(Image.ROTATE_270)
    return img

def truncate_text_to_width(text: str, font, max_width: int) -> str:
    temp_img = Image.new("1", (1, 1))
    draw = ImageDraw.Draw(temp_img)
    
    # Check if whole text fits
    bbox = draw.textbbox((0, 0), text, font=font)
    if (bbox[2] - bbox[0]) <= max_width:
        return text
        
    # Truncate character by character and append "..."
    for i in range(len(text) - 1, 0, -1):
        truncated = text[:i] + "..."
        bbox = draw.textbbox((0, 0), truncated, font=font)
        if (bbox[2] - bbox[0]) <= max_width:
            return truncated
            
    return "..."

def render_text_image(text: str, font, text_color: str, bg_color: str):
    temp_img = Image.new("RGB", (1, 1), bg_color)
    draw = ImageDraw.Draw(temp_img)
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    
    w = max(PANEL_W, tw)
    
    # RGB version for dashboard
    rgb_img = Image.new("RGB", (w, PANEL_H), bg_color)
    rgb_draw = ImageDraw.Draw(rgb_img)
    
    # 1-bit version for hardware
    bit_img = Image.new("1", (w, PANEL_H), 0)
    bit_draw = ImageDraw.Draw(bit_img)
    
    x = (PANEL_W - tw) // 2 - bbox[0] if tw <= PANEL_W else -bbox[0]
    y = (PANEL_H - th) // 2 - bbox[1]
    
    rgb_draw.text((x, y), text, font=font, fill=text_color)
    bit_draw.text((x, y), text, font=font, fill=1)
    
    return rgb_img, bit_img

async def flipper_worker(title: str, times: str, textColor: str, bgColor: str):
    global connected_client, connection_ready, current_display_mode, frames_sent, current_width, current_speed
    
    try:
        event_font = ImageFont.truetype("arial.ttf", 12)
    except Exception:
        event_font = ImageFont.load_default()
        
    print(f"[flipper] Starting flipper for Title: '{title}', Times: '{times}'")
    
    # Truncate text to avoid firmware buffer overflow on long titles (> 255 pixels)
    title = truncate_text_to_width(title, event_font, 250)
    times = truncate_text_to_width(times, event_font, 250)
    
    # Pre-render the two frames (can be wider than PANEL_W)
    title_rgb, title_bit = render_text_image(title, event_font, textColor, bgColor)
    times_rgb, times_bit = render_text_image(times, event_font, textColor, bgColor)
    
    async def push_frame(bit_img: Image.Image, is_scroll: bool, width: int):
        bitmap = [1 if p > 0 else 0 for p in list(bit_img.getdata())]
        
        if connected_client and connected_client.is_connected and connection_ready:
            try:
                # Start session
                await connected_client.write_gatt_char(protocol.WRITE_UUID, protocol.session_start_command(), response=True)
                await asyncio.sleep(0.02)
                
                # Clear all
                bg_bitmap = [1] * (PANEL_W * PANEL_H)
                bg_packet = protocol.bitmap_command(bg_bitmap, PANEL_W, PANEL_H, color="#000000")
                        
                await write_large_gatt_char(connected_client, protocol.WRITE_UUID, bytearray(bg_packet), response=True)
                await asyncio.sleep(0.04)
                
                if is_scroll:
                    speed = max(1, min(15, current_speed))
                    packet = protocol.hardware_scroll_command(bitmap, width, PANEL_H, color=textColor, speed=speed)
                else:
                    packet = protocol.bitmap_command(bitmap, PANEL_W, PANEL_H, color=textColor)
                    
                await write_large_gatt_char(connected_client, protocol.WRITE_UUID, bytearray(packet), response=True)
                await asyncio.sleep(0.04)
                    
                # End/commit session
                await connected_client.write_gatt_char(protocol.WRITE_UUID, protocol.session_end_command(), response=True)
                await asyncio.sleep(0.02)
            except Exception as e:
                print(f"[flipper] BLE error: {e}")
                
    if connected_client and connected_client.is_connected and connection_ready:
        try:
            await connected_client.write_gatt_char(protocol.WRITE_UUID, protocol.clock_off_command(), response=True)
            await asyncio.sleep(0.05)
        except Exception as e:
            print(f"[flipper] Error turning clock off: {e}")
            
    show_title = True
    try:
        while True:
            current_rgb = title_rgb if show_title else times_rgb
            current_bit = title_bit if show_title else times_bit
            tw, th = current_rgb.size
            
            if tw <= PANEL_W:
                # 1. Push to physical sign
                await push_frame(current_bit, is_scroll=False, width=PANEL_W)
                
                # 2. Save to dashboard preview
                save_preview(current_rgb, os.path.join(STATIC_DIR, "current.png"))
                current_width = PANEL_W
                frames_sent += 1
                
                await asyncio.sleep(3.0)
            else:
                # 1. Push native hardware scroll
                await push_frame(current_bit, is_scroll=True, width=tw)
                
                # 2. Save dashboard preview once
                save_preview(current_rgb, os.path.join(STATIC_DIR, "current.png"))
                current_width = tw
                frames_sent += 1
                
                # 3. Dynamic scroll duration calculation
                speed = max(1, min(15, current_speed))
                pixel_delay = max(0.01, min(0.1, 0.08 - (speed - 1) * 0.005))
                scroll_duration = (tw + PANEL_W) * pixel_delay
                await asyncio.sleep(max(3.0, scroll_duration))
            
            show_title = not show_title
            
    except asyncio.CancelledError:
        print("[flipper] Stopped.")
    except Exception as e:
        print(f"[flipper] Error: {e}")

def generate_text_animation_frames(text: str, anim_name: str, render_font, fg_rgb, bg_rgb, speed: int = 8):
    text = normalize_for_sign(text or "")
    pal = [bg_rgb[0], bg_rgb[1], bg_rgb[2], fg_rgb[0], fg_rgb[1], fg_rgb[2], 255, 255, 255] + [0] * 759
    anim_clean = (anim_name or "show now").strip().lower()
    pil_frames = []

    if anim_clean in ("continuous left shift", "continuous-left-shift"):
        temp_img = Image.new("1", (1, 1), 0)
        temp_draw = ImageDraw.Draw(temp_img)
        bbox = temp_draw.textbbox((0, 0), text, font=render_font)
        tw = max(1, bbox[2] - bbox[0])
        th = max(1, bbox[3] - bbox[1])
        y_pos = (PANEL_H - th) // 2 - bbox[1]

        gap = 64
        span = tw + gap
        total_frames = span

        strip_w = span * (math.ceil(PANEL_W / span) + 1)
        full_strip = Image.new('1', (strip_w, PANEL_H), 0)
        strip_draw = ImageDraw.Draw(full_strip)
        for i in range(math.ceil(PANEL_W / span) + 1):
            strip_draw.text((i * span - bbox[0], y_pos), text, font=render_font, fill=1)

        frame_delay_ms = max(20, min(80, int(60 - speed * 2)))
        delay_sec = frame_delay_ms / 1000.0

        for fi in range(total_frames):
            x = -(fi % span)
            f1 = Image.new('1', (PANEL_W, PANEL_H), 0)
            f1.paste(full_strip, (x, 0))
            fp = Image.new('P', (PANEL_W, PANEL_H))
            fp.putpalette(pal)
            fp.putdata(list(f1.get_flattened_data()))
            pil_frames.append(fp.convert('RGB'))

        return pil_frames, frame_delay_ms, delay_sec

    # Page-based animations (8 characters per page)
    chunks = [text[i:i+8] for i in range(0, len(text), 8)] if text else [""]
    frame_delay_ms = 50
    delay_sec = 0.05

    for page_text in chunks:
        temp_img = Image.new("1", (1, 1), 0)
        temp_draw = ImageDraw.Draw(temp_img)
        bbox = temp_draw.textbbox((0, 0), page_text, font=render_font)
        tw = max(1, bbox[2] - bbox[0])
        th = max(1, bbox[3] - bbox[1])
        x_center = (PANEL_W - tw) // 2 - bbox[0]
        y_center = (PANEL_H - th) // 2 - bbox[1]

        text_strip = Image.new('1', (tw, PANEL_H), 0)
        strip_draw = ImageDraw.Draw(text_strip)
        strip_draw.text((-bbox[0], y_center), page_text, font=render_font, fill=1)

        if anim_clean in ("shift left", "move-left"):
            for fi in range(92):
                f1 = Image.new('1', (PANEL_W, PANEL_H), 0)
                if fi < 16:
                    prog = fi / 16.0
                    cur_x = int(round(PANEL_W * (1.0 - prog) + x_center * prog))
                elif fi < 76:
                    cur_x = x_center
                else:
                    prog = (fi - 76) / 16.0
                    cur_x = int(round(x_center * (1.0 - prog) + (-tw) * prog))
                f1.paste(text_strip, (cur_x, 0))
                fp = Image.new('P', (PANEL_W, PANEL_H))
                fp.putpalette(pal)
                fp.putdata(list(f1.get_flattened_data()))
                pil_frames.append(fp.convert('RGB'))

        elif anim_clean in ("move right", "move-right"):
            for fi in range(92):
                f1 = Image.new('1', (PANEL_W, PANEL_H), 0)
                if fi < 16:
                    prog = fi / 16.0
                    cur_x = int(round((-tw) * (1.0 - prog) + x_center * prog))
                elif fi < 76:
                    cur_x = x_center
                else:
                    prog = (fi - 76) / 16.0
                    cur_x = int(round(x_center * (1.0 - prog) + PANEL_W * prog))
                f1.paste(text_strip, (cur_x, 0))
                fp = Image.new('P', (PANEL_W, PANEL_H))
                fp.putpalette(pal)
                fp.putdata(list(f1.get_flattened_data()))
                pil_frames.append(fp.convert('RGB'))

        elif anim_clean in ("move up", "move-up"):
            for fi in range(92):
                f1 = Image.new('1', (PANEL_W, PANEL_H), 0)
                if fi < 16:
                    prog = fi / 16.0
                    cur_y = int(round(PANEL_H * (1.0 - prog) + y_center * prog))
                elif fi < 76:
                    cur_y = y_center
                else:
                    prog = (fi - 76) / 16.0
                    cur_y = int(round(y_center * (1.0 - prog) + (-th) * prog))
                f1.paste(text_strip, (x_center, cur_y - y_center))
                fp = Image.new('P', (PANEL_W, PANEL_H))
                fp.putpalette(pal)
                fp.putdata(list(f1.get_flattened_data()))
                pil_frames.append(fp.convert('RGB'))

        elif anim_clean in ("move down", "move-down"):
            for fi in range(92):
                f1 = Image.new('1', (PANEL_W, PANEL_H), 0)
                if fi < 16:
                    prog = fi / 16.0
                    cur_y = int(round((-th) * (1.0 - prog) + y_center * prog))
                elif fi < 76:
                    cur_y = y_center
                else:
                    prog = (fi - 76) / 16.0
                    cur_y = int(round(y_center * (1.0 - prog) + PANEL_H * prog))
                f1.paste(text_strip, (x_center, cur_y - y_center))
                fp = Image.new('P', (PANEL_W, PANEL_H))
                fp.putpalette(pal)
                fp.putdata(list(f1.get_flattened_data()))
                pil_frames.append(fp.convert('RGB'))

        elif anim_clean == "snow":
            target_pts = [(px, py) for py in range(PANEL_H) for px in range(PANEL_W) if (0 <= px - x_center < tw) and py < text_strip.height and text_strip.getpixel((px - x_center, py))]
            cols_with_text = set(px for (px, py) in target_pts)
            
            for fi in range(92):
                fp = Image.new('P', (PANEL_W, PANEL_H), 0)
                fp.putpalette(pal)
                
                # Draw the sweep particles ONLY on columns with text
                for px in cols_with_text:
                    col_delay = (px * 23 + 7) % 11
                    progress = fi - col_delay
                    if progress >= 0:
                        y_lead = progress
                        if 0 <= y_lead < PANEL_H:
                            fp.putpixel((px, y_lead), 2)
                            
                # Draw the revealed text
                for (px, py) in target_pts:
                    col_delay = (px * 23 + 7) % 11
                    progress = fi - col_delay
                    if progress >= py:
                        fp.putpixel((px, py), 1)
                        
                pil_frames.append(fp.convert('RGB'))

        elif anim_clean == "bubble":
            target_pts = [(px, py) for py in range(PANEL_H) for px in range(PANEL_W) if (0 <= px - x_center < tw) and py < text_strip.height and text_strip.getpixel((px - x_center, py))]
            cols_with_text = set(px for (px, py) in target_pts)
            
            for fi in range(92):
                fp = Image.new('P', (PANEL_W, PANEL_H), 0)
                fp.putpalette(pal)
                
                # Draw the sweep particles ONLY on columns with text
                for px in cols_with_text:
                    col_delay = (px * 17 + 5) % 11
                    progress = fi - col_delay
                    if progress >= 0:
                        y_lead = 19 - progress
                        if 0 <= y_lead < PANEL_H:
                            fp.putpixel((px, y_lead), 2)
                            
                # Draw the revealed text
                for (px, py) in target_pts:
                    col_delay = (px * 17 + 5) % 11
                    progress = fi - col_delay
                    y_lead = 19 - progress
                    if py >= y_lead:
                        fp.putpixel((px, py), 1)
                        
                pil_frames.append(fp.convert('RGB'))

        elif anim_clean == "flicker":
            target_pts = [(px, py) for py in range(PANEL_H) for px in range(PANEL_W) if (0 <= px - x_center < tw) and py < text_strip.height and text_strip.getpixel((px - x_center, py))]
            import random
            random.seed(42)
            for fi in range(60):
                f1 = Image.new('RGB', (PANEL_W, PANEL_H), tuple(bg_rgb))
                if fi < 30:
                    for (px, py) in target_pts:
                        f1.putpixel((px, py), tuple(fg_rgb))
                pil_frames.append(f1)

        else:
            # Show now / static paged hold
            for fi in range(60):
                f1 = Image.new('1', (PANEL_W, PANEL_H), 0)
                f1.paste(text_strip, (x_center, 0))
                fp = Image.new('P', (PANEL_W, PANEL_H))
                fp.putpalette(pal)
                fp.putdata(list(f1.get_flattened_data()))
                pil_frames.append(fp.convert('RGB'))

    return pil_frames, frame_delay_ms, delay_sec

@app.post("/push-text")
async def push_text(req: PushTextRequest):
    global connected_client, connection_ready, frames_sent, active_scroller_task, current_display_mode, current_width, current_speed
    
    # 1. Cancel previous scroller/flipper task cleanly
    await cancel_active_worker()

    try:
        gif_path = os.path.join(STATIC_DIR, "current.gif")
        if os.path.exists(gif_path):
            try:
                os.remove(gif_path)
            except Exception:
                pass
    except Exception:
        pass

    try:
        if req.mode == "text" or (req.pixels is None and req.text):
            unifont_path = os.path.join(os.path.dirname(__file__), "unifont.otf")
            try:
                if os.path.exists(unifont_path):
                    render_font = ImageFont.truetype(unifont_path, 16)
                else:
                    render_font = ImageFont.truetype("arial.ttf", 16)
            except Exception:
                try:
                    render_font = ImageFont.truetype("arial.ttf", 16)
                except Exception:
                    render_font = ImageFont.load_default()

            fg_rgb = hex_to_rgb_global(req.textColor or "#FFFFFF", (255, 255, 255))
            bg_rgb = hex_to_rgb_global(req.bgColor or "#000000", (0, 0, 0))
            anim_clean = (req.animation or "show now").strip().lower()
            speed = req.speed if req.speed is not None else current_speed
            
            is_anim = anim_clean not in ("static", "show now")
            if is_anim:
                frames, frame_delay_ms, delay_sec = generate_text_animation_frames(
                    req.text or "", anim_clean, render_font, fg_rgb, bg_rgb, speed
                )
            else:
                frames, frame_delay_ms, delay_sec = generate_text_animation_frames(
                    req.text or "", "static", render_font, fg_rgb, bg_rgb, speed
                )
                
            gif_path = os.path.join(STATIC_DIR, "current.gif")
            save_gif_preview(frames, req.bgColor or "#000000", delay_sec, gif_path)
            
            png_path = os.path.join(STATIC_DIR, "current.png")
            if os.path.exists(png_path):
                try: os.remove(png_path)
                except: pass
                
            current_width = 64
            current_display_mode = "animation" if is_anim else "static"
            frames_sent += 1
            
            if connected_client and connected_client.is_connected and connection_ready:
                await stop_all_playback(blank=True)
                anim_frames_pixels = []
                for pf in frames:
                    f_pixels = []
                    for p in list(pf.getdata()):
                        if p == (255, 255, 255):
                            f_pixels.append("#ffffff")
                        elif p[0] > 50 or p[1] > 50 or p[2] > 50:
                            f_pixels.append(req.textColor)
                        else:
                            f_pixels.append(None)
                    anim_frames_pixels.append(f_pixels)
                    
                active_scroller_task = asyncio.create_task(
                    animation_worker(anim_frames_pixels, req.bgColor, speed, frame_duration_ms=frame_delay_ms)
                )
            return {"status": "success"}
            
        elif req.pixels is not None:
            is_anim = req.fileType in ("gif", "video") or (len(req.pixels) > 1280)
            if is_anim:
                num_frames = len(req.pixels) // 1280
                raw_frames = extract_frames(req.pixels, num_frames)
                frames = quantize_frames(raw_frames, req.bgColor or "#000000")
                
                speed = req.speed if req.speed is not None else current_speed
                speed = max(1, min(15, speed))
                
                # Prefer exact frame duration over speed-formula
                if req.frameDurationMs is not None and req.frameDurationMs > 0:
                    delay_sec = max(0.016, req.frameDurationMs / 1000.0)
                else:
                    delay_sec = max(0.05, 0.4 - (speed * 0.025))
                
                gif_path = os.path.join(STATIC_DIR, "current.gif")
                save_gif_preview(frames, req.bgColor or "#000000", delay_sec, gif_path)
                
                png_path = os.path.join(STATIC_DIR, "current.png")
                if os.path.exists(png_path):
                    try:
                        os.remove(png_path)
                    except Exception:
                        pass
                        
                current_width = 64
                current_display_mode = "animation"
                frames_sent += 1
                
                if connected_client and connected_client.is_connected and connection_ready:
                    # Explicitly stop onboard hardware slot player so sign stays on stream
                    await stop_all_playback(blank=True)
                    
                    active_scroller_task = asyncio.create_task(
                        animation_worker(frames, req.bgColor, speed, frame_duration_ms=req.frameDurationMs)
                    )
                return {"status": "success"}

            # Helper to parse hex to rgb
            def hex_to_rgb(hex_str: Optional[str]):
                if not hex_str:
                    return (0, 0, 0)
                hex_str = hex_str.lstrip('#')
                if len(hex_str) != 6:
                    return (255, 255, 255)
                return tuple(int(hex_str[i:i+2], 16) for i in (0, 2, 4))

            # Group pixels by color
            pixel_colors = []
            bg_color_hex = (req.bgColor or "#000000").lower()
            text_color_hex = (req.textColor or "#FFFFFF").lower()
            for p in req.pixels:
                if p is None or p == 0 or p == "0" or p == "#000000" or p is False:
                    pixel_colors.append(bg_color_hex if bg_color_hex != "#000000" else None)
                elif isinstance(p, str) and p.startswith("#"):
                    pixel_colors.append(p.lower())
                elif isinstance(p, (int, float)) and not isinstance(p, bool):
                    if math.isnan(p):
                        pixel_colors.append(bg_color_hex if bg_color_hex != "#000000" else None)
                    elif p > 0.4:
                        pixel_colors.append(text_color_hex)
                    else:
                        pixel_colors.append(bg_color_hex if bg_color_hex != "#000000" else None)
                elif p is True:
                    pixel_colors.append(text_color_hex)
                else:
                    pixel_colors.append(text_color_hex)
            
            width = len(pixel_colors) // PANEL_H
            
            # Quantize colors to max 8 colors
            non_none_colors = [c for c in pixel_colors if c is not None]
            unique_colors = set(non_none_colors)
            if len(unique_colors) > 8:
                bg_rgb = hex_to_rgb(bg_color_hex)
                pixels_rgb_for_pil = []
                for c in pixel_colors:
                    if c is None:
                        pixels_rgb_for_pil.append(bg_rgb)
                    else:
                        pixels_rgb_for_pil.append(hex_to_rgb(c))

                pil_img = Image.new("RGB", (width, PANEL_H))
                pil_img.putdata(pixels_rgb_for_pil)

                quantized_img = pil_img.quantize(colors=8, method=Image.Quantize.MAXCOVERAGE)
                rgb_quantized = quantized_img.convert("RGB")
                quantized_rgb_data = list(rgb_quantized.getdata())

                def rgb_to_hex(rgb):
                    return f"#{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}"

                final_pixel_colors = []
                for idx, rgb_val in enumerate(quantized_rgb_data):
                    hex_val = rgb_to_hex(rgb_val)
                    if pixel_colors[idx] is None or hex_val == "#000000":
                        final_pixel_colors.append(None)
                    else:
                        final_pixel_colors.append(hex_val)

                pixel_colors = final_pixel_colors
                unique_colors = set([c for c in pixel_colors if c is not None])

            is_static_pixels = (not req.animation or req.animation in ("static", "show now"))
            if is_static_pixels and width <= PANEL_W:
                current_display_mode = "static"
            else:
                current_display_mode = req.animation or "move-left"

            if connected_client and connected_client.is_connected and connection_ready:
                # Stop hardware slot engine before streaming â€” sign would otherwise revert
                # to its saved slot after our session ends.
                await stop_all_playback(blank=False)

                # Start Session for atomic refresh
                await connected_client.write_gatt_char(protocol.WRITE_UUID, protocol.session_start_command(), response=False)
                
                if is_static_pixels and width <= PANEL_W:
                    # Atomic static push: render all 64x20 pixels simultaneously without slow drawing
                    # 1. Background packet covering all empty/background pixels
                    bg_bitmap = [1 if (pixel_colors[idx] is None or pixel_colors[idx] == bg_color_hex) else 0 for idx in range(len(pixel_colors))]
                    bg_packet = protocol.bitmap_command(bg_bitmap, PANEL_W, PANEL_H, color=bg_color_hex)
                    await write_large_gatt_char(connected_client, protocol.WRITE_UUID, bytearray(bg_packet), response=False, delay=0.0)

                    # 2. Foreground color packets
                    unique_fg_colors = [c for c in unique_colors if c is not None and c != bg_color_hex]
                    for color in unique_fg_colors:
                        bitmap = [1 if pixel_colors[idx] == color else 0 for idx in range(len(pixel_colors))]
                        packet = protocol.bitmap_command(bitmap, PANEL_W, PANEL_H, color=color)
                        await write_large_gatt_char(connected_client, protocol.WRITE_UUID, bytearray(packet), response=False, delay=0.0)
                else:
                    speed = req.speed if req.speed is not None else current_speed
                    speed = max(1, min(15, speed))
                    hw_speed = speed
                    anim_map = {
                        "show now": 1, "static": 1,
                        "continuous left shift": 0,
                        "shift left": 2, "move-left": 2,
                        "move right": 3, "move-right": 3,
                        "move up": 4, "move-up": 4,
                        "move down": 5, "move-down": 5,
                        "snow": 9, "bubble": 10, "flicker": 30
                    }
                    anim_code = anim_map.get((req.animation or "continuous left shift").strip().lower(), 0)
                    for color in unique_colors:
                        bitmap = [1 if pixel_colors[idx] == color else 0 for idx in range(len(pixel_colors))]
                        packet = protocol.hardware_scroll_command(bitmap, width, PANEL_H, color=color, speed=hw_speed, animation=anim_code)
                        await write_large_gatt_char(connected_client, protocol.WRITE_UUID, bytearray(packet), response=False, delay=0.0)
                
                # Commit Session: LED matrix updates all pixels at once
                await connected_client.write_gatt_char(protocol.WRITE_UUID, protocol.session_end_command(), response=True)
            
            # Dashboard preview
            bg_rgb = hex_to_rgb(req.bgColor)
            preview_img = Image.new("RGB", (width, PANEL_H), bg_rgb)
            pixels_rgb = []
            for c in pixel_colors:
                if c is None:
                    pixels_rgb.append(bg_rgb)
                else:
                    pixels_rgb.append(hex_to_rgb(c))
            
            preview_img.putdata(pixels_rgb)
            save_preview(preview_img, os.path.join(STATIC_DIR, "current.png"))
            current_width = width
            frames_sent += 1
            return {"status": "success"}
            
        # 2. Text rendering path
        # Check if this is a calendar event with ||| separator (title ||| start - end)
        text = req.text or ""
        if "|||" in text:
            parts = text.split("|||", 1)
            title = parts[0].strip()
            times = parts[1].strip()
            # Start the flipper task: alternates between title and times every 3s
            active_scroller_task = asyncio.create_task(
                flipper_worker(title, times, req.textColor, req.bgColor)
            )
            current_display_mode = "flipper"
            return {"status": "success"}


        # Standard text rendering
        unifont_path = os.path.join(os.path.dirname(__file__), "unifont.otf")
        try:
            if os.path.exists(unifont_path):
                render_font = ImageFont.truetype(unifont_path, 16)
            else:
                render_font = ImageFont.truetype("arial.ttf", 16)
        except Exception:
            try:
                render_font = ImageFont.truetype("arial.ttf", 16)
            except Exception:
                render_font = ImageFont.load_default()
            
        # Measure text using a temporary canvas to get width and height
        temp_img = Image.new("L", (1, 1), 0)
        temp_draw = ImageDraw.Draw(temp_img)
        bbox = temp_draw.textbbox((0, 0), text, font=render_font)
        
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
        
        if tw <= 0 or th <= 0:
            return {"status": "error", "message": "Nothing to render"}
            
        # Determine canvas width
        # Determine canvas width
        is_static = (not req.animation or req.animation in ("static", "show now"))
        if is_static:
            current_display_mode = "static"
            w = PANEL_W
            if tw <= PANEL_W:
                x = (PANEL_W - tw) // 2 - bbox[0]
            else:
                x = -bbox[0]
            y = (PANEL_H - th) // 2 - bbox[1]

            # Draw onto a 8-bit grayscale 'L' canvas to support antialiasing
            text_img_L = Image.new('L', (w, PANEL_H), 0)
            draw = ImageDraw.Draw(text_img_L)
            draw.text((x, y), text, font=render_font, fill=255)
            final_img_1 = text_img_L.point(lambda p: 1 if p > 128 else 0, mode='1')

            if connected_client and connected_client.is_connected and connection_ready:
                # Turn off clock at the beginning to avoid interference
                await safe_write_gatt_char(protocol.WRITE_UUID, protocol.clock_off_command(), response=True)
                await asyncio.sleep(0.05)
                # Start session
                await safe_write_gatt_char(protocol.WRITE_UUID, protocol.session_start_command(), response=True)
                await asyncio.sleep(0.05)
                # Clear Screen first
                await safe_write_gatt_char(protocol.WRITE_UUID, protocol.clear_all_command(), response=True)
                await asyncio.sleep(0.05)

                bg_color = req.bgColor or "#000000"
                if bg_color.lower() != "#000000":
                    bg_bitmap = [1] * (PANEL_W * PANEL_H)
                    bg_packet = protocol.bitmap_command(bg_bitmap, PANEL_W, PANEL_H, color=bg_color)
                    await write_large_gatt_char(connected_client, protocol.WRITE_UUID, bytearray(bg_packet), response=True)

                pixels = list(final_img_1.getdata())
                bitmap = [1 if p > 0 else 0 for p in pixels]
                packet = protocol.bitmap_command(bitmap, PANEL_W, PANEL_H, color=req.textColor)
                await write_large_gatt_char(connected_client, protocol.WRITE_UUID, bytearray(packet), response=True)

                # Commit Session
                await asyncio.sleep(0.05)
                await safe_write_gatt_char(protocol.WRITE_UUID, protocol.session_end_command(), response=True)

            # Dashboard Preview
            preview_img = Image.new("RGB", (PANEL_W, PANEL_H), req.bgColor or "#000000")
            preview_img.paste(Image.new("RGB", (PANEL_W, PANEL_H), req.textColor or "#FFFFFF"), (0, 0), mask=text_img_L)
            save_preview(preview_img, os.path.join(STATIC_DIR, "current.png"))

            gif_path = os.path.join(STATIC_DIR, "current.gif")
            if os.path.exists(gif_path):
                try: os.remove(gif_path)
                except Exception: pass

            current_width = PANEL_W
            frames_sent += 1
            return {"status": "success"}

        else:
            speed = req.speed if req.speed is not None else current_speed
            speed = max(1, min(15, speed))
            current_speed = speed
            hw_speed = speed
            y = (PANEL_H - th) // 2 - bbox[1]

            anim_clean = (req.animation or "continuous left shift").strip().lower()

            # 1. Update web dashboard / live preview GIF
            fg_rgb = hex_to_rgb_global(req.textColor or "#FFFFFF", (255, 255, 255))
            bg_rgb = hex_to_rgb_global(req.bgColor or "#000000", (0, 0, 0))
            pil_frames, frame_delay_ms, delay_sec = generate_text_animation_frames(
                text, anim_clean, render_font, fg_rgb, bg_rgb, speed
            )
            anim_frames_pixels = []
            for pf in pil_frames:
                f_pixels = [req.textColor if (p[0] > 100 or p[1] > 100 or p[2] > 100) else None for p in list(pf.getdata())]
                anim_frames_pixels.append(f_pixels)

            gif_path = os.path.join(STATIC_DIR, "current.gif")
            save_gif_preview(anim_frames_pixels, req.bgColor or "#000000", delay_sec, gif_path)

            png_path = os.path.join(STATIC_DIR, "current.png")
            if os.path.exists(png_path):
                try: os.remove(png_path)
                except Exception: pass

            current_width = 64
            current_display_mode = "animation"
            frames_sent += 1

            # 2. Hardware push using hardware_scroll_command (streaming directly on physical sign)
            if connected_client and connected_client.is_connected and connection_ready:
                await safe_write_gatt_char(protocol.WRITE_UUID, protocol.clock_off_command(), response=True)
                await asyncio.sleep(0.05)
                await safe_write_gatt_char(protocol.WRITE_UUID, protocol.session_start_command(), response=True)
                await asyncio.sleep(0.05)
                await safe_write_gatt_char(protocol.WRITE_UUID, protocol.clear_all_command(), response=True)
                await asyncio.sleep(0.05)

                anim_map = {
                    "static": 0, "show now": 0,
                    "continuous left shift": 1, "move-left": 1,
                    "move right": 2, "move-right": 2,
                    "move up": 3, "move-up": 3,
                    "move down": 4, "move-down": 4,
                    "snow": 5, "bubble": 6, "flicker": 7
                }
                anim_code = anim_map.get(anim_clean, 1)

                w_full = max(PANEL_W, tw)
                full_text_img_L = Image.new('L', (w_full, PANEL_H), 0)
                f_draw = ImageDraw.Draw(full_text_img_L)
                f_draw.text((-bbox[0], y), text, font=render_font, fill=255)
                full_1 = full_text_img_L.point(lambda p: 1 if p > 128 else 0, mode='1')
                bitmap = [1 if p > 0 else 0 for p in list(full_1.getdata())]

                packet = protocol.hardware_scroll_command(bitmap, w_full, PANEL_H, color=req.textColor, speed=hw_speed, animation=anim_code)
                await write_large_gatt_char(connected_client, protocol.WRITE_UUID, bytearray(packet), response=True)

                await asyncio.sleep(0.05)
                await safe_write_gatt_char(protocol.WRITE_UUID, protocol.session_end_command(), response=True)

            return {"status": "success"}
    except Exception as e:
        print(f"[push-text] Error: {e}")
        err_str = str(e)
        if "-2147023673" in err_str or "canceled" in err_str.lower() or "disconnected" in err_str.lower():
            connection_ready = False
            return {"status": "disconnected"}
        raise HTTPException(status_code=500, detail=str(e))


def save_preview(img: Image.Image, filepath: str):
    try:
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        img.save(filepath, "PNG")
    except Exception as e:
        print(f"[preview] Failed to save {filepath}: {e}")

@app.post("/render-text-preview")
async def render_text_preview(req: RenderTextPreviewRequest):
    import base64
    from io import BytesIO
    text = normalize_for_sign(req.text or "")
    unifont_path = os.path.join(os.path.dirname(__file__), "unifont.otf")
    try:
        if os.path.exists(unifont_path):
            render_font = ImageFont.truetype(unifont_path, 16)
        else:
            render_font = ImageFont.truetype("arial.ttf", 16)
    except Exception:
        try:
            render_font = ImageFont.truetype("arial.ttf", 16)
        except Exception:
            render_font = ImageFont.load_default()

    temp_img = Image.new("1", (1, 1), 0)
    temp_draw = ImageDraw.Draw(temp_img)
    bbox = temp_draw.textbbox((0, 0), text, font=render_font)
    tw = max(1, bbox[2] - bbox[0])
    th = max(1, bbox[3] - bbox[1])
    w = max(PANEL_W, tw)
    x = (PANEL_W - tw) // 2 - bbox[0] if (tw <= PANEL_W) else -bbox[0]
    y = (PANEL_H - th) // 2 - bbox[1]

    text_img = Image.new('1', (w, PANEL_H), 0)
    draw = ImageDraw.Draw(text_img)
    draw.text((x, y), text, font=render_font, fill=1)

    preview_img = Image.new("RGB", (w, PANEL_H), req.bgColor or "#000000")
    preview_img.paste(Image.new("RGB", (w, PANEL_H), req.textColor or "#FFFFFF"), (0, 0), mask=text_img)

    buf = BytesIO()
    preview_img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return {"status": "success", "data_url": f"data:image/png;base64,{b64}", "width": w}

def draw_custom_time(draw, time_str, font, color, y_offset, PANEL_W, show_colon=True):
    display_str = time_str if show_colon else time_str.replace(':', ' ')
    bbox = draw.textbbox((0, 0), display_str, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    x = max(0, (PANEL_W - tw) // 2 - bbox[0])
    y = max(0, (PANEL_H - th) // 2 - bbox[1])
    draw.text((x, y), display_str, font=font, fill=color)

FONT_5x14 = {
    '0': [
        " XXX ",
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        " XXX "
    ],
    '1': [
        "  X  ",
        " XX  ",
        "  X  ",
        "  X  ",
        "  X  ",
        "  X  ",
        "  X  ",
        "  X  ",
        "  X  ",
        "  X  ",
        "  X  ",
        "  X  ",
        "  X  ",
        "  X  "
    ],
    '2': [
        " XXX ",
        "X   X",
        "    X",
        "    X",
        "    X",
        "    X",
        " XXX ",
        "X    ",
        "X    ",
        "X    ",
        "X    ",
        "X    ",
        "X    ",
        "XXXXX"
    ],
    '3': [
        " XXX ",
        "X   X",
        "    X",
        "    X",
        "    X",
        "    X",
        " XXX ",
        "    X",
        "    X",
        "    X",
        "    X",
        "    X",
        "X   X",
        " XXX "
    ],
    '4': [
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        "XXXXX",
        "    X",
        "    X",
        "    X",
        "    X",
        "    X",
        "    X",
        "    X"
    ],
    '5': [
        "XXXXX",
        "X    ",
        "X    ",
        "X    ",
        "X    ",
        "X    ",
        "XXXX ",
        "    X",
        "    X",
        "    X",
        "    X",
        "    X",
        "X   X",
        " XXX "
    ],
    '6': [
        " XXX ",
        "X    ",
        "X    ",
        "X    ",
        "X    ",
        "X    ",
        "XXXX ",
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        " XXX "
    ],
    '7': [
        "XXXXX",
        "    X",
        "    X",
        "    X",
        "    X",
        "    X",
        "    X",
        "    X",
        "    X",
        "    X",
        "    X",
        "    X",
        "    X",
        "    X"
    ],
    '8': [
        " XXX ",
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        " XXX ",
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        " XXX "
    ],
    '9': [
        " XXX ",
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        " XXXX",
        "    X",
        "    X",
        "    X",
        "    X",
        "    X",
        "    X",
        " XXX "
    ]
}

def draw_default_clock(draw, now, font, color, y_offset, PANEL_W, show_colon=True):
    hour_str = f"{now.hour:02d}"
    min_str = f"{now.minute:02d}"
    
    start_x = 16
    start_y = 2
    
    def draw_digit(char, sx):
        if char in FONT_5x14:
            for row_idx, row_str in enumerate(FONT_5x14[char]):
                for col_idx, pixel in enumerate(row_str):
                    if pixel == 'X':
                        draw.point((sx + col_idx, start_y + row_idx), fill=color)

    def draw_star(cx, cy):
        draw.point((cx, cy), fill=color)
        draw.point((cx, cy - 1), fill=color)
        draw.point((cx, cy + 1), fill=color)
        draw.point((cx - 1, cy), fill=color)
        draw.point((cx + 1, cy), fill=color)

    draw_digit(hour_str[0], start_x)
    draw_digit(hour_str[1], start_x + 6)
    
    if show_colon:
        draw_star(start_x + 15, 5)
        draw_star(start_x + 15, 12)
        
    draw_digit(min_str[0], start_x + 20)
    draw_digit(min_str[1], start_x + 26)

def render_clock_frame(now, format, clock_style, color, bg_color, show_seconds):
    bg_hex = (bg_color or "#000000").lstrip('#')
    bg_rgb = tuple(int(bg_hex[i:i+2], 16) for i in (0, 2, 4)) if len(bg_hex) >= 6 else (0, 0, 0)
    c_hex = (color or "#10B981").lstrip('#')
    c_rgb = tuple(int(c_hex[i:i+2], 16) for i in (0, 2, 4)) if len(c_hex) >= 6 else (0, 255, 0)
    pal = [bg_rgb[0], bg_rgb[1], bg_rgb[2], c_rgb[0], c_rgb[1], c_rgb[2]] + [0] * 762

    frame_1 = Image.new('1', (PANEL_W, PANEL_H), 0)
    draw_1 = ImageDraw.Draw(frame_1)

    if clock_style == "default":
        try:
            font = ImageFont.truetype("courbd.ttf", 14)
        except Exception:
            font = ImageFont.load_default()
        time_str = now.strftime("%H:%M")
        bbox = draw_1.textbbox((0, 0), time_str, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        y_offset = (PANEL_H - th) // 2 - bbox[1]
        draw_default_clock(draw_1, now, font, 1, y_offset, PANEL_W, now.second % 2 == 0)
        sec_val = now.second
        if sec_val > 0:
            draw_1.line([(2, 0), (2 + sec_val, 0)], fill=1, width=1)
    else:
        if format == "24h":
            time_str = now.strftime("%H:%M")
        else:
            time_str = now.strftime("%I:%M %p").lstrip("0")

        unifont_path = os.path.join(os.path.dirname(__file__), "unifont.otf")
        try:
            if os.path.exists(unifont_path):
                font = ImageFont.truetype(unifont_path, 16)
            else:
                font = ImageFont.truetype("arialbd.ttf", 16)
        except Exception:
            font = ImageFont.load_default()

        sec_val = now.second
        show_col = (sec_val % 2 == 0)
        draw_custom_time(draw_1, time_str, font, 1, 0, PANEL_W, show_col)
        if show_seconds and sec_val > 0:
            draw_1.line([(2, 0), (2 + sec_val, 0)], fill=1, width=1)

    bitmap = list(frame_1.get_flattened_data())
    fp = Image.new('P', (PANEL_W, PANEL_H))
    fp.putpalette(pal)
    fp.putdata(bitmap)
    preview_img = fp.convert('RGB')
    return preview_img, bitmap

async def clock_preview_worker(color: str, format: str = "12h", bg_color: str = "#000000", show_seconds: bool = False, clock_style: str = "custom"):
    global current_display_mode, frames_sent, current_width, connected_client, connection_ready
    try:
        bg_color = (bg_color or "#000000").lower()
        color = (color or "#10B981").lower()
        if clock_style == "default":
            color = "#ffffff"

        # Ensure built-in clock is off when streaming custom clock
        if clock_style == "custom" and connected_client and connected_client.is_connected and connection_ready:
            await safe_write_gatt_char(protocol.WRITE_UUID, protocol.clock_off_command(), response=True)
            await asyncio.sleep(0.05)
            
        # Sleep until the next second boundary so we don't immediately collide with set_clock's initial frame
        await asyncio.sleep(max(0.2, 1.0 - datetime.datetime.now().microsecond / 1000000.0))

        while current_display_mode == "clock":
            now = datetime.datetime.now()
            preview_img, bitmap = render_clock_frame(now, format, clock_style, color, bg_color, show_seconds)
            save_preview(preview_img, os.path.join(STATIC_DIR, "current.png"))
            current_width = PANEL_W
            frames_sent += 1
            
            # Stream frame to device only if custom style
            if clock_style == "custom" and connected_client and connected_client.is_connected and connection_ready:
                try:
                    await safe_write_gatt_char(protocol.WRITE_UUID, protocol.session_start_command(), response=True)
                    await asyncio.sleep(0.02)
                    
                    inverted_bitmap = [1 if b == 0 else 0 for b in bitmap]
                    bg_packet = protocol.bitmap_command(inverted_bitmap, PANEL_W, PANEL_H, color=(bg_color or "#000000"))
                    await write_large_gatt_char(connected_client, protocol.WRITE_UUID, bytearray(bg_packet), response=True)
                    await asyncio.sleep(0.01)
                    
                    fg_packet = protocol.bitmap_command(bitmap, PANEL_W, PANEL_H, color=color)
                    await write_large_gatt_char(connected_client, protocol.WRITE_UUID, bytearray(fg_packet), response=True)
                    await asyncio.sleep(0.01)
                    
                    await safe_write_gatt_char(protocol.WRITE_UUID, protocol.session_end_command(), response=True)
                except Exception as e:
                    print(f"[clock-stream] BLE error: {e}")
                    
            # Sleep precisely until next second boundary to let the colon pulse every second
            await asyncio.sleep(1.0 - datetime.datetime.now().microsecond / 1000000.0)
                
    except asyncio.CancelledError:
        pass
    except Exception as e:
        print(f"[clock-worker] Error: {e}")

@app.post("/clock")
async def set_clock(on: bool = True, color: Optional[str] = "#10B981", bg_color: Optional[str] = "#000000", format: Optional[str] = "12h", show_seconds: bool = False, clock_style: Optional[str] = "custom"):
    global connected_client, frames_sent, active_scroller_task, current_display_mode, current_width
    global current_clock_color, current_clock_bg_color, current_clock_format, current_clock_show_seconds, current_clock_style
    
    if on and clock_style == "default":
        color = "#ffffff"
        
    await cancel_active_worker()
    try:
        gif_path = os.path.join(STATIC_DIR, "current.gif")
        if os.path.exists(gif_path):
            try:
                os.remove(gif_path)
            except Exception:
                pass
        
        if on and clock_style == "default":
            # Turn on the default built-in hardware clock
            if connected_client and connected_client.is_connected and connection_ready:
                now = datetime.datetime.now()
                year = now.year
                month = now.month
                day = now.day
                hour = now.hour
                minute = now.minute
                second = now.second
                dow = now.weekday() + 1
                
                # Sync time
                time_pkt = protocol.time_command(year, month, day, hour, minute, second, dow)
                await safe_write_gatt_char(protocol.WRITE_UUID, bytearray(time_pkt), response=True)
                await asyncio.sleep(0.05)
                
                # Turn clock on
                clock_pkt = protocol.clock_on_command()
                await safe_write_gatt_char(protocol.WRITE_UUID, bytearray(clock_pkt), response=True)
                await asyncio.sleep(0.05)
        else:
            # Turn off the hardware clock unconditionally if setting custom mode or turning off
            if connected_client and connected_client.is_connected and connection_ready:
                packet = protocol.clock_off_command()
                await safe_write_gatt_char(protocol.WRITE_UUID, bytearray(packet), response=True)
                await asyncio.sleep(0.05)
            
        if on:
            # Update last pushed clock configuration
            current_clock_color = color or "#ffffff"
            current_clock_bg_color = bg_color or "#000000"
            current_clock_format = format or "12h"
            current_clock_show_seconds = show_seconds
            current_clock_style = clock_style or "custom"
            
            now = datetime.datetime.now()
            img, bitmap = render_clock_frame(now, format, clock_style, color, bg_color, show_seconds)
            save_preview(img, os.path.join(STATIC_DIR, "current.png"))
            
            if clock_style == "custom" and connected_client and connected_client.is_connected and connection_ready:
                await safe_write_gatt_char(protocol.WRITE_UUID, protocol.session_start_command(), response=True)
                await asyncio.sleep(0.02)
                
                inverted_bitmap = [1 if b == 0 else 0 for b in bitmap]
                bg_packet = protocol.bitmap_command(inverted_bitmap, PANEL_W, PANEL_H, color=(bg_color or "#000000"))
                await write_large_gatt_char(connected_client, protocol.WRITE_UUID, bytearray(bg_packet), response=True)
                await asyncio.sleep(0.01)
                
                fg_packet = protocol.bitmap_command(bitmap, PANEL_W, PANEL_H, color=color)
                await write_large_gatt_char(connected_client, protocol.WRITE_UUID, bytearray(fg_packet), response=True)
                await asyncio.sleep(0.01)
                
                await safe_write_gatt_char(protocol.WRITE_UUID, protocol.session_end_command(), response=True)
            
            current_display_mode = "clock"
            current_width = PANEL_W
            frames_sent += 1
            active_scroller_task = asyncio.create_task(clock_preview_worker(color, format, bg_color, show_seconds, clock_style))
        else:
            save_preview(Image.new("RGB", (PANEL_W, PANEL_H), "#000000"), os.path.join(STATIC_DIR, "current.png"))
            current_display_mode = "static"
            current_width = PANEL_W
            frames_sent += 1
        return {"status": "success"}
    except Exception as e:
        print(f"[clock] Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class SavePresetRequest(BaseModel):
    slot_id: int
    preset: PushTextRequest
    address: str = ""
    progress_id: Optional[str] = None

@app.get("/save-progress/{progress_id}")
async def get_save_progress(progress_id: str):
    return save_progress.get(progress_id, {"progress": 0, "phase": "Waiting to start"})

def encode_var_len(val: int) -> bytes:
    if val < 128:
        return bytes([val])
    elif val < 256:
        return bytes([129, val])
@app.post("/save-preset")
async def save_preset(req: SavePresetRequest):
    # A complete file transfer is one transaction. Calendar saves and manual
    # slot selections must not interleave session, chunk and play packets.
    async with preset_switch_lock:
        return await _save_preset(req)


async def _save_preset(req: SavePresetRequest):
    global connected_client, connection_ready, current_speed, active_scroller_task, current_width, current_display_mode, frames_sent

    if not connected_client or not connected_client.is_connected or not connection_ready:
        raise HTTPException(status_code=409, detail="Sign is not connected")
    
    progress_id = req.progress_id
    written_to_sign = False

    def report_progress(value: int, phase: str = "Preparing"):
        if progress_id:
            save_progress[progress_id] = {"progress": max(0, min(100, int(value))), "phase": phase}

    # The browser uses 0â€“15% for uploading the preset. Begin server-side work
    # at the same boundary so progress never appears to move backward.
    report_progress(15, "Preparing preset")

    # Cancel any active scrolling or flipper task cleanly
    await cancel_active_worker()
        
    preset = req.preset
    slot_id = req.slot_id # 0-indexed slot index (0 to 11)
    mac_str = (req.address or (connected_client.address if connected_client else "") or "").replace(':', '').lower()
    
    if preset.mode == 'clock':
        try:
            preset_json_path = os.path.join(STATIC_DIR, f"preset_{mac_str}_{slot_id}.json")
            preset_gif_path = os.path.join(STATIC_DIR, f"preset_{mac_str}_{slot_id}.gif")
            current_png = os.path.join(STATIC_DIR, "current.png")
            current_gif = os.path.join(STATIC_DIR, "current.gif")

            with open(preset_json_path, "w") as f:
                _json.dump(preset.model_dump(), f)

            now = datetime.datetime.now()
            fmt = preset.timeFormat or "12h"
            c_style = getattr(preset, 'clockStyle', 'default') or 'default'
            c_color = preset.textColor or "#FFFFFF"
            c_bg = preset.bgColor or "#000000"
            show_sec = getattr(preset, 'showSeconds', True)
            if show_sec is None: show_sec = True

            preview_img, _ = render_clock_frame(now, fmt, c_style, c_color, c_bg, show_sec)
            preview_img.save(preset_gif_path, format="GIF")
            preview_img.save(current_png, format="PNG")
            if os.path.exists(current_gif):
                try: os.remove(current_gif)
                except Exception: pass

            if connected_client and connected_client.is_connected and connection_ready:
                if active_scroller_task:
                    active_scroller_task.cancel()
                    active_scroller_task = None
                try:
                    await safe_write_gatt_char(protocol.WRITE_UUID, protocol.power_command(True), response=True)
                    await asyncio.sleep(0.05)
                except Exception:
                    pass
                if c_style == 'default':
                    await safe_write_gatt_char(protocol.WRITE_UUID, protocol.clock_on_command(), response=True)
                else:
                    await set_clock(on=True, color=c_color, bg_color=c_bg, format=fmt, show_seconds=show_sec, clock_style=c_style)

            current_display_mode = "clock"
            frames_sent += 1
            report_progress(100)
            return {"status": "success", "preview_url": f"/static/preset_{mac_str}_{slot_id}.gif", "written_to_sign": bool(connected_client and connected_client.is_connected and connection_ready)}
        except Exception as clk_err:
            import traceback
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=str(clk_err))

    try:
        # Step 1: Render the preset content to standard GIF bytes
        from io import BytesIO
        import hashlib
        
        pil_frames = []
        delay_sec = 0.1
        is_anim = False
        is_anim_text = False

        # Video frames can arrive as compact RGB bytes instead of hundreds of
        # thousands of JSON color strings. Decode directly into PIL frames.
        rgb_frame_bytes = None
        rgb_payload = getattr(preset, 'pixelsRgbB64', None)
        if rgb_payload:
            try:
                import base64
                rgb_frame_bytes = base64.b64decode(rgb_payload)
                bytes_per_frame = PANEL_W * PANEL_H * 3
                if not rgb_frame_bytes or len(rgb_frame_bytes) % bytes_per_frame:
                    raise ValueError("invalid RGB frame payload")
            except Exception as rgb_err:
                raise HTTPException(status_code=400, detail=f"Invalid compressed video frames: {rgb_err}")

        # If preset is an image/media preset without pixels, extract from imgSrc or thumbnail
        if not rgb_frame_bytes and (preset.pixels is None or len(preset.pixels) == 0) and (getattr(preset, 'imgSrc', None) or getattr(preset, 'mode', None) == 'image' or getattr(preset, 'fileType', None) in ('image', 'gif', 'video')):
            img_src = getattr(preset, 'imgSrc', None)
            if img_src:
                try:
                    cx = float(getattr(preset, 'canvasX', 0) or 0)
                    cy = float(getattr(preset, 'canvasY', 0) or 0)
                    zoom = float(getattr(preset, 'zoom', 1.0) or 1.0)
                    dw = float(getattr(preset, 'dwBase', 64) or 64) * zoom
                    dh = float(getattr(preset, 'dhBase', 20) or 20) * zoom
                    bg = preset.bgColor or "#000000"
                    pix, spd, dur_ms, frame_durations_ms = process_gif_pixels(img_src, cx, cy, dw, dh, bg)
                    preset.pixels = pix
                    if preset.speed is None: preset.speed = spd
                    if preset.frameDurationMs is None: preset.frameDurationMs = dur_ms
                    if not getattr(preset, 'frameDurationsMs', None): preset.frameDurationsMs = frame_durations_ms
                except Exception as p_img_err:
                    print(f"[save_preset] Failed to process imgSrc: {p_img_err}")
            if not preset.pixels and getattr(preset, 'thumbnail', None) and str(preset.thumbnail).startswith('data:image'):
                try:
                    import base64
                    _, tdata = str(preset.thumbnail).split(',', 1)
                    t_img = Image.open(BytesIO(base64.b64decode(tdata))).convert("RGB").resize((64, 20))
                    pil_frames = [t_img]
                except Exception as t_err:
                    print(f"[save_preset] Failed to load thumbnail: {t_err}")

        if rgb_frame_bytes:
            # Compact uploads use the same row-stitched ordering as pixels,
            # not contiguous frame images. Feed both through extract_frames.
            preset.pixels = ["#" + rgb_frame_bytes[i:i + 3].hex() for i in range(0, len(rgb_frame_bytes), 3)]
            preset.pixelsRgbB64 = None
        if not pil_frames and preset.pixels is not None:
            # Drawing or animation
            is_anim = preset.fileType in ("gif", "video") or (len(preset.pixels) > 1280)
            if is_anim:
                num_frames = len(preset.pixels) // 1280
                raw_frames = extract_frames(preset.pixels, num_frames)
                frames = raw_frames
                
                speed = preset.speed if preset.speed is not None else current_speed
                speed = max(1, min(15, speed))
                if preset.frameDurationMs is not None and preset.frameDurationMs > 0:
                    delay_sec = max(0.016, preset.frameDurationMs / 1000.0)
                    frame_delay_ms = max(16, min(500, int(preset.frameDurationMs)))
                elif preset.speed is not None:
                    frame_delay_ms = max(20, min(500, 80 - speed * 5))
                    delay_sec = frame_delay_ms / 1000.0
                else:
                    frame_delay_ms = max(20, min(500, 80 - speed * 5))
                    delay_sec = frame_delay_ms / 1000.0
                    
                # Convert color lists to PIL images
                def hex_to_rgb(hex_str: Optional[str]):
                    if not hex_str: return (0, 0, 0)
                    hex_str = hex_str.lstrip('#')
                    if len(hex_str) != 6: return (255, 255, 255)
                    return tuple(int(hex_str[i:i+2], 16) for i in (0, 2, 4))
                
                bg_rgb = hex_to_rgb(preset.bgColor or "#000000")
                total_frames = max(1, len(frames))
                for frame_index, f_pixels in enumerate(frames):
                    frame_rgbs = []
                    for p in f_pixels:
                        if p is None or p == 0 or p == "0" or p == "#000000" or p is False:
                            frame_rgbs.append(bg_rgb)
                        elif isinstance(p, str) and p.startswith("#"):
                            frame_rgbs.append(hex_to_rgb(p))
                        else:
                            frame_rgbs.append((255, 255, 255) if p else bg_rgb)
                    img = Image.new("RGB", (64, 20))
                    img.putdata(frame_rgbs)
                    pil_frames.append(img)
                    # Rendering a long video is CPU-heavy. Publish progress
                    # while doing it and yield so the browser can poll it.
                    report_progress(15 + (20 * (frame_index + 1) / total_frames), "Rendering frames")
                    if frame_index % 4 == 3:
                        await asyncio.sleep(0)
            else:
                # Static drawing
                def hex_to_rgb(hex_str: Optional[str]):
                    if not hex_str: return (0, 0, 0)
                    hex_str = hex_str.lstrip('#')
                    if len(hex_str) != 6: return (255, 255, 255)
                    return tuple(int(hex_str[i:i+2], 16) for i in (0, 2, 4))
                bg_rgb = hex_to_rgb(preset.bgColor or "#000000")
                frame_rgbs = []
                for p in preset.pixels:
                    if p is None or p == 0 or p == "0" or p == "#000000" or p is False:
                        frame_rgbs.append(bg_rgb)
                    elif isinstance(p, str) and p.startswith("#"):
                        frame_rgbs.append(hex_to_rgb(p))
                    else:
                        frame_rgbs.append((255, 255, 255) if p else bg_rgb)
                img = Image.new("RGB", (64, 20))
                img.putdata(frame_rgbs)
                pil_frames.append(img)
        else:
            # Text preset
            text = normalize_for_sign(preset.text or "")
            unifont_path = os.path.join(os.path.dirname(__file__), "unifont.otf")
            try:
                if os.path.exists(unifont_path):
                    render_font = ImageFont.truetype(unifont_path, 16)
                else:
                    render_font = ImageFont.truetype("arial.ttf", 16)
            except Exception:
                try:
                    render_font = ImageFont.truetype("arial.ttf", 16)
                except Exception:
                    render_font = ImageFont.load_default()

            temp_img = Image.new("1", (1, 1), 0)
            temp_draw = ImageDraw.Draw(temp_img)
            bbox = temp_draw.textbbox((0, 0), text, font=render_font)
            tw = max(1, bbox[2] - bbox[0])
            th = max(1, bbox[3] - bbox[1])
            y = (PANEL_H - th) // 2 - bbox[1]

            anim_clean = (preset.animation or "show now").strip().lower()
            is_anim_text = anim_clean not in ('static', 'show now')
            is_anim = is_anim_text or len(text) > 8
            
            speed = preset.speed if preset.speed is not None else current_speed
            speed = max(1, min(15, speed))

            def hex_to_rgb(hex_str: Optional[str], default=(0, 0, 0)):
                if not hex_str: return default
                hex_str = hex_str.lstrip('#')
                if len(hex_str) != 6: return default
                return tuple(int(hex_str[i:i+2], 16) for i in (0, 2, 4))

            bg_rgb = hex_to_rgb(preset.bgColor or "#000000", (0, 0, 0))
            fg_rgb = hex_to_rgb(preset.textColor or "#FFFFFF", (255, 255, 255))
            pal = [bg_rgb[0], bg_rgb[1], bg_rgb[2], fg_rgb[0], fg_rgb[1], fg_rgb[2], 255, 255, 255] + [0] * 759

            if is_anim:
                pil_frames, frame_delay_ms, delay_sec = generate_text_animation_frames(
                    text, anim_clean, render_font, fg_rgb, bg_rgb, speed
                )
            else:
                frame_delay_ms = 100
                delay_sec = 0.1
                x = (PANEL_W - tw) // 2 - bbox[0] if (tw <= PANEL_W) else -bbox[0]
                text_img = Image.new('1', (PANEL_W, PANEL_H), 0)
                draw = ImageDraw.Draw(text_img)
                draw.text((x, y), text, font=render_font, fill=1)
                
                fp = Image.new('P', (PANEL_W, PANEL_H))
                fp.putpalette(pal)
                fp.putdata(list(text_img.get_flattened_data()))
                pil_frames.append(fp.convert('RGB'))
            
        if not pil_frames:
            raise Exception("Failed to render frames for preset")
            
        frame_durations_ms = getattr(preset, 'frameDurationsMs', None)
        gif_duration = frame_durations_ms if isinstance(frame_durations_ms, list) and len(frame_durations_ms) == len(pil_frames) else int(delay_sec * 1000)
        # GIF palette generation can take a noticeable amount of time for a
        # video. Run it outside FastAPI's event loop so /save-progress remains
        # available while the browser waits for the encoded payload.
        def encode_gif() -> bytes:
            gif_io = BytesIO()
            pil_frames[0].save(
                gif_io,
                format="GIF",
                save_all=True,
                append_images=pil_frames[1:],
                duration=gif_duration,
                # Match the GIF format used in previous stable revisions.
                loop=0,
            )
            return gif_io.getvalue()

        report_progress(35, "Encoding animation")
        gif_bytes = await asyncio.to_thread(encode_gif)
        report_progress(60, "Writing to sign")
        
        # Update live dashboard preview files immediately so the UI reflects what's being uploaded
        current_gif = os.path.join(STATIC_DIR, "current.gif")
        current_png = os.path.join(STATIC_DIR, "current.png")
        if is_anim:
            save_preview_bytes(gif_bytes, current_gif)
            if os.path.exists(current_png):
                try: os.remove(current_png)
                except Exception: pass
        else:
            if pil_frames:
                try:
                    im = pil_frames[0].copy()
                    im.thumbnail((PANEL_W, PANEL_H))
                    im.convert("RGB").save(current_png)
                except Exception: pass
            if os.path.exists(current_gif):
                try: os.remove(current_gif)
                except Exception: pass

        if not connected_client or not connected_client.is_connected or not connection_ready:
            raise RuntimeError("Sign disconnected before the slot transfer")
        if connected_client and connected_client.is_connected and connection_ready:
            try:
                speed = preset.speed if preset.speed is not None else current_speed
                speed = max(1, min(15, speed))

                # Preserve the previously working sequence: blank immediately
                # before transfer, after rendering/encoding is complete.
                await safe_write_gatt_char(protocol.WRITE_UUID, protocol.clock_off_command(), response=True)
                await asyncio.sleep(0.02)
                await safe_write_gatt_char(protocol.WRITE_UUID, protocol.session_start_command(), response=True)
                await asyncio.sleep(0.02)
                black_frame = protocol.bitmap_command([1] * (PANEL_W * PANEL_H), PANEL_W, PANEL_H, color="#000000")
                await write_large_gatt_char(connected_client, protocol.WRITE_UUID, black_frame, response=True)
                await asyncio.sleep(0.02)
                await safe_write_gatt_char(protocol.WRITE_UUID, protocol.session_end_command(), response=True)
                await asyncio.sleep(0.02)

                if is_anim:
                    # Animated GIF/video and animated text:
                    # Keep the current verified changes for GIFs (Slot 4)
                    slot_payload = gif_bytes
                    anim_code = 0
                    speed_val = speed
                    stay_time = 0

                    init_pkt = protocol.build_slot_session_init(slot_id)
                    await safe_write_gatt_char(protocol.WRITE_UUID, init_pkt, response=True)
                    await asyncio.sleep(0.05)

                    hdr_pkt = protocol.build_slot_file_header(slot_id, anim_code=anim_code, speed_val=speed_val, stay_time=stay_time)
                    await safe_write_gatt_char(protocol.WRITE_UUID, hdr_pkt, response=True)
                    await asyncio.sleep(0.05)

                    chunk_size = 960
                    total_chunks = math.ceil(len(slot_payload) / chunk_size)
                    for c_idx in range(total_chunks):
                        if not connected_client or not connected_client.is_connected:
                            raise Exception(f"BLE disconnected during chunk write (chunk {c_idx}/{total_chunks})")
                        c_data = slot_payload[c_idx * chunk_size : (c_idx + 1) * chunk_size]
                        chunk_pkt = protocol.build_slot_file_chunk(slot_id, c_idx, total_chunks, chunk_size, c_data)
                        await write_large_gatt_char(connected_client, protocol.WRITE_UUID, chunk_pkt, response=True)
                        await asyncio.sleep(0.035)
                        report_progress(60 + (30 * (c_idx + 1) / total_chunks), "Writing to sign")

                    if not connected_client or not connected_client.is_connected:
                        raise Exception("BLE disconnected after chunk writes")

                    await asyncio.sleep(0.1)
                    commit_pkt = protocol.build_slot_commit(slot_id, slot_payload)
                    await safe_write_gatt_char(protocol.WRITE_UUID, commit_pkt, response=True)
                    await asyncio.sleep(0.2)
                    report_progress(95, "Finalizing on sign")

                    if not connected_client or not connected_client.is_connected:
                        raise Exception("BLE disconnected after commit")

                    select_pkt = protocol.build_slot_select_command(slot_id)
                    await safe_write_gatt_char(protocol.WRITE_UUID, select_pkt, response=True)
                    await asyncio.sleep(0.1)

                    play_pkt = protocol.build_user_slot_play_command(slot_id, loop_mode=0)
                    await safe_write_gatt_char(protocol.WRITE_UUID, play_pkt, response=True)
                    await asyncio.sleep(0.05)

                    hardware_slots_state[slot_id] = {
                        "slot_id": slot_id,
                        "occupied": True,
                        "key": hashlib.md5(gif_bytes).hexdigest()
                    }
                else:
                    # Static image/text: EXACT configuration from Step 14108 (verified working in Step 14507 for Slot 1 & Slot 3)
                    frame_w = PANEL_W
                    frame_h = PANEL_H
                    frame_delay_ms = 100
                    speed_val = current_speed
                    anim_code = 1  # 1 = Show Now / Static frame
                    stay_time = 3

                    ystp_header = b'YSTP01' + struct.pack('<HHHHB', frame_w, frame_h, 1, frame_delay_ms, 24)
                    frame_bytes = pil_frames[0].resize((frame_w, frame_h)).convert("RGB").tobytes()
                    ystp_bytes = ystp_header + frame_bytes

                    init_pkt = protocol.build_slot_session_init(slot_id)
                    await safe_write_gatt_char(protocol.WRITE_UUID, init_pkt, response=True)
                    await asyncio.sleep(0.05)

                    hdr_pkt = protocol.build_slot_file_header(slot_id, anim_code=anim_code, speed_val=speed_val, stay_time=stay_time)
                    await safe_write_gatt_char(protocol.WRITE_UUID, hdr_pkt, response=True)
                    await asyncio.sleep(0.05)

                    chunk_size = 960
                    total_chunks = math.ceil(len(ystp_bytes) / chunk_size)
                    for c_idx in range(total_chunks):
                        if not connected_client or not connected_client.is_connected:
                            raise Exception(f"BLE disconnected during chunk write (chunk {c_idx}/{total_chunks})")
                        c_data = ystp_bytes[c_idx * chunk_size : (c_idx + 1) * chunk_size]
                        chunk_pkt = protocol.build_slot_file_chunk(slot_id, c_idx, total_chunks, chunk_size, c_data)
                        await write_large_gatt_char(connected_client, protocol.WRITE_UUID, chunk_pkt, response=True)
                        await asyncio.sleep(0.02)
                        report_progress(60 + (30 * (c_idx + 1) / total_chunks), "Writing to sign")

                    if not connected_client or not connected_client.is_connected:
                        raise Exception("BLE disconnected after chunk writes")

                    await asyncio.sleep(0.05)
                    commit_pkt = protocol.build_slot_commit(slot_id, ystp_bytes)
                    await safe_write_gatt_char(protocol.WRITE_UUID, commit_pkt, response=True)
                    await asyncio.sleep(0.1)
                    report_progress(95, "Finalizing on sign")

                    if not connected_client or not connected_client.is_connected:
                        raise Exception("BLE disconnected after commit")

                    select_pkt = protocol.build_slot_select_command(slot_id)
                    await safe_write_gatt_char(protocol.WRITE_UUID, select_pkt, response=True)
                    await asyncio.sleep(0.05)

                    play_pkt = protocol.build_user_slot_play_command(slot_id, loop_mode=0)
                    await safe_write_gatt_char(protocol.WRITE_UUID, play_pkt, response=True)
                    await asyncio.sleep(0.05)

                    hardware_slots_state[slot_id] = {
                        "slot_id": slot_id,
                        "occupied": True,
                        "key": hashlib.md5(ystp_bytes).hexdigest()
                    }

                print(f"[save_preset] Done. Slot {slot_id} saved (is_anim={is_anim}).")
                written_to_sign = True
            except Exception as e:
                print(f"[save_preset] Error: {e}")
                # Only attempt recovery write if still connected; skip if BLE already dropped
                if connected_client and connected_client.is_connected:
                    try:
                        await safe_write_gatt_char(protocol.WRITE_UUID, protocol.power_command(True), response=True)
                    except Exception:
                        pass
                raise HTTPException(status_code=500, detail=str(e))

        # Only publish the slot and live previews after the transfer and play
        # commands succeeded. Failed writes must not replace the last good cache.
        preset_json_path = os.path.join(STATIC_DIR, f"preset_{mac_str}_{slot_id}.json")
        preset_gif_path = os.path.join(STATIC_DIR, f"preset_{mac_str}_{slot_id}.gif")
        save_preview_bytes(_json.dumps(preset.model_dump()).encode("utf-8"), preset_json_path)
        save_preview_bytes(gif_bytes, preset_gif_path)

        # Increment frames sent to signal status updates
        current_display_mode = f"preset-{slot_id}"
        current_width = PANEL_W
        frames_sent += 1
        report_progress(100, "Complete")
        return {"status": "success", "preview_url": f"/static/preset_{mac_str}_{slot_id}.gif", "written_to_sign": written_to_sign}

    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/delete-preset/{slot_id}")
async def delete_preset(slot_id: int, mac: str = "", was_active: Optional[bool] = None):
    global connected_client, connection_ready, hardware_slots_state, current_display_mode
    import glob

    if was_active is not None:
        was_showing_cleared_preset = was_active
    else:
        was_showing_cleared_preset = (current_display_mode == f"preset-{slot_id}")

    # 1. Delete all cached preset files for this slot on disk
    for f in glob.glob(os.path.join(STATIC_DIR, f"preset_*_{slot_id}.*")):
        try: os.remove(f)
        except Exception: pass
    for f in glob.glob(os.path.join(STATIC_DIR, f"preset_{slot_id}.*")):
        try: os.remove(f)
        except Exception: pass

    # 2. Mark slot unoccupied in server memory
    hardware_slots_state[slot_id] = {
        "slot_id": slot_id,
        "occupied": False,
        "key": None
    }

    # 3. If the sign was showing the cleared preset, revert to default saved preset (hardware slot 1).
    # Otherwise, do NOT send any hardware commands, so the physical sign remains showing what was already displaying.
    if was_showing_cleared_preset:
        try:
            await play_preset(id=1, mac=mac)
        except Exception as play_err:
            print(f"[delete-preset] Failed to revert to default slot 1: {play_err}")

    return {"status": "success"}

if __name__ == "__main__":
    import uvicorn
    host = os.getenv("LED_SIGN_HOST", "127.0.0.1")
    uvicorn.run(app, host=host, port=8000)









