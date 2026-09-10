import os
import asyncio
import struct
import datetime
import shutil
import tempfile
import math
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

async def write_large_gatt_char(client: BleakClient, char_uuid: str, data: bytes, response: bool = True, chunk_size: Optional[int] = None, delay: float = 0.002):
    """Writes a potentially large bytearray/bytes payload by chunking it.
    If chunk_size is not provided, it is dynamically determined using client.mtu_size.
    We chunk all packets exceeding chunk_size to avoid MTU/Prepare Queue write errors.
    """
    if not client or not getattr(client, "is_connected", False):
        return
    try:
        if chunk_size is None:
            mtu = getattr(client, "mtu_size", 23)
            chunk_size = max(20, min(244, mtu - 3))
            
        if len(data) <= chunk_size:
            await client.write_gatt_char(char_uuid, bytearray(data), response=response)
            return
        for i in range(0, len(data), chunk_size):
            chunk = data[i:i+chunk_size]
            await client.write_gatt_char(char_uuid, bytearray(chunk), response=response)
            if delay > 0:
                await asyncio.sleep(delay)
    except Exception as e:
        print(f"[BLE write_large_gatt_char error] {e}")

async def safe_write_gatt_char(char_uuid: str, data: Union[bytes, bytearray], response: bool = True):
    global connected_client, connection_ready
    if connected_client and connected_client.is_connected and getattr(connected_client, "_backend", None):
        try:
            await connected_client.write_gatt_char(char_uuid, bytearray(data), response=response)
        except Exception as e:
            print(f"[safe_write_gatt_char error] {e}")

app = FastAPI()
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
current_speed: int = 13
brightness: int = 15
power: bool = True
start_time = datetime.datetime.now()

# Clock State (last pushed clock configuration)
current_clock_color: str = "#ffffff"
current_clock_bg_color: str = "#000000"
current_clock_format: str = "24h"
current_clock_show_seconds: bool = True
current_clock_style: str = "default"


# Enable CORS for frontend Vite dev server (port 5173) to backend communication
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
if not os.path.exists(STATIC_DIR):
    os.makedirs(STATIC_DIR)

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
    fileType: Optional[Any] = None
    frameDurationMs: Optional[Any] = None  # Exact per-frame delay for GIF/video animations
    name: Optional[Any] = None
    id: Optional[Any] = None

    model_config = {"extra": "allow"}

class ProcessGifRequest(BaseModel):
    imgSrc: str
    canvasX: float
    canvasY: float
    zoom: float
    dwBase: float
    dhBase: float
    bgColor: Optional[str] = "#000000"

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
    num_frames = min(num_frames, 64)
    
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
    n_frames = getattr(img, "n_frames", 1)
    for i in range(n_frames):
        try:
            img.seek(i)
            extracted_frames.append(img.copy().convert("RGBA"))
        except EOFError:
            break
            
    num_frames = len(extracted_frames)
    num_frames = min(num_frames, 64)
    
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
                
    return final_pixels, recommended_speed, actual_duration_ms


@app.post("/process-gif")
async def process_gif(req: ProcessGifRequest):
    try:
        w = req.dwBase * req.zoom
        h = req.dhBase * req.zoom
        pixels, speed, duration_ms = process_gif_pixels(req.imgSrc, req.canvasX, req.canvasY, w, h, req.bgColor or "#000000")
        
        num_frames = len(pixels) // 1280
        raw_frames = extract_frames(pixels, num_frames)
        quantized_frames = quantize_frames(raw_frames, req.bgColor or "#000000")
        
        stitched_pixels = []
        for r in range(20):
            for f in range(num_frames):
                row_start = r * 64
                stitched_pixels.extend(quantized_frames[f][row_start : row_start + 64])
                
        return {"pixels": stitched_pixels, "speed": speed, "frameDurationMs": duration_ms}
    except Exception as e:
        print(f"Error processing GIF: {e}")
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


@app.post("/connect")
async def connect(req: ConnectRequest):
    global connected_client, connection_ready
    connection_ready = False
    if connected_client:
        try:
            await connected_client.disconnect()
        except Exception:
            pass
        connected_client = None
    try:
        if os.path.exists(os.path.join(STATIC_DIR, "current.gif")):
            os.remove(os.path.join(STATIC_DIR, "current.gif"))
        if os.path.exists(os.path.join(STATIC_DIR, "current.png")):
            os.remove(os.path.join(STATIC_DIR, "current.png"))
    except Exception:
        pass

    try:
        device = None
        print(f"Scanning for LED sign (requested: {req.address})...")
        devices_dict = await BleakScanner.discover(timeout=5.0, return_adv=True)
        
        # 1. First, try to find the exact requested MAC address
        for addr, (d, adv) in devices_dict.items():
            if addr.lower() == req.address.lower():
                device = d
                print(f"Found exact requested MAC address match: {d.name} ({addr})")
                break
                
        # 2. If exact MAC not found, auto-resolve to best sign
        if not device and not req.address:
            active_named = []
            unnamed_candidates = []
            
            for addr, (d, adv) in devices_dict.items():
                name = d.name or ""
                services = adv.service_uuids or []
                is_named_led = (
                    "HELLO" in name
                    or "SIGN" in name
                    or name.startswith("YS")
                    or name.startswith("TL")
                    or name.startswith("LOY")
                    or name.startswith("a00")
                )
                is_unnamed_led = (
                    not is_named_led and (
                        "0000fff0-0000-1000-8000-00805f9b34fb" in [s.lower() for s in services]
                        or "0000fff1-0000-1000-8000-00805f9b34fb" in [s.lower() for s in services]
                    )
                )
                if is_named_led:
                    active_named.append((d, adv))
                    print(f"  Found active named LED sign: {name} ({addr}), RSSI: {adv.rssi}")
                elif is_unnamed_led:
                    unnamed_candidates.append((d, adv))
                    print(f"  Found active unnamed candidate: {name or 'unnamed'} ({addr}), RSSI: {adv.rssi}")

            if active_named:
                active_named.sort(key=lambda x: -(x[1].rssi or -100))
                device = active_named[0][0]
                print(f"Auto-resolved to active named sign: {device.name} ({device.address}), RSSI: {active_named[0][1].rssi}")
            elif unnamed_candidates:
                unnamed_candidates.sort(key=lambda x: -(x[1].rssi or -100))
                device = unnamed_candidates[0][0]
                print(f"Auto-resolved to active unnamed sign: {device.name} ({device.address}), RSSI: {unnamed_candidates[0][1].rssi}")

        if not device:
            if req.address:
                print(f"Device {req.address} not found in scan, attempting direct connection...")
                device = req.address
            else:
                raise Exception(f"LED sign not found in scan. Ensure the sign is powered on and nearby.")
        
        if isinstance(device, str):
            print(f"Connecting to {device}...")
        else:
            print(f"Connecting to {device.name} ({device.address})...")
        client = BleakClient(device)
        await client.connect(timeout=30.0)
        
        # Test and initialize connection
        if client.is_connected:
            connected_client = client
            connection_ready = True
            
            # Stop any hardware clock and halt boot playlist immediately upon connection
            try:
                await connected_client.write_gatt_char(protocol.WRITE_UUID, protocol.clock_off_command(), response=True)
                await asyncio.sleep(0.05)
                await connected_client.write_gatt_char(protocol.WRITE_UUID, protocol.stop_playlist_command(), response=True)
            except Exception as se:
                print(f"[connect] Warning turning off clock/playlist: {se}")
            
        return {"status": "success", "address": connected_client.address}
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        print(f"[connect] FAILED: {type(e).__name__}: {e}")
        print(f"[connect] Traceback:\n{tb}")
        connected_client = None
        connection_ready = False
        raise HTTPException(status_code=408, detail=f"{type(e).__name__}: {e}")

@app.post("/disconnect")
async def disconnect():
    global connected_client, connection_ready
    connection_ready = False
    if connected_client:
        try:
            await connected_client.disconnect()
        except Exception:
            pass
        connected_client = None
        
    try:
        if os.path.exists(os.path.join(STATIC_DIR, "current.gif")):
            os.remove(os.path.join(STATIC_DIR, "current.gif"))
        if os.path.exists(os.path.join(STATIC_DIR, "current.png")):
            os.remove(os.path.join(STATIC_DIR, "current.png"))
        current_display_mode = "none"
    except Exception:
        pass
        
    return {"status": "success"}
@app.post("/clear")
async def clear():
    global connected_client, connection_ready, active_scroller_task, current_display_mode, current_width
    
    # Cancel any active scrolling/flipper task
    if active_scroller_task:
        active_scroller_task.cancel()
        active_scroller_task = None
        
    if connected_client and connected_client.is_connected and connection_ready:
        try:
            # Turn off clock at the beginning to avoid interference
            await connected_client.write_gatt_char(protocol.WRITE_UUID, protocol.clock_off_command(), response=True)
            await asyncio.sleep(0.05)
            await connected_client.write_gatt_char(protocol.WRITE_UUID, protocol.session_start_command(), response=True)
            await asyncio.sleep(0.05)
            await connected_client.write_gatt_char(protocol.WRITE_UUID, protocol.clear_all_command(), response=True)
            await asyncio.sleep(0.05)
            await connected_client.write_gatt_char(protocol.WRITE_UUID, protocol.session_end_command(), response=True)
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
            await connected_client.write_gatt_char(protocol.WRITE_UUID, packet, response=True)
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
            await connected_client.write_gatt_char(protocol.WRITE_UUID, packet, response=True)
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
    print(f"[DEBUG] /preset called with id={id}, mac={mac}")
    global connected_client, connection_ready, active_scroller_task, current_display_mode, frames_sent
    import json as _json

    # Cancel any active scroller/animation task
    if active_scroller_task:
        active_scroller_task.cancel()
        active_scroller_task = None

    try:
        mac_str = mac.replace(':', '').lower()
        json_path = os.path.join(STATIC_DIR, f"preset_{mac_str}_{id}.json")
        gif_path  = os.path.join(STATIC_DIR, f"preset_{mac_str}_{id}.gif")
        current_display_mode = f"preset-{id}"

        # Update live preview from saved file
        current_gif = os.path.join(STATIC_DIR, "current.gif")
        current_png = os.path.join(STATIC_DIR, "current.png")
        if os.path.exists(json_path):
            with open(json_path, "r") as fj:
                preset_data = _json.load(fj)
            
            is_anim = preset_data.get("fileType") in ("gif", "video") or (preset_data.get("pixels") and len(preset_data.get("pixels")) > 1280) or (preset_data.get("mode") == "text" and preset_data.get("animation") and preset_data.get("animation") != "static")
            
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
            # Select and play the user slot directly from flash!
            slot_pkt = protocol.build_user_slot_play_command(id)
            await safe_write_gatt_char(protocol.WRITE_UUID, slot_pkt, response=False)
            
            # Also push the preset directly to ensure display is updated immediately!
            if os.path.exists(json_path):
                try:
                    with open(json_path, "r") as fj:
                        saved_preset = _json.load(fj)
                    await push_text(PushTextRequest(**saved_preset))
                except Exception as pe:
                    print(f"[/preset] Error updating display: {pe}")

        return {"status": "success"}
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/scan")
async def scan_devices():
    try:
        devices_dict = await BleakScanner.discover(timeout=15.0, return_adv=True)
        print(f"[scan] Found {len(devices_dict)} total BLE devices:")
        results = []
        for address, (device, adv_data) in devices_dict.items():
            name = device.name or ""
            adv_name = adv_data.local_name or ""
            services = adv_data.service_uuids or []
            rssi = adv_data.rssi or -99
            display_name = name or adv_name or ""

            # Log every device for debugging
            print(f"  [{rssi:4d} dBm] {display_name!r} ({address})  adv_name={adv_name!r}  services={[s[:8] for s in services]}")

            name_upper = name.upper()
            adv_name_upper = adv_name.upper()
            display_upper = display_name.upper()
            services_upper = [s.upper() for s in services]

            # Name-based LED sign detection (reliable — these prefixes are specific to LOY signs)
            is_led = (
                "HELLO" in display_upper
                or "SIGN" in display_upper
                or "LOY" in display_upper
                or display_upper.startswith("YS")
                or display_upper.startswith("TL")
                or display_upper.startswith("LEO")
            )  # NOTE: 'A00' prefix removed — it matches generic non-sign BT devices

            # Skip devices with no name — 0xFFF0/FFE0 service UUIDs are generic
            # and used by many non-sign BLE devices, so we can't rely on them alone.
            if not display_name:
                continue

            if is_led:
                print(f"    -> Flagged as LED sign")

            results.append({
                "name": display_name,
                "adv_name": adv_name or None,
                "address": device.address,
                "rssi": rssi,
                "is_led": is_led
            })

        # LED signs first, then others; within each group sort by signal strength
        results.sort(key=lambda x: (0 if x["is_led"] else 1, -(x.get("rssi") or -99)))
        print(f"[scan] Returning {len(results)} device(s) ({sum(1 for r in results if r['is_led'])} LED sign(s))")
        return results
    except Exception as e:
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
async def get_today_events():
    try:
        events = calendar_service.get_today_events()
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
    
    quantized_img = pil_img.quantize(colors=3, method=Image.Quantize.MAXCOVERAGE)
    rgb_quantized = quantized_img.convert("RGB")
    quantized_rgbs = list(rgb_quantized.getdata())
    
    bg_pil = Image.new("RGB", (1, 1), bg_rgb)
    bg_quantized_img = bg_pil.quantize(palette=quantized_img)
    bg_quantized_rgb = bg_quantized_img.convert("RGB").getpixel((0, 0))
    bg_quantized_hex = rgb_to_hex(bg_quantized_rgb)
    
    quantized_frames_list = []
    for f in range(num_frames):
        frame_pixels = []
        for r in range(20):
            row_start = r * width
            for c in range(64):
                rgb_val = quantized_rgbs[row_start + f * 64 + c]
                hex_val = rgb_to_hex(rgb_val)
                
                orig_idx = r * 64 + c
                if hex_val == bg_quantized_hex or canonical_frames[f][orig_idx] is None:
                    frame_pixels.append(None)
                else:
                    frame_pixels.append(hex_val)
        quantized_frames_list.append(frame_pixels)
        
    return quantized_frames_list


def save_gif_preview(frames_pixels: List[List[Any]], bg_color_hex: str, delay_sec: float, path: str):
    """Slices the stitched pixels, creates PIL images, and atomically saves as animated GIF."""
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
            delay = max(0.05, 0.4 - (speed * 0.025))
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
            await connected_client.write_gatt_char(protocol.WRITE_UUID, protocol.session_start_command(), response=False)
            
            packets = frame_packets[frame_idx]
            
            # Send all color bitmap packets back-to-back as ONE atomic burst
            for packet in packets:
                await write_large_gatt_char(connected_client, protocol.WRITE_UUID, bytearray(packet), response=False, delay=0.0)
                    
            # End/commit session for the frame to display all pixels atomically
            await connected_client.write_gatt_char(protocol.WRITE_UUID, protocol.session_end_command(), response=True)
            
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

@app.post("/push-text")
async def push_text(req: PushTextRequest):
    global connected_client, frames_sent, active_scroller_task, current_display_mode, current_width, current_speed
    
    # 1. Cancel previous scroller/flipper task
    if active_scroller_task:
        active_scroller_task.cancel()
        active_scroller_task = None

    try:
        gif_path = os.path.join(STATIC_DIR, "current.gif")
        if os.path.exists(gif_path):
            try:
                os.remove(gif_path)
            except Exception:
                pass
    except Exception:
        pass

    if req.pixels is not None:
        # We will use the native GIF hardware decoder (0xC5) for all 64x20 image pushes (static or animated)
        # This completely eliminates the slow "drawing" effect and the need for python background streaming.
        is_image = req.fileType in ("gif", "video", "png", "jpg", "jpeg") or (len(req.pixels) % 1280 == 0 and len(req.pixels) > 0)
        
        # If it's a very wide image (scrolling text), we fall back to hardware_scroll_command (Mode 0)
        if is_image and len(req.pixels) == 1280:
            pass # It's a static 64x20 image, use GIF transfer
        elif is_image and len(req.pixels) > 1280 and req.fileType not in ("gif", "video"):
            is_image = False # It's scrolling text, fallback to Mode 0
            
        if is_image:
            num_frames = max(1, len(req.pixels) // 1280)
            raw_frames = extract_frames(req.pixels, num_frames)
            frames = quantize_frames(raw_frames, req.bgColor or "#000000")
            
            speed = req.speed if req.speed is not None else current_speed
            speed = max(1, min(15, speed))
            
            if req.frameDurationMs is not None and req.frameDurationMs > 0:
                delay_ms = req.frameDurationMs
            else:
                delay_ms = int(max(0.05, 0.4 - (speed * 0.025)) * 1000)
            
            gif_path = os.path.join(STATIC_DIR, "current.gif")
            # Save preview to disk
            save_gif_preview(frames, req.bgColor or "#000000", delay_ms / 1000.0, gif_path)
            
            png_path = os.path.join(STATIC_DIR, "current.png")
            if os.path.exists(png_path):
                try: os.remove(png_path)
                except: pass
                    
            current_width = 64
            current_display_mode = "animation" if num_frames > 1 else "static"
            frames_sent += 1
            
            if connected_client and connected_client.is_connected and connection_ready:
                # Generate GIF bytes in memory
                gif_io = io.BytesIO()
                if len(frames) > 1:
                    frames[0].save(gif_io, format='GIF', save_all=True, append_images=frames[1:], duration=delay_ms, loop=0, optimize=True)
                else:
                    frames[0].save(gif_io, format='GIF', optimize=True)
                gif_bytes = gif_io.getvalue()

                hw_addr = 0xC5
                CHUNK_SIZE = 960
                
                # Upload GIF to 0xC5
                session_pkt = protocol.build_file_transfer_session_init(hw_addr=hw_addr, num_files=1)
                await safe_write_gatt_char(protocol.WRITE_UUID, session_pkt, response=True)
                await asyncio.sleep(0.05)
                
                total_chunks = (len(gif_bytes) + CHUNK_SIZE - 1) // CHUNK_SIZE
                for i in range(total_chunks):
                    start = i * CHUNK_SIZE
                    chunk = gif_bytes[start:start+CHUNK_SIZE]
                    chunk_pkt = protocol.build_file_transfer_chunk(
                        hw_addr=hw_addr, file_index=0, chunk_index=i,
                        total_chunks=total_chunks, data=chunk, chunk_size=len(chunk)
                    )
                    await write_large_gatt_char(connected_client, protocol.WRITE_UUID, chunk_pkt, response=True)
                    
                # Commit file transfer to 0xC5
                commit_pkt = protocol.build_file_transfer_complete(hw_addr, num_frames=1)
                await safe_write_gatt_char(protocol.WRITE_UUID, commit_pkt, response=True)
                await asyncio.sleep(0.05)
                
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

        if width > PANEL_W:
            current_display_mode = "move-left-loop"
        else:
            current_display_mode = "static"

        if connected_client and connected_client.is_connected and connection_ready:
            # Turn off clock/preset and clear screen cleanly before drawing
            await safe_write_gatt_char(protocol.WRITE_UUID, protocol.clock_off_command(), response=False)
            await safe_write_gatt_char(protocol.WRITE_UUID, protocol.session_start_command(), response=False)
            await safe_write_gatt_char(protocol.WRITE_UUID, protocol.clear_all_command(), response=False)
            
            speed = req.speed if req.speed is not None else current_speed
            speed = max(1, min(15, speed))
            hw_speed = speed
    
            for color in unique_colors:
                bitmap = [1 if pixel_colors[idx] == color else 0 for idx in range(len(pixel_colors))]
                if width > PANEL_W:
                    anim_code = 1 if req.animation == "move-left" else 2 if req.animation == "move-right" else 3 if req.animation == "move-up" else 4 if req.animation == "move-down" else 1
                    packet = protocol.hardware_scroll_command(bitmap, width, PANEL_H, color=color, speed=hw_speed, animation=anim_code)
                else:
                    packet = protocol.bitmap_command(bitmap, PANEL_W, PANEL_H, color=color)
                await safe_write_gatt_char(protocol.WRITE_UUID, bytearray(packet), response=False)
            
            # Commit Session atomically so all pixels appear together
            await safe_write_gatt_char(protocol.WRITE_UUID, protocol.session_end_command(), response=True)
        
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
    try:
        render_font = ImageFont.truetype("arialbd.ttf", 18)
    except Exception:
        try:
            render_font = ImageFont.truetype("arial.ttf", 18)
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
    is_static = (req.animation == "static")
    if is_static:
        current_display_mode = "static"
        w = PANEL_W
        if tw <= PANEL_W:
            x = (PANEL_W - tw) // 2 - bbox[0]
        else:
            x = -bbox[0]
    else:
        current_display_mode = "move-left-loop"
        w = max(PANEL_W, tw)
        x = -bbox[0]
        
    y = (PANEL_H - th) // 2 - bbox[1]
    
    # Draw onto a 8-bit grayscale 'L' canvas to support antialiasing
    text_img_L = Image.new('L', (w, PANEL_H), 0)
    draw = ImageDraw.Draw(text_img_L)
    draw.text((x, y), text, font=render_font, fill=255)
    
    final_img_L = text_img_L
    tw_final = w
    th = PANEL_H

    final_img_1 = final_img_L.point(lambda p: 1 if p > 128 else 0, mode='1')

    # 3. Hardware Decision
    if connected_client and connected_client.is_connected and connection_ready:
        # Turn off clock/preset at the beginning to avoid interference
        await connected_client.write_gatt_char(protocol.WRITE_UUID, protocol.clock_off_command(), response=True)
        await asyncio.sleep(0.05)
        # Start session
        await connected_client.write_gatt_char(protocol.WRITE_UUID, protocol.session_start_command(), response=True)
        await asyncio.sleep(0.05)
        # Clear Screen first
        await connected_client.write_gatt_char(protocol.WRITE_UUID, protocol.clear_all_command(), response=True)
        await asyncio.sleep(0.05)
        
        anim_map = {"static": 0, "move-left": 1, "move-right": 2, "move-up": 3, "move-down": 4, "snow": 5, "bubble": 6, "flicker": 7}
        anim_code = anim_map.get(req.animation or "move-left", 1)
        bg_color = req.bgColor or "#000000"
        
        if bg_color.lower() != "#000000" and tw_final <= PANEL_W and is_static:
            bg_bitmap = [1] * (PANEL_W * PANEL_H)
            bg_packet = protocol.bitmap_command(bg_bitmap, PANEL_W, PANEL_H, color=bg_color)
            await write_large_gatt_char(connected_client, protocol.WRITE_UUID, bytearray(bg_packet), response=True)

        if is_static and tw_final <= PANEL_W:
            pixels = list(final_img_1.getdata())
            bitmap = [1 if p > 0 else 0 for p in pixels]
            packet = protocol.bitmap_command(bitmap, PANEL_W, PANEL_H, color=req.textColor)
            await write_large_gatt_char(connected_client, protocol.WRITE_UUID, bytearray(packet), response=True)
            current_display_mode = "static"
        else:
            speed = req.speed if req.speed is not None else current_speed
            speed = max(1, min(15, speed))
            hw_speed = speed
            
            pixels = list(final_img_1.getdata())
            bitmap = [1 if p > 0 else 0 for p in pixels]
            packet = protocol.hardware_scroll_command(bitmap, tw_final, PANEL_H, color=req.textColor, speed=hw_speed, animation=anim_code)
            await write_large_gatt_char(connected_client, protocol.WRITE_UUID, bytearray(packet), response=True)
            
        # Commit Session
        await asyncio.sleep(0.05)
        await connected_client.write_gatt_char(protocol.WRITE_UUID, protocol.session_end_command(), response=True)

    # 4. Dashboard Preview
    preview_img = Image.new("RGB", (tw_final, PANEL_H), req.bgColor)
    preview_img.paste(Image.new("RGB", (tw_final, PANEL_H), req.textColor), (0, 0), mask=final_img_L)
    save_preview(preview_img, os.path.join(STATIC_DIR, "current.png"))
    current_width = tw_final
    frames_sent += 1

    return {"status": "success"}

def save_preview(img: Image.Image, filepath: str):
    try:
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        img.save(filepath, "PNG")
    except Exception as e:
        print(f"[preview] Failed to save {filepath}: {e}")

def draw_custom_time(draw, time_str_full, font, color, y_offset, PANEL_W, show_colon=True):
    parts = time_str_full.split(':')
    hour_str = parts[0]
    rest = parts[1].split(' ')
    min_str = rest[0]
    am_str = ' ' + rest[1] if len(rest) > 1 else ''
    
    hw = draw.textbbox((0, 0), hour_str, font=font)[2]
    mw = draw.textbbox((0, 0), min_str, font=font)[2]
    aw = draw.textbbox((0, 0), am_str, font=font)[2] if am_str else 0
    
    gap = 1
    cw = 2
    total_w = hw + gap + cw + gap + mw + aw
    start_x = (PANEL_W - total_w) // 2
    
    draw.text((start_x, y_offset), hour_str, font=font, fill=color)
    
    cx = start_x + hw + gap
    if show_colon:
        draw.rectangle([cx, y_offset + 4, cx+1, y_offset + 5], fill=color)
        draw.rectangle([cx, y_offset + 8, cx+1, y_offset + 9], fill=color)
    
    mx = cx + cw + gap
    draw.text((mx, y_offset), min_str, font=font, fill=color)
    
    if am_str:
        ax = mx + mw
        draw.text((ax, y_offset), am_str, font=font, fill=color)

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

async def clock_preview_worker(color: str, format: str = "12h", bg_color: str = "#000000", show_seconds: bool = False, clock_style: str = "custom"):
    global current_display_mode, frames_sent, current_width, connected_client, connection_ready
    try:
        bg_color = (bg_color or "#000000").lower()
        color = (color or "#10B981").lower()
        if clock_style == "default":
            color = "#ffffff"

        
        # Ensure built-in clock is off when streaming custom clock
        if clock_style == "custom" and connected_client and connected_client.is_connected and connection_ready:
            await connected_client.write_gatt_char(protocol.WRITE_UUID, protocol.clock_off_command(), response=True)
            await asyncio.sleep(0.05)
            
        while current_display_mode == "clock":
            now = datetime.datetime.now()
            if format == "24h":
                time_str = now.strftime("%H:%M")
            else:
                time_str = now.strftime("%I:%M %p").lstrip("0")
                
            preview_img = Image.new("RGB", (PANEL_W, PANEL_H), bg_color)
            draw = ImageDraw.Draw(preview_img)
            
            try:
                font = ImageFont.truetype("arial.ttf", 14)
                sec_font = ImageFont.truetype("arial.ttf", 9)
            except Exception:
                font = ImageFont.load_default()
                sec_font = ImageFont.load_default()
                
            if clock_style == "default":
                try:
                    font = ImageFont.truetype("courbd.ttf", 14)
                except Exception:
                    pass
                time_str = now.strftime("%H:%M")
                bbox = draw.textbbox((0, 0), time_str, font=font)
                tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
                y_offset = (PANEL_H - th) // 2 - bbox[1]
                
                draw_default_clock(draw, now, font, color, y_offset, PANEL_W, now.second % 2 == 0)
                sec_val = now.second
                if sec_val > 0:
                    draw.line([(2, 0), (2 + sec_val, 0)], fill=color, width=1)
            else:
                bbox = draw.textbbox((0, 0), time_str, font=font)
                tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
                if show_seconds:
                    sec_val = now.second
                    y_offset = (PANEL_H - th) // 2 - bbox[1]
                    draw_custom_time(draw, time_str, font, color, y_offset, PANEL_W, sec_val % 2 == 0)
                    if sec_val > 0:
                        draw.line([(2, 0), (2 + sec_val, 0)], fill=color, width=1)
                else:
                    y_offset = (PANEL_H - th) // 2 - bbox[1]
                    draw_custom_time(draw, time_str, font, color, y_offset, PANEL_W, now.second % 2 == 0)

            bg_hex = (bg_color or "#000000").lstrip('#')
            bg_rgb = tuple(int(bg_hex[i:i+2], 16) for i in (0, 2, 4)) if len(bg_hex) >= 6 else (0,0,0)
            c_hex = (color or "#10B981").lstrip('#')
            c_rgb = tuple(int(c_hex[i:i+2], 16) for i in (0, 2, 4)) if len(c_hex) >= 6 else (0,255,0)
            
            bitmap = [0 if preview_img.getpixel((x, y)) == bg_rgb else 1 for y in range(PANEL_H) for x in range(PANEL_W)]
            
            for y in range(PANEL_H):
                for x in range(PANEL_W):
                    preview_img.putpixel((x, y), c_rgb if bitmap[y*PANEL_W + x] else bg_rgb)
            
            save_preview(preview_img, os.path.join(STATIC_DIR, "current.png"))
            current_width = PANEL_W
            frames_sent += 1
            
            # Stream frame to device only if custom style
            if clock_style == "custom" and connected_client and connected_client.is_connected and connection_ready:
                try:
                    await connected_client.write_gatt_char(protocol.WRITE_UUID, protocol.session_start_command(), response=True)
                    await asyncio.sleep(0.02)
                    
                    inverted_bitmap = [1 if b == 0 else 0 for b in bitmap]
                    bg_packet = protocol.bitmap_command(inverted_bitmap, PANEL_W, PANEL_H, color=(bg_color or "#000000"))
                    await connected_client.write_gatt_char(protocol.WRITE_UUID, bytearray(bg_packet), response=False)
                    await asyncio.sleep(0.01)
                    
                    fg_packet = protocol.bitmap_command(bitmap, PANEL_W, PANEL_H, color=color)
                    await connected_client.write_gatt_char(protocol.WRITE_UUID, bytearray(fg_packet), response=False)
                    await asyncio.sleep(0.01)
                    
                    await connected_client.write_gatt_char(protocol.WRITE_UUID, protocol.session_end_command(), response=True)
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
        
    if active_scroller_task:
        active_scroller_task.cancel()
        active_scroller_task = None
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
                await connected_client.write_gatt_char(protocol.WRITE_UUID, bytearray(time_pkt), response=True)
                await asyncio.sleep(0.05)
                
                # Turn clock on
                clock_pkt = protocol.clock_on_command()
                await connected_client.write_gatt_char(protocol.WRITE_UUID, bytearray(clock_pkt), response=True)
                await asyncio.sleep(0.05)
        else:
            # Turn off the hardware clock unconditionally if setting custom mode or turning off
            if connected_client and connected_client.is_connected and connection_ready:
                packet = protocol.clock_off_command()
                await connected_client.write_gatt_char(protocol.WRITE_UUID, bytearray(packet), response=False)
                await asyncio.sleep(0.04)
            
        if on:
            # Update last pushed clock configuration
            current_clock_color = color or "#ffffff"
            current_clock_bg_color = bg_color or "#000000"
            current_clock_format = format or "12h"
            current_clock_show_seconds = show_seconds
            current_clock_style = clock_style or "custom"
            
            now = datetime.datetime.now()
            if format == "24h":
                time_str = now.strftime("%H:%M")
            else:
                time_str = now.strftime("%I:%M %p").lstrip("0")
            img = Image.new("RGB", (PANEL_W, PANEL_H), bg_color or "#000000")
            draw = ImageDraw.Draw(img)
            try:
                font = ImageFont.truetype("arial.ttf", 14)
            except Exception:
                font = ImageFont.load_default()
            if clock_style == "default":
                try:
                    font = ImageFont.truetype("courbd.ttf", 14)
                except Exception:
                    pass
                time_str = now.strftime("%H:%M")
                bbox = draw.textbbox((0, 0), time_str, font=font)
                tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
                y_offset = (PANEL_H - th) // 2 - bbox[1]
                
                draw_default_clock(draw, now, font, color, y_offset, PANEL_W, now.second % 2 == 0)
                sec_val = now.second
                if sec_val > 0:
                    draw.line([(2, 0), (2 + sec_val, 0)], fill=color, width=1)
            else:
                bbox = draw.textbbox((0, 0), time_str, font=font)
                tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
                if show_seconds:
                    sec_val = now.second
                    y_offset = (PANEL_H - th) // 2 - bbox[1]
                    draw_custom_time(draw, time_str, font, color, y_offset, PANEL_W, sec_val % 2 == 0)
                    if sec_val > 0:
                        draw.line([(2, 0), (2 + sec_val, 0)], fill=color, width=1)
                else:
                    y_offset = (PANEL_H - th) // 2 - bbox[1]
                    draw_custom_time(draw, time_str, font, color, y_offset, PANEL_W, now.second % 2 == 0)
                
            bg_hex = (bg_color or "#000000").lstrip('#')
            bg_rgb = tuple(int(bg_hex[i:i+2], 16) for i in (0, 2, 4)) if len(bg_hex) >= 6 else (0,0,0)
            c_hex = (color or "#10B981").lstrip('#')
            c_rgb = tuple(int(c_hex[i:i+2], 16) for i in (0, 2, 4)) if len(c_hex) >= 6 else (0,255,0)
            
            bitmap = [0 if img.getpixel((x, y)) == bg_rgb else 1 for y in range(PANEL_H) for x in range(PANEL_W)]
            
            for y in range(PANEL_H):
                for x in range(PANEL_W):
                    img.putpixel((x, y), c_rgb if bitmap[y*PANEL_W + x] else bg_rgb)
            
            save_preview(img, os.path.join(STATIC_DIR, "current.png"))
            
            if clock_style == "custom" and connected_client and connected_client.is_connected and connection_ready:
                await connected_client.write_gatt_char(protocol.WRITE_UUID, protocol.session_start_command(), response=True)
                await asyncio.sleep(0.02)
                
                inverted_bitmap = [1 if b == 0 else 0 for b in bitmap]
                bg_packet = protocol.bitmap_command(inverted_bitmap, PANEL_W, PANEL_H, color=(bg_color or "#000000"))
                await connected_client.write_gatt_char(protocol.WRITE_UUID, bytearray(bg_packet), response=False)
                await asyncio.sleep(0.01)
                
                fg_packet = protocol.bitmap_command(bitmap, PANEL_W, PANEL_H, color=color)
                await connected_client.write_gatt_char(protocol.WRITE_UUID, bytearray(fg_packet), response=False)
                await asyncio.sleep(0.01)
                
                await connected_client.write_gatt_char(protocol.WRITE_UUID, protocol.session_end_command(), response=True)
            
            save_preview(img, os.path.join(STATIC_DIR, "current.png"))
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

def encode_var_len(val: int) -> bytes:
    if val < 128:
        return bytes([val])
    elif val < 256:
        return bytes([129, val])
@app.post("/save-preset")
async def save_preset(req: SavePresetRequest):
    global connected_client, connection_ready, current_speed, active_scroller_task, current_width, current_display_mode, frames_sent
    
    # Cancel any active scrolling or flipper task
    if active_scroller_task:
        active_scroller_task.cancel()
        active_scroller_task = None
        
    preset = req.preset
    slot_id = req.slot_id # 0-indexed slot index (0 to 11)
    
    if preset.mode == 'clock':
        raise HTTPException(status_code=400, detail="Clocks cannot be saved to hardware slots.")
        
    if connected_client and connected_client.is_connected and connection_ready:
        try:
            # Stop any onboard playlist completely (seq=3: 36 00)
            await safe_write_gatt_char(protocol.WRITE_UUID, protocol.stop_playlist_command(), response=True)
            await asyncio.sleep(0.02)
            await safe_write_gatt_char(protocol.WRITE_UUID, protocol.clock_off_command(), response=True)
            await asyncio.sleep(0.02)
            # Clear the screen to solid black while saving
            await safe_write_gatt_char(protocol.WRITE_UUID, protocol.clear_all_command(), response=True)
            await asyncio.sleep(0.02)
        except Exception:
            pass

    try:
        # Step 1: Render the preset content to standard GIF bytes
        from io import BytesIO
        import hashlib
        
        pil_frames = []
        delay_sec = 0.1
        is_anim = False
        
        if preset.pixels is not None:
            # Drawing or animation
            is_anim = preset.fileType in ("gif", "video") or (len(preset.pixels) > 1280)
            if is_anim:
                num_frames = len(preset.pixels) // 1280
                raw_frames = extract_frames(preset.pixels, num_frames)
                frames = quantize_frames(raw_frames, preset.bgColor or "#000000")
                
                speed = preset.speed if preset.speed is not None else current_speed
                speed = max(1, min(15, speed))
                if preset.frameDurationMs is not None and preset.frameDurationMs > 0:
                    delay_sec = max(0.016, preset.frameDurationMs / 1000.0)
                else:
                    delay_sec = max(0.05, 0.4 - (speed * 0.025))
                    
                # Convert color lists to PIL images
                def hex_to_rgb(hex_str: Optional[str]):
                    if not hex_str: return (0, 0, 0)
                    hex_str = hex_str.lstrip('#')
                    if len(hex_str) != 6: return (255, 255, 255)
                    return tuple(int(hex_str[i:i+2], 16) for i in (0, 2, 4))
                
                bg_rgb = hex_to_rgb(preset.bgColor or "#000000")
                for f_pixels in frames:
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
            text = preset.text or ""
            try:
                render_font = ImageFont.truetype("arialbd.ttf", 18)
            except Exception:
                try:
                    render_font = ImageFont.truetype("arial.ttf", 18)
                except Exception:
                    render_font = ImageFont.load_default()
            temp_img = Image.new("L", (1, 1), 0)
            temp_draw = ImageDraw.Draw(temp_img)
            bbox = temp_draw.textbbox((0, 0), text, font=render_font)
            tw = bbox[2] - bbox[0]
            th = bbox[3] - bbox[1]
            if tw <= 0 or th <= 0:
                raise Exception("Nothing to render")
            x = (PANEL_W - tw) // 2 - bbox[0] if (tw <= PANEL_W) else -bbox[0]
            y = (PANEL_H - th) // 2 - bbox[1]
            
            text_img_L = Image.new('L', (PANEL_W, PANEL_H), 0)
            draw = ImageDraw.Draw(text_img_L)
            draw.text((x, y), text, font=render_font, fill=255)
            
            full_rgb = Image.new("RGB", (PANEL_W, PANEL_H), preset.bgColor or "#000000")
            full_rgb.paste(Image.new("RGB", (PANEL_W, PANEL_H), preset.textColor or "#FFFFFF"), (0, 0), mask=text_img_L)
            pil_frames.append(full_rgb)
            
        if not pil_frames:
            raise Exception("Failed to render frames for preset")
            
        gif_io = BytesIO()
        pil_frames[0].save(
            gif_io,
            format="GIF",
            save_all=True,
            append_images=pil_frames[1:],
            duration=int(delay_sec * 1000),
            loop=0
        )
        gif_bytes = gif_io.getvalue()
        
        # Calculate resource ID hash
        gif_hex = gif_bytes.hex().lower()
        md5_hash = hashlib.md5(gif_hex.encode('utf-8')).hexdigest().lower()
        id_pro_ui = slot_id + 1
        prefix = f"{id_pro_ui}0000000"[:8]
        id_res_hex = prefix + md5_hash
        hash_bytes = bytes.fromhex(id_res_hex)

        # --- Save preset data as JSON for reliable replay later ---
        import json as _json
        mac_str = req.address.replace(':', '').lower()
        preset_json_path = os.path.join(STATIC_DIR, f"preset_{mac_str}_{slot_id}.json")
        with open(preset_json_path, "w") as fj:
            _json.dump(preset.dict(), fj)

        # --- Save GIF preview to disk ---
        preset_gif_path = os.path.join(STATIC_DIR, f"preset_{mac_str}_{slot_id}.gif")
        with open(preset_gif_path, "wb") as f:
            f.write(gif_bytes)

        # --- Update live preview with the newly saved preset ---
        current_gif = os.path.join(STATIC_DIR, "current.gif")
        current_png = os.path.join(STATIC_DIR, "current.png")
        try:
            if is_anim or (preset.mode == 'text' and preset.animation and preset.animation != 'static'):
                shutil.copy(preset_gif_path, current_gif)
                if os.path.exists(current_png):
                    try: os.remove(current_png)
                    except Exception: pass
            else:
                pil_frames[0].save(current_png)
                if os.path.exists(current_gif):
                    try: os.remove(current_gif)
                    except Exception: pass
        except Exception:
            pass

        if connected_client and connected_client.is_connected and connection_ready:
            LOY_CHUNK_OVERHEAD = 37
            mtu = getattr(connected_client, 'mtu_size', 23)
            max_single_write = mtu - 3
            # Save to hardware slot
            hw_addr = protocol.WRITE_SLOT_USER_START + slot_id
            
            # Stop playlist and screen while saving to flash
            try:
                await safe_write_gatt_char(protocol.WRITE_UUID, protocol.stop_playlist_command(), response=True)
                await asyncio.sleep(0.02)
                await safe_write_gatt_char(protocol.WRITE_UUID, protocol.clock_off_command(), response=True)
                await asyncio.sleep(0.02)
                await safe_write_gatt_char(protocol.WRITE_UUID, protocol.clear_all_command(), response=True)
                await asyncio.sleep(0.02)
            except Exception:
                pass

            if req.mode == 'image' or req.mode == 'text':
                try:
                    if req.mode == 'image':
                        img_path = get_asset_path("images", preset.filename)
                        if os.path.exists(img_path):
                            pil_img = Image.open(img_path).convert('RGBA')
                            if getattr(pil_img, 'is_animated', False):
                                # It's an animated GIF
                                with open(img_path, 'rb') as f:
                                    gif_bytes = f.read()
                            else:
                                # Static image, generate 1-frame GIF
                                canvas = Image.new('RGB', (64, 20), (0,0,0))
                                pil_img.thumbnail((64, 20), Image.Resampling.LANCZOS)
                                x = (64 - pil_img.width) // 2
                                y = (20 - pil_img.height) // 2
                                canvas.paste(pil_img, (x, y), pil_img if pil_img.mode == 'RGBA' else None)
                                
                                gif_io = io.BytesIO()
                                canvas.save(gif_io, format='GIF', optimize=True)
                                gif_bytes = gif_io.getvalue()
                    else:
                        # Text Mode - create GIF frames
                        frames = generate_text_frames(preset)
                        if not frames: frames = [Image.new('RGB', (64,20), (0,0,0))]
                        
                        if preset.animation and preset.animation != "static":
                            speed_val = max(1, min(255, preset.speed if preset.speed is not None else 48))
                            duration = int(1000 / (speed_val * 2))
                            if duration <= 0: duration = 100
                        else:
                            duration = 100
                            
                        gif_io = io.BytesIO()
                        frames[0].save(
                            gif_io, format='GIF',
                            save_all=True, append_images=frames[1:],
                            duration=duration, loop=0, optimize=True
                        )
                        gif_bytes = gif_io.getvalue()

                    # Upload GIF directly as File 0
                    CHUNK_SIZE = 960
                    session_pkt = protocol.build_file_transfer_session_init(hw_addr=hw_addr, num_files=1)
                    await safe_write_gatt_char(protocol.WRITE_UUID, session_pkt, response=True)
                    await asyncio.sleep(0.05)
                    
                    total_chunks = (len(gif_bytes) + CHUNK_SIZE - 1) // CHUNK_SIZE
                    for i in range(total_chunks):
                        start = i * CHUNK_SIZE
                        chunk = gif_bytes[start:start+CHUNK_SIZE]
                        chunk_pkt = protocol.build_file_transfer_chunk(
                            hw_addr=hw_addr, file_index=0, chunk_index=i,
                            total_chunks=total_chunks, data=chunk, chunk_size=len(chunk)
                        )
                        await write_large_gatt_char(connected_client, protocol.WRITE_UUID, chunk_pkt, response=True)
                        
                    # Commit file transfer
                    commit_pkt = protocol.build_file_transfer_complete(hw_addr, num_frames=1)
                    await safe_write_gatt_char(protocol.WRITE_UUID, commit_pkt, response=True)
                    await asyncio.sleep(0.05)

                    # Enable user slots in hardware sequencer table
                    p1 = bytes([0x35, 0x0a, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d])
                    p2 = bytes([0x35, 0x02, 0x2e, 0x2f])
                    pkt1 = protocol.build_packet(p1, cmd_type=0xC1, sub_type=0x03)
                    pkt2 = protocol.build_packet(p2, cmd_type=0xC1, sub_type=0x03)
                    await safe_write_gatt_char(protocol.WRITE_UUID, pkt1, response=True)
                    await asyncio.sleep(0.02)
                    await safe_write_gatt_char(protocol.WRITE_UUID, pkt2, response=True)
                    await asyncio.sleep(0.02)

                    # Command the sign to play the newly saved user slot from flash memory
                    slot_pkt = protocol.build_user_slot_play_command(slot_id)
                    await safe_write_gatt_char(protocol.WRITE_UUID, slot_pkt, response=True)
                    await asyncio.sleep(0.05)

                    # Do NOT call push_text here, as it starts the Python streaming loop which overrides the hardware playback
                    print(f"[save_preset] Done. Slot {slot_id} (hw=0x{hw_addr:02X}) saved GIF ({len(gif_bytes)} bytes) and locked to display.")

                except Exception as e:
                    print(f"[save_preset] File mode error: {e}")

        # Increment frames sent to signal status updates
        frames_sent += 1
        return {"status": "success", "preview_url": f"/static/preset_{mac_str}_{slot_id}.gif"}



    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/delete-preset/{slot_id}")
async def delete_preset(slot_id: int, mac: str = ""):
    # 1. Delete local file
    mac_str = mac.replace(':', '').lower()
    preset_path = os.path.join(STATIC_DIR, f"preset_{mac_str}_{slot_id}.gif")
    if os.path.exists(preset_path):
        os.remove(preset_path)
        
    # 2. Send delete command to hardware
    try:
        if connected_client and connected_client.is_connected and connection_ready:
            # Session start
            await connected_client.write_gatt_char(protocol.WRITE_UUID, protocol.session_start_command(), response=True)
            await asyncio.sleep(0.05)
            
            # Send Delete Command
            del_pkt = protocol.delete_preset_command(slot_id)
            await write_large_gatt_char(connected_client, protocol.WRITE_UUID, del_pkt, response=True)
            await asyncio.sleep(0.05)
            
            # Session end
            await connected_client.write_gatt_char(protocol.WRITE_UUID, protocol.session_end_command(), response=True)
            await asyncio.sleep(0.05)
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
        
    return {"status": "success"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
