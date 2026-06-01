import struct
from typing import List

# Removed hallucinated encode_var_len

class LOYBitmap:
    @staticmethod
    def pack_1bit(bitmap: List[int], x0: int, y0: int, x1: int, y1: int, width: int, height: int, color: str, animation: int = 1, speed: int = 0) -> bytes:
        """
        Packs a 1-bit bitmap into the LOY protocol format (Command 50).
        """
        data = bytearray()
        for row in range(height):
            byte = 0
            bit_pos = 7 # MSB First (standard)
            for col in range(width):
                bit = bitmap[row * width + col]
                if bit:
                    byte |= (1 << bit_pos)
                bit_pos -= 1
                if bit_pos < 0:
                    data.append(byte)
                    byte = 0
                    bit_pos = 7
            if bit_pos < 7:
                data.append(byte)
        
        color = color.lstrip('#')
        if len(color) != 6: color = "ffffff"
        r = int(color[0:2], 16)
        g = int(color[2:4], 16)
        b = int(color[4:6], 16)

        inner_payload = bytearray([0x00, x0, y0, (x1-x0+1), (y1-y0+1), animation, speed])
        inner_payload += data
        
        cmd_id = 0x32 # 50
        len_bytes = struct.pack("<H", len(inner_payload))
        
        return bytes([cmd_id]) + len_bytes + inner_payload

# Update LOYProtocol to include bitmap sending
from loy_protocol import LOYProtocol as BaseProtocol

class LOYWebProtocol(BaseProtocol):
    def bitmap_command(self, bitmap: List[int], width: int, height: int, x0: int = 0, y0: int = 0, color: str = "#ffffff"):
        """Command 50 (0x32): Standard bitmap (Type 0)."""
        color = color.lstrip('#')
        if len(color) != 6: color = "ffffff"
        r = int(color[0:2], 16)
        g = int(color[2:4], 16)
        b = int(color[4:6], 16)

        x1 = x0 + width - 1
        y1 = y0 + height - 1

        # Convert 1-bit list to bytes (MSB first)
        data = bytearray()
        for row in range(height):
            for col_byte in range(0, width, 8):
                byte = 0
                for bit in range(8):
                    if col_byte + bit < width:
                        if bitmap[row * width + col_byte + bit]:
                            byte |= (1 << (7 - bit))
                data.append(byte)

        # Structure: [0x00 (Type 0), R, G, B, x0_le, y0_le, x1_le, y1_le] + data
        inner_payload = bytearray([0x00, r, g, b])
        inner_payload += struct.pack("<HHHH", x0, y0, x1, y1)
        inner_payload += data
        
        payload = bytes([0x32, len(inner_payload)]) + inner_payload
        return self.build_packet(payload, cmd_type=0xC1, sub_type=0x02)

    def hardware_scroll_command(self, bitmap: List[int], width: int, height: int, color: str = "#ffffff", speed: int = 5, animation: int = 1):
        """Command 50 (0x32): Hardware scrolling bitmap (Type 2)."""
        color = color.lstrip('#')
        if len(color) != 6: color = "ffffff"
        r = int(color[0:2], 16)
        g = int(color[2:4], 16)
        b = int(color[4:6], 16)

        # Pad width to a multiple of 8
        padded_width = (width + 7) // 8 * 8
        x0 = 0
        y0 = 0
        x1 = padded_width - 1
        y1 = height - 1

        # Convert 1-bit list to bytes (MSB first), handling padding
        data = bytearray()
        for row in range(height):
            for col_byte in range(0, padded_width, 8):
                byte = 0
                for bit in range(8):
                    px = col_byte + bit
                    if px < width:
                        if bitmap[row * width + px]:
                            byte |= (1 << (7 - bit))
                data.append(byte)

        # Structure: [0x02 (Type 2), x0, y0, width, height, animation, speed] + data
        # No RGB color bytes, and coordinates/dimensions are packed as single bytes instead of 2-byte little-endian shorts
        width_byte = min(255, padded_width)
        height_byte = min(255, height)
        inner_payload = bytearray([0x02, x0, y0, width_byte, height_byte, animation, speed])
        inner_payload += data
        
        # Length packed as 2-byte little endian unsigned short
        len_bytes = struct.pack("<H", len(inner_payload))
        payload = bytes([0x32]) + len_bytes + inner_payload
        return self.build_packet(payload, cmd_type=0xC1, sub_type=0x02)


    def text_bitmap_command(self, text: str, color: str = "#ffffff"):
        """Renders text to a 64x20 bitmap and returns the 0x32 command."""
        from PIL import Image, ImageDraw, ImageFont
        width, height = 64, 20
        img = Image.new('1', (width, height), 0)
        draw = ImageDraw.Draw(img)
        
        try:
            font = ImageFont.truetype("arial.ttf", 16)
        except:
            font = ImageFont.load_default()
            
        bbox = draw.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
        x = (width - tw) // 2
        y = (height - th) // 2 - bbox[1]
        draw.text((x, y), text, font=font, fill=1)
        
        pixels = list(img.getdata())
        bitmap = [1 if p > 0 else 0 for p in pixels]
        return self.bitmap_command(bitmap, width, height, color=color)

    def delete_preset_command(self, slot_id: int):
        """Command 0x35 SubType 0x03: Delete hardware preset."""
        payload = bytes([0x35, 0x01, slot_id])
        return self.build_packet(payload, cmd_type=0xC1, sub_type=0x03)

    def login_command(self):
        """Command 0x01: Login / Authentication."""
        return self.build_packet(bytes([0x01, 0x01, 0x00]), cmd_type=0xC1, sub_type=0x02)

    def clear_all_command(self):
        """Wipes the screen using a solid black rectangle covering 64x20."""
        import struct
        # 0x32 Type 1 (Rect), Color 0,0,0, RectType 1 (Solid)
        inner_payload = bytearray([0x32, 0x0D, 0x01, 0x00, 0x00, 0x00, 0x01])
        inner_payload += struct.pack("<HHHH", 0, 0, 63, 19)
        return self.build_packet(inner_payload, cmd_type=0xC1, sub_type=0x02)

    def time_command(self, year: int, month: int, day: int, hour: int, minute: int, second: int, dow: int):
        """Command 0x05: Set Device Time."""
        payload = bytes([0x05, 0x09, year - 2000 if year >= 2000 else year, 0x00, month, day, hour, minute, second, 0x74, 0x02])
        return self.build_packet(payload, cmd_type=0xC1, sub_type=0x02)

    def clock_on_command(self):
        """Command 0x33 Type 0 Val 0: Shows the current time."""
        return self.build_packet(bytes([0x33, 0x01, 0x00]), cmd_type=0xC1, sub_type=0x02)

    def clock_off_command(self):
        """Command 0x33 Type 0 Val 1: Disables the clock/time display."""
        return self.build_packet(bytes([0x33, 0x01, 0x01]), cmd_type=0xC1, sub_type=0x02)

    def session_start_command(self):
        """Command 0x31: Start data transmission session."""
        return self.build_packet(bytes([0x31, 0x01, 0x00]), cmd_type=0xC1, sub_type=0x02)

    def session_end_command(self):
        """Command 0x31: End data transmission session / Commit."""
        return self.build_packet(bytes([0x31, 0x01, 0x01]), cmd_type=0xC1, sub_type=0x02)
