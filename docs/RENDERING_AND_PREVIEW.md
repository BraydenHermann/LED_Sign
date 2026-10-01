# Rendering and Preview Architecture

The application provides a hardware-aware 64x20 preview of sign content before it is sent to the device. The application previews all content against the physical 64x20 target. Once media is processed for saving or transmission, saved and live previews can use the processed frame/pixel representation associated with the hardware output. Immediate editor previews may use browser-side rendering before that processing stage.

## Hardware Dimensions
The physical LED sign operates on a strict 64x20 pixel grid (1280 total pixels). All rendering logic is fundamentally built around mapping content onto this resolution.

## Preview Stages

The accuracy of the preview depends on the stage of the workflow:

### A. Editor / Pre-Save Preview
- Immediate browser-side representation while editing content.
- May use browser rendering, HTML Canvas, or CSS approximations.
- Designed to closely represent the 64x20 target result.
- Should not be considered byte-for-byte or frame-for-frame identical to hardware output.

### B. Processed / Saved Preview
- Uses content after it has been fully rendered and processed by the backend.
- Where the same backend-rendered frames and pixels are reused for the hardware payload, this provides the strongest accuracy case.
- Presets generally fall into this category, representing the actual payload bytes.

### C. Live Dashboard Preview
- Generated directly from the backend-rendered data associated with the current sign output.
- Reflects what the backend believes the sign is currently displaying.

## Content Types and Accuracy

### Images, GIFs, and Videos
- **Editor Previews:** When you upload media, the frontend calculates how the image/video maps to a 64x20 coordinate space using browser-side canvas rendering. 
- **Processed Output:** The backend independently uses Pillow/OpenCV to rasterize, scale, and crop the original media into the final RGB matrix suitable for the hardware.
- **Result:** Once saved or pushed, the resulting live preview represents the actual processed frames. Minor timing differences may exist for animations due to Bluetooth transmission or browser playback scheduling, but the visual frame and pixel content is derived directly from the backend payload.

### Static Text
- **Editor Previews:** The frontend uses a WOFF2 version of the unifont pixel font to preview typography natively in the browser.
- **Processed Output:** The backend draws the text using Pillow and the physical OTF font.
- **Result:** The character glyphs and spacing closely match the sign, but browser font rendering introduces differences such as sub-pixel anti-aliasing that can cause the pre-save preview text to look softer than the physical hardware's LED pixels.

### Animated Text (e.g., Left Shift, Snowflake, Marquee)
Text animations are defined and rendered by application logic.
- **Editor Previews:** Animated text previews use a browser-side 64x20 renderer that mirrors the application's backend animation logic.
- **Processed Output:** The backend independently generates the actual frames used for physical output (e.g., via `generate_text_animation_frames`). Saved animated-text presets are built directly from those rendered frames.
- **Result:** The browser provides its own 64x20 simulation of the animation behavior for immediate editing. Because the browser and backend rendering are separate implementations, the preview closely represents the resulting animation, while minor differences in timing, synchronization, or font rasterization may occur. Once backend-rendered preview content is generated (Saved/Live), it more directly represents the content being sent to the sign.
