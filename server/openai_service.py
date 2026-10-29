"""
OpenAI / ChatGPT AI Media Service for LED Sign.
Generates pixel art images and animated GIFs optimized for 64x20 RGB LED matrices
using OpenAI models (e.g., gpt-4o-mini, gpt-4o) and Pillow script execution.
"""

from __future__ import annotations
import os
import io
import json
import base64
import time
from typing import Optional, List, Dict, Any, Tuple
import requests

try:
    from PIL import Image
except ImportError:
    Image = None

from gemini_service import (
    PANEL_W,
    PANEL_H,
    MAX_FRAMES,
    DEFAULT_DURATION_SEC,
    DEFAULT_FPS,
    OPTIMAL_GIF_FRAMES,
    OPTIMAL_FRAME_DURATION_MS,
    SYSTEM_CONSTRAINTS,
    load_env,
    _execute_pillow_script,
    convert_image_to_matrix_pixels,
    convert_gif_to_matrix_pixels
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OPENAI_MODEL = "gpt-4o"
FALLBACK_OPENAI_MODELS = ["gpt-4o", "gpt-4o-mini"]
DEFAULT_BASE_URL = "https://api.openai.com/v1"


class OpenAICallError(RuntimeError):
    """Custom exception containing HTTP status and OpenAI error code."""
    def __init__(self, message: str, status_code: int = 500, code: str = ""):
        super().__init__(message)
        self.status_code = status_code
        self.code = code


def load_config() -> Dict[str, Any]:
    """Load OpenAI configuration from environment variables."""
    load_env()
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    model = os.getenv("OPENAI_MODEL", DEFAULT_OPENAI_MODEL).strip() or DEFAULT_OPENAI_MODEL
    base_url = (os.getenv("OPENAI_BASE_URL", DEFAULT_BASE_URL).strip() or DEFAULT_BASE_URL).rstrip("/")
    return {
        "api_key": api_key,
        "model": model,
        "base_url": base_url,
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


def check_status() -> Dict[str, Any]:
    """Returns OpenAI readiness status for UI display."""
    cfg = load_config()
    key = cfg["api_key"]
    masked = f"{key[:6]}...{key[-4:]}" if len(key) >= 12 else ("Set" if key else "")
    return {
        "configured": bool(key),
        "masked_key": masked,
        "model": cfg["model"],
        "base_url": cfg["base_url"],
        "hardware_limits": cfg["hardware_limits"]
    }


def _call_openai_chat(
    messages: List[Dict[str, Any]],
    model: str,
    api_key: str,
    base_url: str = DEFAULT_BASE_URL,
    temperature: float = 0.4,
    timeout: int = 50
) -> str:
    """Invokes OpenAI Chat Completions endpoint and extracts assistant reply content."""
    url = f"{base_url}/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature
    }

    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=timeout)
    except requests.RequestException as e:
        raise OpenAICallError(f"Network error connecting to OpenAI: {e}", status_code=503)

    if resp.status_code != 200:
        error_msg = f"OpenAI error (HTTP {resp.status_code})"
        code = ""
        try:
            err_json = resp.json().get("error", {})
            msg = err_json.get("message", "")
            code = err_json.get("code", "")
            err_type = err_json.get("type", "")

            if resp.status_code == 429 or code == "credit_balance_exhausted" or "credit" in msg.lower() or "quota" in msg.lower():
                error_msg = (
                    "OpenAI error: You have no API credits or quota remaining on your OpenAI account. "
                    "OpenAI requires prepaid credits (minimum $5) to use the API: visit https://platform.openai.com/settings/organization/billing to add balance."
                )
            elif resp.status_code == 401:
                error_msg = "Invalid OpenAI API key. Please check OPENAI_API_KEY in your .env file."
            elif msg:
                error_msg = f"OpenAI error: {msg}"
        except Exception:
            error_msg = f"OpenAI HTTP {resp.status_code}: {resp.text[:200]}"
            
        raise OpenAICallError(error_msg, status_code=resp.status_code, code=code)

    data = resp.json()
    choices = data.get("choices", [])
    if not choices or "message" not in choices[0]:
        raise OpenAICallError("OpenAI returned an empty response.", status_code=502)

    content = choices[0]["message"].get("content", "")
    if not content:
        raise OpenAICallError("OpenAI returned no text content.", status_code=502)

    return content


def generate_animated_gif(
    prompt: str,
    attachments: Optional[List[Dict[str, str]]] = None,
    api_key: Optional[str] = None,
    history: Optional[List[str]] = None,
    model: Optional[str] = None,
    previous_script: Optional[str] = None
) -> Dict[str, Any]:
    """Generates an animated GIF adhering to 64x20 resolution using ChatGPT / OpenAI."""
    if Image is None:
        raise RuntimeError("Pillow is not installed.")

    cfg = load_config()
    key = api_key or cfg["api_key"]
    if not key:
        raise RuntimeError("OpenAI API key not configured. Set OPENAI_API_KEY in .env or pass apiKey in request.")

    base_url = cfg["base_url"]
    chosen_model = model or cfg.get("model", DEFAULT_OPENAI_MODEL)
    models_to_try = [chosen_model]
    for alt in FALLBACK_OPENAI_MODELS:
        if alt not in models_to_try:
            models_to_try.append(alt)

    has_attachments = bool(attachments and len(attachments) > 0)
    ref_guidance = ""
    if has_attachments:
        ref_guidance = f"""
- REFERENCE CONTEXT: The attached image/media represents the current 64x20 LED sign canvas or reference context. Use this reference to guide your adjustments matching the user's prompt: "{prompt}". Preserve the layout, character styling, or color identity where helpful, but feel free to modify, polish, or redesign elements if that will help the result look significantly better.
"""

    history_guidance = ""
    if history:
        clean_history = [h.strip() for h in history if h and h.strip()]
        if clean_history:
            history_text = "\n".join(f"- \"{h}\"" for h in clean_history[-5:])
            history_guidance = f"""
- PREVIOUS CONVERSATION / PROMPT HISTORY:
The user previously requested:
{history_text}
This current request ("{prompt}") is a follow-up or refinement in this ongoing conversation. Incorporate context from the previous requests while addressing the latest prompt.
"""

    followup_guidance = ""
    if previous_script and previous_script.strip():
        followup_guidance = f"""
=============================================================================
FOLLOW-UP EDIT / REFINEMENT MODE:
The user is asking to modify or refine an existing, working Python Pillow script from earlier in this conversation:
Latest user instruction: "{prompt}"

EXISTING SCRIPT:
```python
{previous_script.strip()}
```

REFINEMENT RULES:
1. Do NOT rewrite the animation from scratch. Modify the existing script to incorporate the user's requested changes.
2. Preserve existing animation timing, frame count, coordinate math, and styling unless the user explicitly requested to change them.
3. If the user asks to capitalize words (e.g. "make each word capitalized"), update the text strings / capitalization in the existing script (e.g. "TURN OFF", "HIGH BEAM").
4. If the user asks to "turn off the high beam" or remove an effect, disable or remove the flashing beam rays or graphic as requested.
5. Strictly obey hardware constraints: exactly 1 horizontal line of text (never stack 2 lines vertically), minimum 12-16px font size, no top/bottom borders that squeeze text.
6. Return the COMPLETE, updated executable Python script inside ```python ... ```.
=============================================================================
"""

    instruction = f"""{SYSTEM_CONSTRAINTS}

Generate a complete, self-contained Python script using PIL (Pillow) and math/random that renders a pixel-perfect animated GIF of 64x20 pixels matching: "{prompt}".{history_guidance}{ref_guidance}{followup_guidance}

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
"""

    user_content: List[Dict[str, Any]] = [{"type": "text", "text": instruction}]
    if attachments:
        for att in attachments:
            data = att.get("data", "")
            if data:
                if not data.startswith("data:"):
                    mime = att.get("mimeType", "image/png")
                    data = f"data:{mime};base64,{data}"
                user_content.append({
                    "type": "image_url",
                    "image_url": {
                        "url": data,
                        "detail": "low"
                    }
                })

    messages: List[Dict[str, Any]] = [
        {"role": "system", "content": "You are a Python Pillow graphics developer creating 64x20 animated pixel art assets."}
    ]
    if history:
        clean_history = [h.strip() for h in history if h and h.strip()]
        for prev_p in clean_history[-5:]:
            messages.append({"role": "user", "content": f"Generate 64x20 animation: {prev_p}"})
            messages.append({"role": "assistant", "content": f"```python\n# Animation code generated for: {prev_p}\n```"})
    messages.append({"role": "user", "content": user_content})

    reply_text = None
    last_err = None
    for model_name in models_to_try:
        try:
            reply_text = _call_openai_chat(messages, model=model_name, api_key=key, base_url=base_url)
            if reply_text:
                break
        except OpenAICallError as e:
            # Don't try other models if the account has no credits, invalid key, or invalid payload
            if e.status_code in (400, 401, 403, 429) or e.code == "credit_balance_exhausted":
                raise e
            last_err = e
            print(f"[OpenAIService] Model '{model_name}' failed: {e}. Trying fallback...")
            continue
        except Exception as e:
            last_err = e
            print(f"[OpenAIService] Model '{model_name}' failed: {e}. Trying fallback...")
            continue

    if not reply_text:
        raise last_err or RuntimeError("OpenAI failed to generate script.")

    gif_bytes = _execute_pillow_script(reply_text, output_type="gif")
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
        "suggestedName": f"ChatGPT GIF: {prompt[:24].strip()}",
        "script": getattr(gif_bytes, "script", reply_text)
    }


def generate_still_image(
    prompt: str,
    attachments: Optional[List[Dict[str, str]]] = None,
    api_key: Optional[str] = None,
    history: Optional[List[str]] = None,
    model: Optional[str] = None,
    previous_script: Optional[str] = None
) -> Dict[str, Any]:
    """Generates a still 64x20 pixel-art image using ChatGPT / OpenAI."""
    if Image is None:
        raise RuntimeError("Pillow is not installed.")

    cfg = load_config()
    key = api_key or cfg["api_key"]
    if not key:
        raise RuntimeError("OpenAI API key not configured. Set OPENAI_API_KEY in .env or pass apiKey in request.")

    base_url = cfg["base_url"]
    chosen_model = model or cfg.get("model", DEFAULT_OPENAI_MODEL)
    models_to_try = [chosen_model]
    for alt in FALLBACK_OPENAI_MODELS:
        if alt not in models_to_try:
            models_to_try.append(alt)

    has_attachments = bool(attachments and len(attachments) > 0)
    ref_guidance = ""
    if has_attachments:
        ref_guidance = f"""
- REFERENCE CONTEXT: The attached image/media represents the current 64x20 LED sign canvas or reference context. Use this reference to guide your adjustments matching the user's prompt: "{prompt}". Preserve the layout, character styling, or color identity where helpful, but feel free to modify, polish, or redesign elements if that will help the result look significantly better.
"""

    history_guidance = ""
    if history:
        clean_history = [h.strip() for h in history if h and h.strip()]
        if clean_history:
            history_text = "\n".join(f"- \"{h}\"" for h in clean_history[-5:])
            history_guidance = f"""
- PREVIOUS CONVERSATION / PROMPT HISTORY:
The user previously requested:
{history_text}
This current request ("{prompt}") is a follow-up or refinement in this ongoing conversation. Incorporate context from the previous requests while addressing the latest prompt.
"""

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

    instruction = f"""{SYSTEM_CONSTRAINTS}

Generate a complete, self-contained Python script using PIL (Pillow) and math/random that renders a single pixel-perfect 64x20 image matching: "{prompt}".{history_guidance}{ref_guidance}{followup_guidance}

CRITICAL RULES:
- Image resolution: EXACTLY width=64, height=20.
- Background: pure solid black (0, 0, 0).
- Pixel Art / Aesthetics: Vibrant neon, bold retro pixel art, high contrast.
- In PIL (Pillow), use `draw.point((x, y), fill=...)` or `image.putpixel((x, y), (r, g, b))` for individual pixels (ImageDraw does not natively have .pixel(), use .point()).
- Output: Save the PNG directly to the filename specified in variable `OUTPUT_PATH`.
  Example: img.save(OUTPUT_PATH)
- Return ONLY the Python code block wrapped in ```python ... ```.
"""

    user_content: List[Dict[str, Any]] = [{"type": "text", "text": instruction}]
    if attachments:
        for att in attachments:
            data = att.get("data", "")
            if data:
                if not data.startswith("data:"):
                    mime = att.get("mimeType", "image/png")
                    data = f"data:{mime};base64,{data}"
                user_content.append({
                    "type": "image_url",
                    "image_url": {
                        "url": data,
                        "detail": "low"
                    }
                })

    messages: List[Dict[str, Any]] = [
        {"role": "system", "content": "You are a Python Pillow graphics developer creating 64x20 pixel art assets."}
    ]
    if history:
        clean_history = [h.strip() for h in history if h and h.strip()]
        for prev_p in clean_history[-5:]:
            messages.append({"role": "user", "content": f"Generate 64x20 image: {prev_p}"})
            messages.append({"role": "assistant", "content": f"```python\n# Image code generated for: {prev_p}\n```"})
    messages.append({"role": "user", "content": user_content})

    reply_text = None
    last_err = None
    for model_name in models_to_try:
        try:
            reply_text = _call_openai_chat(messages, model=model_name, api_key=key, base_url=base_url)
            if reply_text:
                break
        except OpenAICallError as e:
            if e.status_code in (400, 401, 403, 429) or e.code == "credit_balance_exhausted":
                raise e
            last_err = e
            print(f"[OpenAIService] Model '{model_name}' failed: {e}. Trying fallback...")
            continue
        except Exception as e:
            last_err = e
            print(f"[OpenAIService] Model '{model_name}' failed: {e}. Trying fallback...")
            continue

    if not reply_text:
        raise last_err or RuntimeError("OpenAI failed to generate script.")

    img_bytes = _execute_pillow_script(reply_text, output_type="png")
    pil_img = Image.open(io.BytesIO(img_bytes))
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
        "suggestedName": f"ChatGPT: {prompt[:24].strip()}",
        "script": getattr(img_bytes, "script", reply_text)
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
    gif_result["suggestedName"] = f"ChatGPT Video: {prompt[:24].strip()}"
    return gif_result
    return gif_result
