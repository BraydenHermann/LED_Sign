"""
Gemini AI Media Service for LED Sign.
Generates images, animated GIFs, and videos optimized for 64x20 RGB LED matrices
with multimodal reference context attachments.
"""

from __future__ import annotations
import os
import io
import json
import base64
import re
import time
import tempfile
import urllib.request
import urllib.error
from typing import Optional, List, Dict, Any, Tuple

try:
    from PIL import Image, ImageSequence
except ImportError:
    Image = None
    ImageSequence = None

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "gemini_config.json")
ENV_PATHS = [
    os.path.join(BASE_DIR, ".env"),
    os.path.join(BASE_DIR, "..", ".env"),
    os.path.abspath(".env")
]

# Physical LED Matrix Constraints
PANEL_W = 64
PANEL_H = 20
MAX_FRAMES = 300
DEFAULT_SPEED = 8
DEFAULT_DURATION_SEC = 2.4
DEFAULT_FPS = 12
OPTIMAL_GIF_FRAMES = 28
OPTIMAL_FRAME_DURATION_MS = 80


def load_env():
    """Load environment variables from .env files with fallback parser."""
    # 1. Try python-dotenv if installed
    try:
        from dotenv import load_dotenv
        for p in ENV_PATHS:
            if os.path.exists(p):
                load_dotenv(p, override=False)
    except ImportError:
        pass

    # 2. Built-in zero-dependency parser for .env files
    for env_path in ENV_PATHS:
        if os.path.exists(env_path):
            try:
                with open(env_path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line or line.startswith("#") or "=" not in line:
                            continue
                        key, val = line.split("=", 1)
                        key = key.strip()
                        val = val.strip().strip("'\"")
                        if key and val and (key not in os.environ or not os.environ[key]):
                            os.environ[key] = val
            except Exception as e:
                print(f"[GeminiService] Could not parse {env_path}: {e}")

    # Auto-sanitize obsolete/non-existent model names
    if os.environ.get("GEMINI_MODEL") in ("gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"):
        os.environ["GEMINI_MODEL"] = "gemini-3.5-flash-lite"


# Load environment variables on startup
load_env()


SYSTEM_CONSTRAINTS = f"""
You are an expert digital artist, pixel-art typographer, and animator creating pixel assets for a physical 64x20 RGB LED matrix display sign (e.g. car rear windows, desktop banners).

CRITICAL HARDWARE CONSTRAINTS:
1. Matrix Resolution: EXACTLY {PANEL_W} pixels wide by {PANEL_H} pixels high (ultra-wide 3.2:1 / 16:5 aspect ratio banner).
2. Canvas Framing: All artwork must be composed horizontally across the wide banner. Do not place a tall or square subject that leaves empty sides.
3. Pure Black Background: Background MUST be pure solid black (#000000). On physical LEDs, black (#000000) turns off the diodes completely, creating maximum contrast and visibility.
4. Visual Style: Retro pixel art, 8-bit / 16-bit arcade aesthetics, vibrant neon signs, or bold vector silhouettes. Avoid intricate photorealistic textures, fine hairline details (< 2px), tiny unreadable text, or subtle low-contrast gradients.
5. Palette: Vivid, high-saturation colors (neon cyan, electric magenta, bright neon yellow, hot orange, emergency red, crisp white highlights).
6. Animation & Looping: For animations or GIFs, the animation MUST be a seamless infinite loop lasting between 2.0 and 3.0 seconds (around {OPTIMAL_GIF_FRAMES} frames at ~{DEFAULT_FPS} fps / {OPTIMAL_FRAME_DURATION_MS}ms per frame for ultra-fast, smooth Bluetooth transmission). Strict hardware limit is {MAX_FRAMES} frames maximum.

CRITICAL TEXT & LEGIBILITY RULES (THE SCREEN IS ONLY 20 PIXELS TALL):
Physical LED diodes are large and viewed from a distance (e.g., from other vehicles behind or across a room). Tiny text is completely illegible!
- STRICT RULE: NEVER STACK 2 LINES OF TEXT VERTICALLY!
  Because the matrix is only 20 pixels tall, stacking 2 lines of text forces letters to be only 5-7px tall, which is microscopic and illegible on an LED sign.
  Render ONLY ONE single horizontal line of large text (12-16px) per frame/scene, vertically centered.
- STRICT RULE: DO NOT ADD TOP/BOTTOM BORDERS THAT SQUEEZE TEXT!
  Do not add horizontal border bars or dashed lines across y=0..2 or y=18..19 when displaying text, because borders steal precious vertical pixels and crush letter height.
- TEXT MUST BE LARGE AND BOLD:
  Letters MUST be 12px to 16px high with thick strokes (minimum 2px stroke thickness). Never render tiny 3px-6px fonts or unreadable thin hairlines.
- HANDLING LONGER PHRASES (MORE THAN 5-7 CHARACTERS):
  A 64-pixel banner can only fit approximately 5 to 7 large, clearly legible letters at once. If a user asks for a phrase like "Turn off high beams" or "Turn off the high beam", DO NOT attempt to squeeze the entire sentence onto the screen simultaneously, and NEVER stack lines vertically! Instead, use one of these two proven techniques:
  A. SEQUENTIAL MULTI-SCENE PAGING (STRONGLY RECOMMENDED FOR WARNINGS / CAR SIGNS):
     Split the message and animation into distinct scenes/cards across the frame loop!
     * Scene 1 (frames 0 to 12): Display "TURN OFF" in huge, centered bold 14-16px letters (e.g. bright white #FFFFFF or neon yellow #FFE600).
     * Scene 2 (frames 13 to 27): Display "HIGH BEAM" in huge bold letters OR transition to an animated graphic (e.g. headlight rays).
  B. HORIZONTAL SMOOTH SCROLLING (MARQUEE):
     Scroll large, bold 14-16px text smoothly from right to left across the screen (x offset decreasing each frame).
- CAPITALIZATION REQUESTS:
  When asked to "make each word capitalized", "capitalize words", or "ALL CAPS", use large, bold uppercase (e.g. "TURN OFF", "HIGH BEAM") or Title Case with crisp 14-16px letterforms.
- AUTOMOTIVE & SYMBOL GRAPHICS:
  When the prompt requests visual indicators (like "flashing high beams" or car warnings), draw bold, instantly recognizable pixel art icons!
  For high beams: Draw a bold headlight icon with radiating bright rays bursting outward, flashing/strobing between bright neon cyan/yellow/white and off to create a vivid, attention-grabbing warning.
  When the user asks to "turn off the high beam" or remove an effect, do NOT show the glaring high beam rays - show standard low beams or turn off the beams.
- DIRECT 64x20 COORDINATE DRAWING:
  Draw pixels, shapes, and text directly at 64x20 coordinates. Never render on a large canvas and downscale down to 64x20, as downscaling destroys pixel legibility!
"""


def load_config() -> Dict[str, Any]:
    """Load Gemini configuration from file or environment."""
    load_env()
    raw_model = os.getenv("GEMINI_MODEL") or "gemini-3.8-flash"
    if raw_model in ("gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash", "gemini-3.5-flash-lite"):
        raw_model = "gemini-3.8-flash"
    cfg = {
        "api_key": os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY") or "",
        "model": raw_model,
        "image_model": "imagen-3.0-generate-002",
        "default_mode": os.getenv("GEMINI_DEFAULT_MODE") or "gif"
    }
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                saved = json.load(f)
                if isinstance(saved, dict):
                    cfg.update({k: v for k, v in saved.items() if v})
        except Exception as e:
            print(f"[GeminiService] Error reading config: {e}")
    # Always prioritize non-empty env var if available
    env_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if env_key:
        cfg["api_key"] = env_key
    if cfg.get("model") in ("gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash", "gemini-3.5-flash-lite"):
        cfg["model"] = "gemini-3.8-flash"
    return cfg


def save_config(new_cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Persist Gemini configuration to JSON config and .env file."""
    current = load_config()
    current.update(new_cfg)
    
    # Save to JSON config
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(current, f, indent=2)
    except Exception as e:
        print(f"[GeminiService] Error saving JSON config: {e}")

    # Also update/save into .env files if apiKey is provided
    api_key = current.get("api_key", "").strip()
    if api_key:
        os.environ["GEMINI_API_KEY"] = api_key
        for target_env in [os.path.join(BASE_DIR, ".env"), os.path.join(BASE_DIR, "..", ".env")]:
            try:
                lines = []
                found_key = False
                if os.path.exists(target_env):
                    with open(target_env, "r", encoding="utf-8") as f:
                        lines = f.readlines()
                new_lines = []
                for line in lines:
                    if line.strip().startswith("GEMINI_API_KEY="):
                        new_lines.append(f"GEMINI_API_KEY={api_key}\n")
                        found_key = True
                    else:
                        new_lines.append(line)
                if not found_key:
                    new_lines.append(f"\nGEMINI_API_KEY={api_key}\n")
                with open(target_env, "w", encoding="utf-8") as f:
                    f.writelines(new_lines)
            except Exception as e:
                print(f"[GeminiService] Could not write .env to {target_env}: {e}")

    return current


def get_api_key() -> str:
    cfg = load_config()
    return cfg.get("api_key", "").strip()


def check_status() -> Dict[str, Any]:
    load_env()
    key = get_api_key()
    masked = f"{key[:4]}...{key[-4:]}" if len(key) > 8 else ("Set" if key else "Missing")
    cfg = load_config()
    return {
        "configured": bool(key),
        "masked_key": masked if key else None,
        "model": cfg.get("model", "gemini-2.0-flash"),
        "image_model": cfg.get("image_model", "imagen-3.0-generate-002"),
        "default_mode": cfg.get("default_mode", "gif"),
        "hardware_limits": {
            "width": PANEL_W,
            "height": PANEL_H,
            "aspect_ratio": "3.2:1",
            "max_frames": MAX_FRAMES,
            "optimal_frames": OPTIMAL_GIF_FRAMES,
            "optimal_fps": DEFAULT_FPS,
            "optimal_duration_sec": DEFAULT_DURATION_SEC,
            "optimal_frame_duration_ms": OPTIMAL_FRAME_DURATION_MS
        }
    }


def _call_gemini_rest(
    endpoint: str,
    payload: Dict[str, Any],
    api_key: Optional[str] = None,
    timeout: int = 60
) -> Dict[str, Any]:
    """Low-level caller for Google Generative AI REST endpoints."""
    key = api_key or get_api_key()
    if not key:
        raise ValueError("Gemini API key is not configured. Please set GEMINI_API_KEY in your .env file or enter your API key in the UI.")

    separator = "&" if "?" in endpoint else "?"
    url = f"{endpoint}{separator}key={key}"
    data_bytes = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data_bytes,
        headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body)
    except urllib.error.HTTPError as err:
        err_body = err.read().decode("utf-8")
        try:
            parsed = json.loads(err_body)
            msg = parsed.get("error", {}).get("message", err_body)
        except Exception:
            msg = err_body
        raise RuntimeError(f"Gemini API Error ({err.code}): {msg}")
    except Exception as e:
        raise RuntimeError(f"Failed to communicate with Gemini API: {str(e)}")


def _normalize_color(r: int, g: int, b: int, bg_is_black: bool = True) -> Any:
    """Rounds color to multiple of 16 for matrix stability and turns near-black off."""
    if bg_is_black and r < 16 and g < 16 and b < 16:
        return 0
    rnd_r = min(255, max(0, int(round(r / 16.0)) * 16))
    rnd_g = min(255, max(0, int(round(g / 16.0)) * 16))
    rnd_b = min(255, max(0, int(round(b / 16.0)) * 16))
    return f"#{rnd_r:02x}{rnd_g:02x}{rnd_b:02x}"


def convert_image_to_matrix_pixels(pil_img: Image.Image) -> List[Any]:
    """Resizes and maps a PIL image to exact 64x20 matrix pixels."""
    if Image is None:
        raise RuntimeError("Pillow is not installed.")

    panel = Image.new("RGBA", (PANEL_W, PANEL_H), (0, 0, 0, 255))
    src_w, src_h = pil_img.size
    aspect = src_w / max(1, src_h)
    panel_aspect = PANEL_W / PANEL_H  # 3.2
    
    if aspect > panel_aspect:
        new_w = PANEL_W
        new_h = max(1, int(round(PANEL_W / aspect)))
    else:
        new_h = PANEL_H
        new_w = max(1, int(round(PANEL_H * aspect)))
        
    resized = pil_img.convert("RGBA").resize((new_w, new_h), Image.Resampling.LANCZOS)
    x_pos = (PANEL_W - new_w) // 2
    y_pos = (PANEL_H - new_h) // 2
    panel.paste(resized, (x_pos, y_pos), resized)
    
    rgb_panel = panel.convert("RGB")
    pixel_data = list(rgb_panel.getdata())
    return [_normalize_color(r, g, b, True) for r, g, b in pixel_data]


def convert_gif_to_matrix_pixels(pil_gif: Image.Image) -> Tuple[List[Any], List[int]]:
    """Converts a multi-frame PIL GIF into row-stitched matrix pixels and durations."""
    if Image is None:
        raise RuntimeError("Pillow is not installed.")

    frames = []
    durations = []
    
    n_frames = getattr(pil_gif, "n_frames", 1)
    if n_frames > MAX_FRAMES:
        raise ValueError(f"GIF contains {n_frames} frames, exceeding maximum of {MAX_FRAMES} frames.")
        
    for i in range(n_frames):
        try:
            pil_gif.seek(i)
            frame_rgba = pil_gif.copy().convert("RGBA")
            frame_pixels = convert_image_to_matrix_pixels(frame_rgba)
            frames.append(frame_pixels)
            duration = pil_gif.info.get("duration", OPTIMAL_FRAME_DURATION_MS) or OPTIMAL_FRAME_DURATION_MS
            durations.append(max(16, int(duration)))
        except EOFError:
            break
            
    if not frames:
        raise ValueError("No valid frames could be extracted from GIF.")
        
    num_frames = len(frames)
    stitched = []
    for r in range(PANEL_H):
        for f in range(num_frames):
            start_idx = r * PANEL_W
            stitched.extend(frames[f][start_idx:start_idx + PANEL_W])
            
    return stitched, durations


class GeneratedBytes(bytes):
    """Subclass of bytes carrying the Python script that generated it."""
    script: str = ""

    def __new__(cls, b: bytes, script: str = ""):
        obj = super().__new__(cls, b)
        obj.script = script
        return obj


def get_candidate_models(model_id: Optional[str] = None) -> List[str]:
    """
    Returns an ordered list of candidate Gemini models to try,
    handling aliases like nano-banana and falling back gracefully.
    """
    cfg = load_config()
    chosen = (model_id or cfg.get("model") or "gemini-3.8-flash").strip()

    # Map friendly aliases
    if chosen in ("nano-banana", "nano_banana", "gemini-nano-banana", "gemini-nano-banana-2.1"):
        chosen = "gemini-nano-banana-2.1"
    elif chosen in ("gemini-3.8-pro", "gemini-pro-latest"):
        chosen = "gemini-3.1-pro-preview"

    chains: Dict[str, List[str]] = {
        "gemini-nano-banana-2.1": [
            "gemini-nano-banana-2.1",
            "gemini-3.1-flash-image",
            "gemini-3-pro-image",
            "gemini-2.5-flash-image",
            "gemini-3.8-flash",
            "gemini-3.6-flash",
            "gemini-3.5-flash"
        ],
        "gemini-3.1-flash-image": [
            "gemini-3.1-flash-image",
            "gemini-nano-banana-2.1",
            "gemini-3-pro-image",
            "gemini-2.5-flash-image",
            "gemini-3.8-flash",
            "gemini-3.6-flash"
        ],
        "gemini-3.8-flash": [
            "gemini-3.8-flash",
            "gemini-3.6-flash",
            "gemini-3.5-flash",
            "gemini-3-flash-preview",
            "gemini-3.1-pro-preview"
        ],
        "gemini-3.6-flash": [
            "gemini-3.6-flash",
            "gemini-3.8-flash",
            "gemini-3.5-flash",
            "gemini-3-flash-preview"
        ],
        "gemini-3.5-flash": [
            "gemini-3.5-flash",
            "gemini-3.6-flash",
            "gemini-3.8-flash",
            "gemini-3.5-flash-lite"
        ],
        "gemini-3.1-pro-preview": [
            "gemini-3.1-pro-preview",
            "gemini-3-pro-image",
            "gemini-3.8-flash",
            "gemini-3.6-flash"
        ]
    }
    candidates = list(chains.get(chosen, [chosen, "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash"]))
    for fallback in ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.1-pro-preview"]:
        if fallback not in candidates:
            candidates.append(fallback)
    return candidates


def create_gif_storyboard(gif_bytes: bytes, max_keyframes: int = 16) -> Tuple[Optional[bytes], int, int]:
    """
    Unpacks an animated GIF and creates a crisp nearest-neighbor scaled contact sheet
    so Gemini Vision can clearly inspect the full animation progression rather than
    just Frame 0. Returns (storyboard_png_bytes, frame_count, avg_duration_ms).
    """
    if Image is None or ImageSequence is None:
        return None, 1, 80
    try:
        pil_gif = Image.open(io.BytesIO(gif_bytes))
        frames = []
        durations = []
        for frame in ImageSequence.Iterator(pil_gif):
            frames.append(frame.copy().convert("RGB"))
            durations.append(frame.info.get("duration", 80) or 80)
        n = len(frames)
        if n <= 1:
            return None, n, int(durations[0]) if durations else 80

        avg_dur = int(sum(durations) / max(1, len(durations)))

        if n <= max_keyframes:
            selected_indices = list(range(n))
        else:
            step = (n - 1) / float(max_keyframes - 1)
            selected_indices = [int(round(i * step)) for i in range(max_keyframes)]
            seen = set()
            selected_indices = [x for x in selected_indices if not (x in seen or seen.add(x))]

        selected_frames = [frames[i] for i in selected_indices]
        num_sel = len(selected_frames)
        cols = min(4, num_sel)
        rows = (num_sel + cols - 1) // cols

        scale = 2
        fw, fh = PANEL_W * scale, PANEL_H * scale
        pad = 2
        sheet_w = cols * fw + (cols + 1) * pad
        sheet_h = rows * fh + (rows + 1) * pad

        sheet = Image.new("RGB", (sheet_w, sheet_h), (25, 25, 25))
        for idx, (f_idx, f_img) in enumerate(zip(selected_indices, selected_frames)):
            c = idx % cols
            r = idx // cols
            x = pad + c * (fw + pad)
            y = pad + r * (fh + pad)
            scaled = f_img.resize((fw, fh), Image.Resampling.NEAREST)
            sheet.paste(scaled, (x, y))

        buf = io.BytesIO()
        sheet.save(buf, format="PNG")
        return buf.getvalue(), n, avg_dur
    except Exception as e:
        print(f"[GeminiService] Failed to create GIF storyboard: {e}")
        return None, 1, 80


def prepare_attachment_parts(
    attachments: Optional[List[Dict[str, str]]]
) -> Tuple[List[Dict[str, Any]], str, Dict[str, Any]]:
    """
    Processes attachments into Gemini inlineData parts.
    If an animated GIF is present, extracts frames, generates a contact sheet,
    and returns extra context notes and input media metadata.
    """
    parts: List[Dict[str, Any]] = []
    notes: List[str] = []
    media_info: Dict[str, Any] = {
        "has_gif": False,
        "gif_bytes": None,
        "image_bytes": None,
        "frame_count": 0
    }

    if not attachments:
        return parts, "", media_info

    for att in attachments:
        data = att.get("data", "")
        if "," in data:
            data = data.split(",", 1)[1]
        mime = att.get("mimeType", "image/png")

        try:
            raw_bytes = base64.b64decode(data)
        except Exception:
            raw_bytes = b""

        is_gif = (mime == "image/gif") or raw_bytes.startswith((b"GIF87a", b"GIF89a"))

        if is_gif and raw_bytes and Image is not None:
            storyboard_bytes, n_frames, avg_dur = create_gif_storyboard(raw_bytes)
            media_info["has_gif"] = True
            media_info["gif_bytes"] = raw_bytes
            media_info["frame_count"] = n_frames

            if storyboard_bytes and n_frames > 1:
                storyboard_b64 = base64.b64encode(storyboard_bytes).decode("ascii")
                parts.append({
                    "inlineData": {
                        "mimeType": "image/png",
                        "data": storyboard_b64
                    }
                })
                notes.append(
                    f"Attached reference is an animated GIF with {n_frames} frames ({avg_dur}ms/frame). "
                    f"A multi-frame storyboard contact sheet showing key frames across the animation "
                    f"timeline is provided above so you can inspect the complete animation progression."
                )
            else:
                parts.append({
                    "inlineData": {
                        "mimeType": "image/gif",
                        "data": data
                    }
                })
        else:
            if raw_bytes and not media_info["image_bytes"]:
                media_info["image_bytes"] = raw_bytes
            parts.append({
                "inlineData": {
                    "mimeType": mime,
                    "data": data
                }
            })

    context_str = ("\n- REFERENCE CONTEXT:\n" + "\n".join(notes)) if notes else ""
    return parts, context_str, media_info


def generate_still_image(
    prompt: str,
    attachments: Optional[List[Dict[str, str]]] = None,
    api_key: Optional[str] = None,
    history: Optional[List[str]] = None,
    model: Optional[str] = None,
    previous_script: Optional[str] = None
) -> Dict[str, Any]:
    """Generates a still image using Gemini / Imagen and resizes to 64x20."""
    if Image is None:
        raise RuntimeError("Pillow is not installed.")

    cfg = load_config()
    image_model = cfg.get("image_model", "imagen-3.0-generate-002")

    history_context = ""
    if history:
        clean_history = [h.strip() for h in history if h and h.strip()]
        if clean_history:
            history_context = f" (Context from previous requests: {', '.join(clean_history[-3:])})"

    enhanced_prompt = (
        f"{prompt}{history_context}. High-contrast pixel art style, retro arcade 8-bit aesthetic, "
        f"horizontal 16:5 panoramic composition, pure solid black background (#000000), "
        f"vibrant saturated neon colors, clear bold silhouettes, no thin lines, no tiny text."
    )

    imagen_url = f"https://generativelanguage.googleapis.com/v1beta/models/{image_model}:predict"
    payload = {
        "instances": [{"prompt": enhanced_prompt}],
        "parameters": {
            "aspectRatio": "16:9",
            "outputMimeType": "image/png",
            "sampleCount": 1
        }
    }

    image_bytes = None
    generated_code = ""
    try:
        res = _call_gemini_rest(imagen_url, payload, api_key=api_key, timeout=45)
        predictions = res.get("predictions", [])
        if predictions and "bytesBase64Encoded" in predictions[0]:
            image_bytes = base64.b64decode(predictions[0]["bytesBase64Encoded"])
    except Exception as e:
        print(f"[GeminiService] Imagen predict fallback to Pillow script: {e}")

        models_to_try = get_candidate_models(model)
        att_parts, att_guidance, media_info = prepare_attachment_parts(attachments)

        followup_guidance = ""
        if previous_script and previous_script.strip():
            followup_guidance = f"""
=============================================================================
FOLLOW-UP EDIT / REFINEMENT MODE:
Modify this existing, working Python script for '{prompt}':
```python
{previous_script.strip()}
```
Apply the requested changes to this script rather than starting from scratch.
Return ONLY executable Python code inside a ```python ``` block.
=============================================================================
"""

        instruction = (
            f"{SYSTEM_CONSTRAINTS}\n\n"
            f"Task: Generate Python Pillow script that creates a 64x20 PNG image for: '{prompt}'.{att_guidance}{followup_guidance}\n"
            "- In PIL (Pillow), use draw.point((x, y), fill=...) or image.putpixel((x, y), color) for individual pixels.\n"
            "- Output: Save directly to OUTPUT_PATH.\n"
            "Output ONLY executable Python code inside a ```python ``` block."
        )

        parts = [{"text": instruction}]
        parts.extend(att_parts)

        gen_payload = {
            "contents": [{"parts": parts}],
            "generationConfig": {"temperature": 0.4}
        }
        res = None
        last_err = None
        for m in models_to_try:
            gemini_url = f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent"
            try:
                res = _call_gemini_rest(gemini_url, gen_payload, api_key=api_key, timeout=40)
                if res and res.get("candidates"):
                    break
            except Exception as e:
                last_err = e
                print(f"[GeminiService] Model '{m}' failed: {e}. Trying fallback model...")
                continue
        if not res:
            raise last_err or RuntimeError("Gemini did not return any candidates.")
        candidates = res.get("candidates", [])
        if not candidates:
            raise RuntimeError("Gemini did not return any candidates.")

        text_reply = candidates[0].get("content", {}).get("parts", [{}])[0].get("text", "")
        image_bytes = _execute_pillow_script(text_reply, output_type="png", media_info=media_info)
        generated_code = getattr(image_bytes, "script", text_reply)

    pil_img = Image.open(io.BytesIO(image_bytes))
    pixels = convert_image_to_matrix_pixels(pil_img)

    final_panel = Image.new("RGB", (PANEL_W, PANEL_H), (0, 0, 0))
    for idx, col in enumerate(pixels):
        x = idx % PANEL_W
        y = idx // PANEL_W
        if col and isinstance(col, str) and col.startswith("#"):
            r = int(col[1:3], 16)
            g = int(col[3:5], 16)
            b = int(col[5:7], 16)
            final_panel.putpixel((x, y), (r, g, b))

    buf = io.BytesIO()
    final_panel.save(buf, format="PNG")
    data_url = f"data:image/png;base64,{base64.b64encode(buf.getvalue()).decode('ascii')}"

    return {
        "fileType": "image",
        "imgSrc": data_url,
        "pixels": pixels,
        "width": PANEL_W,
        "height": PANEL_H,
        "suggestedName": f"Gemini: {prompt[:24].strip()}",
        "script": generated_code
    }


def generate_animated_gif(
    prompt: str,
    attachments: Optional[List[Dict[str, str]]] = None,
    api_key: Optional[str] = None,
    history: Optional[List[str]] = None,
    model: Optional[str] = None,
    previous_script: Optional[str] = None
) -> Dict[str, Any]:
    """Generates an animated GIF adhering to 64x20 resolution and <= 300 frame limits."""
    if Image is None:
        raise RuntimeError("Pillow is not installed.")

    models_to_try = get_candidate_models(model)
    att_parts, att_guidance, media_info = prepare_attachment_parts(attachments)

    history_guidance = ""
    if history:
        clean_history = [h.strip() for h in history if h and h.strip()]
        if clean_history:
            history_text = "\n".join(f"- \"{h}\"" for h in clean_history[-5:])
            history_guidance = f"""
- PREVIOUS CONVERSATION / PROMPT HISTORY:
The user previously requested:
{history_text}
This current request (\"{prompt}\") is a follow-up or refinement in this ongoing conversation. Incorporate context from the previous requests while addressing the latest prompt.
The latest request takes priority over both history and the attached canvas. Treat explicit corrections and exclusions as requirements.
"""

    followup_guidance = ""
    if previous_script and previous_script.strip():
        clean_prev = previous_script.strip()
        followup_guidance = f"""
=============================================================================
FOLLOW-UP EDIT / REFINEMENT MODE:
The user is asking to modify or refine an existing, working Python Pillow script from earlier in this conversation:
Latest user instruction: \"{prompt}\"

EXISTING SCRIPT:
```python
{clean_prev}
```

REFINEMENT RULES:
1. Do NOT rewrite the animation from scratch. Modify the existing script to incorporate the user's requested changes.
2. Preserve existing animation timing, frame count, coordinate math, and styling unless the user explicitly requested to change them.
3. If the user asks to capitalize words (e.g. \"make each word capitalized\"), update the text strings / capitalization in the existing script (e.g. \"TURN OFF\", \"HIGH BEAM\").
4. If the user asks to \"turn off the high beam\" or remove an effect, disable or remove the flashing beam rays or graphic as requested.
5. Strictly obey hardware constraints: exactly 1 horizontal line of text (never stack 2 lines vertically), minimum 12-16px font size, no top/bottom borders that squeeze text.
6. Return the COMPLETE, updated executable Python script inside ```python ... ```.
=============================================================================
"""

    instruction = f"""{SYSTEM_CONSTRAINTS}

Generate a complete, self-contained Python script using PIL (Pillow) and math/random that renders a pixel-perfect animated GIF of 64x20 pixels matching: \"{prompt}\".{history_guidance}{att_guidance}{followup_guidance}

CRITICAL RULES FOR MAXIMUM SMOOTHNESS AND FAST HARDWARE TRANSFER:
- Image resolution: EXACTLY width=64, height=20.
- Frame count: between 24 and 32 frames (optimal is {OPTIMAL_GIF_FRAMES} frames). This guarantees lightning-fast Bluetooth Low Energy transfer to the sign with zero lag or frame dropping.
- Frame duration: 75ms to 90ms (recommended {OPTIMAL_FRAME_DURATION_MS}ms, i.e. duration={OPTIMAL_FRAME_DURATION_MS}) for smooth 12-14 fps playback.
- Background: pure solid black (0, 0, 0).
- Seamless loop: the last frame must naturally loop back into the first frame.
- Pixel Art / Geometry: Draw high-contrast shapes, icons, pixel characters, glowing lines, animated moving elements, scrolling accents, or neon effects.
- In PIL (Pillow), use `draw.point((x, y), fill=...)` or `image.putpixel((x, y), (r, g, b))` for drawing individual pixels (ImageDraw does not natively have .pixel(), use .point()).
- Output: Save the animated GIF directly to the filename specified in variable `OUTPUT_PATH`.
  Example: frames[0].save(OUTPUT_PATH, save_all=True, append_images=frames[1:], duration={OPTIMAL_FRAME_DURATION_MS}, loop=0)
- Do NOT import any packages other than PIL (Image, ImageDraw, ImageColor, ImageFilter, ImageFont), math, random, colorsys, itertools, and time.
- Return ONLY the Python code block wrapped in ```python ... ```.
- Check that the entire script is valid Python before responding. Do not include placeholders, incomplete expressions, or prose outside the code block.
"""

    parts = [{"text": instruction}]
    parts.extend(att_parts)

    payload = {
        "contents": [{"parts": parts}],
        "generationConfig": {"temperature": 0.4}
    }

    res = None
    last_err = None
    for m in models_to_try:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent"
        try:
            res = _call_gemini_rest(url, payload, api_key=api_key, timeout=40)
            if res and res.get("candidates"):
                break
        except Exception as e:
            last_err = e
            print(f"[GeminiService] Model '{m}' failed: {e}. Trying fallback model...")
            continue
    if not res:
        raise last_err or RuntimeError("Gemini did not return any code candidates.")
    candidates = res.get("candidates", [])
    if not candidates:
        raise RuntimeError("Gemini did not return any code candidates.")

    text_content = candidates[0].get("content", {}).get("parts", [{}])[0].get("text", "")
    gif_bytes = _execute_generated_with_repair(text_content, prompt, url, api_key, output_type="gif", media_info=media_info)

    pil_gif = Image.open(io.BytesIO(gif_bytes))
    stitched_pixels, durations = convert_gif_to_matrix_pixels(pil_gif)
    avg_duration = int(sum(durations) / max(1, len(durations)))

    data_url = f"data:image/gif;base64,{base64.b64encode(gif_bytes).decode('ascii')}"

    return {
        "fileType": "gif",
        "imgSrc": data_url,
        "pixels": stitched_pixels,
        "frameDurationMs": avg_duration,
        "frameDurationsMs": durations,
        "frameCount": getattr(pil_gif, "n_frames", 1),
        "width": PANEL_W,
        "height": PANEL_H,
        "suggestedName": f"Gemini GIF: {prompt[:24].strip()}",
        "script": getattr(gif_bytes, "script", text_content)
    }


def generate_video(
    prompt: str,
    attachments: Optional[List[Dict[str, str]]] = None,
    api_key: Optional[str] = None,
    history: Optional[List[str]] = None,
    model: Optional[str] = None,
    previous_script: Optional[str] = None
) -> Dict[str, Any]:
    """Generates animation frames and packages as video/gif preset for the sign."""
    gif_result = generate_animated_gif(
        prompt, attachments=attachments, api_key=api_key, history=history, model=model, previous_script=previous_script
    )
    gif_result["fileType"] = "video"
    gif_result["suggestedName"] = f"Gemini Video: {prompt[:24].strip()}"
    return gif_result


def _execute_generated_with_repair(
    script_text: str,
    prompt: str,
    endpoint: str,
    api_key: Optional[str],
    output_type: str,
    media_info: Optional[Dict[str, Any]] = None
) -> GeneratedBytes:
    """Give Gemini two chances to repair its own invalid Pillow script."""
    current_text = script_text
    for attempt in range(3):
        try:
            return _execute_pillow_script(current_text, output_type=output_type, media_info=media_info)
        except RuntimeError as error:
            if attempt == 2:
                raise RuntimeError("Gemini returned invalid animation code after two automatic repair attempts.") from error
            repair_prompt = (
                f"Repair this complete Python Pillow script for a 64x20 {output_type.upper()} animation. "
                f"The latest user request is: {prompt!r}. Corrections in that request override any "
                "earlier image or prompt; do not add objects the user rejected. "
                f"Execution failed with: {str(error)[:400]}. "
                "Keep the original intended animation, use only PIL/math/random/colorsys/itertools/time, "
                "save the result to OUTPUT_PATH, and return only a complete executable ```python code block.\n\n"
                f"Previous response:\n{current_text}"
            )
            repaired = _call_gemini_rest(
                endpoint,
                {"contents": [{"parts": [{"text": repair_prompt}]}], "generationConfig": {"temperature": 0.2}},
                api_key=api_key,
                timeout=40,
            )
            candidates = repaired.get("candidates", [])
            current_text = candidates[0].get("content", {}).get("parts", [{}])[0].get("text", "") if candidates else ""
            if not current_text.strip():
                raise RuntimeError("Gemini could not repair its generated animation code.") from error
    raise RuntimeError("Gemini did not produce an animation.")


def _execute_pillow_script(
    script_text: str,
    output_type: str = "gif",
    media_info: Optional[Dict[str, Any]] = None
) -> GeneratedBytes:
    """Extracts python code block from Gemini response and executes it safely."""
    match = re.search(r"```(?:python)?\s*(.*?)\s*```", script_text, re.DOTALL)
    code = match.group(1) if match else script_text

    with tempfile.TemporaryDirectory() as tmpdir:
        out_ext = ".gif" if output_type == "gif" else ".png"
        output_file = os.path.join(tmpdir, f"output{out_ext}")

        import math
        import random
        import colorsys
        import sys
        import glob
        import time
        import itertools
        from PIL import Image, ImageDraw, ImageColor, ImageFilter, ImageFont, ImageSequence

        # Shim ImageFont.truetype so missing local font files fall back gracefully
        orig_truetype = getattr(ImageFont, "truetype", None)
        def _safe_truetype(*args, **kwargs):
            try:
                if orig_truetype:
                    return orig_truetype(*args, **kwargs)
            except Exception:
                pass
            # Try system bold fonts on Windows and unifont fallback
            font_size = kwargs.get("size")
            if not font_size and len(args) > 1 and isinstance(args[1], int):
                font_size = args[1]
            if not font_size:
                font_size = 14
            for font_cand in [
                "C:/Windows/Fonts/arialbd.ttf",
                "C:/Windows/Fonts/arial.ttf",
                "C:/Windows/Fonts/segoeuib.ttf",
                "C:/Windows/Fonts/calibrib.ttf",
                os.path.join(BASE_DIR, "unifont.otf"),
            ]:
                if os.path.exists(font_cand) and orig_truetype:
                    try:
                        return orig_truetype(font_cand, size=font_size)
                    except Exception:
                        pass
            try:
                return ImageFont.load_default(size=font_size)
            except Exception:
                return ImageFont.load_default()

        ImageFont.truetype = _safe_truetype

        # Comprehensive shims on ImageDraw to support LLM code calling .pixel() etc.
        def _shim_pixel(self, *args, **kwargs):
            if not args and not kwargs:
                return
            if len(args) >= 2 and isinstance(args[0], (int, float)) and isinstance(args[1], (int, float)):
                xy = (int(round(args[0])), int(round(args[1])))
                fill = args[2] if len(args) > 2 else kwargs.get("fill", kwargs.get("color", None))
                return self.point(xy, fill=fill)
            elif len(args) >= 1:
                xy = args[0]
                fill = args[1] if len(args) > 1 else kwargs.get("fill", kwargs.get("color", None))
                return self.point(xy, fill=fill)
            return self.point(*args, **kwargs)

        ImageDraw.ImageDraw.pixel = _shim_pixel
        ImageDraw.ImageDraw.putpixel = _shim_pixel
        ImageDraw.ImageDraw.set_pixel = _shim_pixel
        ImageDraw.ImageDraw.draw_pixel = _shim_pixel
        if not hasattr(ImageDraw.ImageDraw, 'dot'):
            ImageDraw.ImageDraw.dot = _shim_pixel
        if not hasattr(ImageDraw.ImageDraw, 'box'):
            ImageDraw.ImageDraw.box = ImageDraw.ImageDraw.rectangle
        if not hasattr(ImageDraw.ImageDraw, 'rect'):
            ImageDraw.ImageDraw.rect = ImageDraw.ImageDraw.rectangle
        if not hasattr(ImageDraw.ImageDraw, 'round_rectangle') and hasattr(ImageDraw.ImageDraw, 'rounded_rectangle'):
            ImageDraw.ImageDraw.round_rectangle = ImageDraw.ImageDraw.rounded_rectangle

        # Safe time shim so time.sleep does not hang server processing
        class _SafeTime:
            def __init__(self, real_time):
                self._real = real_time
            def sleep(self, *args, **kwargs):
                pass
            def time(self):
                return self._real.time()
            def monotonic(self):
                return self._real.monotonic()
            def __getattr__(self, name):
                return getattr(self._real, name)

        safe_time = _SafeTime(time)

        def safe_import(name, globals=None, locals=None, fromlist=(), level=0):
            base_mod = name.split(".")[0]
            if base_mod == "time":
                return safe_time
            if base_mod in ("math", "random", "colorsys", "PIL", "itertools"):
                return __import__(name, globals, locals, fromlist, level)
            raise ImportError(f"Importing '{name}' is not permitted.")

        builtins_dict = {
            k: (getattr(__builtins__, k) if hasattr(__builtins__, k) else __builtins__[k])
            for k in [
                "range", "len", "min", "max", "int", "float", "abs", "round",
                "list", "dict", "set", "tuple", "bool", "enumerate", "zip",
                "isinstance", "print", "Exception", "ValueError", "str", "True", "False", "None",
                "sorted", "reversed", "any", "all", "sum", "map", "filter", "chr", "ord", "pow", "divmod"
            ] if (hasattr(__builtins__, k) or (isinstance(__builtins__, dict) and k in __builtins__))
        }
        builtins_dict["__import__"] = safe_import

        # Write any attached input media to temp files for script reference
        input_gif_path = ""
        input_image_path = ""
        input_frames = []
        if media_info:
            if media_info.get("gif_bytes"):
                input_gif_path = os.path.join(tmpdir, "input.gif")
                with open(input_gif_path, "wb") as f_gif:
                    f_gif.write(media_info["gif_bytes"])
                try:
                    loaded_gif = Image.open(input_gif_path)
                    input_frames = [f.copy().convert("RGB") for f in ImageSequence.Iterator(loaded_gif)]
                except Exception:
                    pass
            if media_info.get("image_bytes"):
                input_image_path = os.path.join(tmpdir, "input.png")
                with open(input_image_path, "wb") as f_img:
                    f_img.write(media_info["image_bytes"])

        exec_globals = {
            "__builtins__": builtins_dict,
            "__name__": "__main__",
            "OUTPUT_PATH": output_file,
            "INPUT_GIF_PATH": input_gif_path,
            "INPUT_IMAGE_PATH": input_image_path,
            "INPUT_FRAMES": input_frames,
            "math": math,
            "random": random,
            "colorsys": colorsys,
            "time": safe_time,
            "itertools": itertools,
            "Image": Image,
            "ImageDraw": ImageDraw,
            "ImageColor": ImageColor,
            "ImageFilter": ImageFilter,
            "ImageFont": ImageFont,
            "ImageSequence": ImageSequence
        }

        cwd_before = os.getcwd()
        original_save = Image.Image.save

        def hooked_save(self, fp, *args, **kwargs):
            res = original_save(self, fp, *args, **kwargs)
            try:
                if str(fp) != output_file:
                    original_save(self, output_file, *args, **kwargs)
            except Exception:
                pass
            return res

        Image.Image.save = hooked_save
        try:
            exec(code, exec_globals)
        except Exception as e:
            raise RuntimeError(f"Failed to execute generated animation code: {e}")
        finally:
            Image.Image.save = original_save

        if not os.path.exists(output_file) or os.path.getsize(output_file) == 0:
            for cand in glob.glob(os.path.join(tmpdir, f"*{out_ext}")):
                if os.path.getsize(cand) > 0:
                    output_file = cand
                    break

        if not os.path.exists(output_file) or os.path.getsize(output_file) == 0:
            recent_threshold = time.time() - 30
            for cand in glob.glob(os.path.join(cwd_before, f"*{out_ext}")):
                try:
                    if os.path.getmtime(cand) >= recent_threshold and os.path.getsize(cand) > 0:
                        with open(cand, "rb") as f_in, open(output_file, "wb") as f_out:
                            f_out.write(f_in.read())
                        try:
                            os.remove(cand)
                        except Exception:
                            pass
                        break
                except Exception:
                    pass

        if not os.path.exists(output_file) or os.path.getsize(output_file) == 0:
            raise RuntimeError("Generated script did not produce an output image/animation.")

        with open(output_file, "rb") as f:
            raw_bytes = f.read()

        return GeneratedBytes(raw_bytes, script=code)
