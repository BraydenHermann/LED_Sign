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

def build_tlv(tag: int, value: bytes) -> bytes:
    """Build a Type-Length-Value encoded chunk for the file transfer protocol."""
    if len(value) < 128:
        l_bytes = bytes([len(value)])
    elif len(value) < 256:
        l_bytes = bytes([129, len(value)])
    else:
        l_bytes = bytes([130, len(value) & 0xFF, (len(value) >> 8) & 0xFF])
    return bytes([tag]) + l_bytes + value

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
        
        payload = build_tlv(0x32, inner_payload)
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

    def generate_ystp(self, width: int = 64, height: int = 20, mode: int = 1, speed: int = 50, pixels: List[str] = None):
        """Generates a valid YSTP01 preset file (Mode 1 RGB24).
        Header format (15 bytes for mode 1 RGB24):
          - 'YSTP01' (6 bytes)
          - width (uint16 LE, 2 bytes)
          - height (uint16 LE, 2 bytes)
          - mode (uint16 LE = 1, 2 bytes)
          - speed (uint16 LE, 2 bytes)
          - color_depth (uint8, 1 byte = 24 / 0x18 for RGB888)
          followed by width * height * 3 raw RGB bytes.
        """
        header = b'YSTP01'
        header += struct.pack('<HHHHB', width, height, mode, speed, 24)
        
        data = bytearray()
        if pixels:
            for p in pixels:
                if p is None or p == 0 or p == "0" or p == "#000000" or p is False:
                    data.extend([0, 0, 0])
                elif isinstance(p, str) and p.startswith("#"):
                    color = p.lstrip('#')
                    if len(color) != 6: 
                        data.extend([0, 0, 0])
                    else:
                        r = int(color[0:2], 16)
                        g = int(color[2:4], 16)
                        b = int(color[4:6], 16)
                        data.extend([r, g, b])
                else:
                    data.extend([255, 255, 255])
        
        return header + data

    def generate_ystp_mode2(self, width: int = 64, height: int = 20, speed: int = 48, fg_color: str = "#ffffff", bg_color: str = "#000000", bitmap: List[int] = None, animation: int = 0):
        """Generates a Mode 2 (1-bit bitmap with FG/BG colors) YSTP01 file for hardware flash slots.
        Matches official iOS app trace (Occurrence [7] in latest2.pklg).
        Header layout (29 bytes):
          bytes  0-5:  'YSTP01'
          bytes  6-7:  width uint16 LE
          bytes  8-9:  height uint16 LE
          bytes 10-11: mode uint16 LE = 2
          bytes 12-13: speed uint16 LE
          bytes 14-15: animation uint16 LE (0=static, 1=move-left, 2=move-right, etc.)
          bytes 16-17: reserved uint16 LE = 0
          bytes 18-20: fg_r, fg_g, fg_b
          bytes 21-23: bg_r, bg_g, bg_b
          bytes 24-28: reserved (5 zero bytes)
        """
        header = bytearray(b'YSTP01')
        header += struct.pack('<HHHHHH', width, height, 2, speed, animation, 0)
        
        def hex_to_rgb(h):
            if not h: return (255, 255, 255)
            h = h.lstrip('#')
            if len(h) != 6: return (255, 255, 255)
            return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
            
        fg_r, fg_g, fg_b = hex_to_rgb(fg_color)
        bg_r, bg_g, bg_b = hex_to_rgb(bg_color)
        header += bytes([fg_r, fg_g, fg_b, bg_r, bg_g, bg_b, 0, 0, 0, 0, 0])
        
        bitmap_bytes = bytearray()
        if bitmap is None:
            bitmap = [0] * (width * height)
            
        for r in range(height):
            row_bits = bitmap[r*width : (r+1)*width]
            for b_idx in range(0, width, 8):
                byte_val = 0
                for bit_pos in range(8):
                    if b_idx + bit_pos < len(row_bits) and row_bits[b_idx + bit_pos]:
                        byte_val |= (1 << bit_pos)
                bitmap_bytes.append(byte_val)
                
        return bytes(header + bitmap_bytes)

    # -----------------------------------------------------------------------
    # File Transfer Protocol (reverse-engineered from real app HCI trace)
    # 
    # Real sequence:
    #   1. build_file_transfer_session_init()  -- CMD=0x08, establishes write session for slot 0xC5
    #   2. build_file_header(file_index=0)     -- CMD=0x09, starts GIF file (T:01 tags!)
    #   3. build_file_transfer_chunk(...)      -- CMD=0x09, GIF chunks
    #   4. build_file_header(file_index=1)     -- CMD=0x09, starts YSTP file
    #   5. build_file_transfer_chunk(...)      -- CMD=0x09, YSTP chunks (multiple)
    #   (repeat for more file indices if needed)
    #   6. build_file_transfer_complete()      -- CMD=0x35 sub=0x02, commits slot 0xC5
    #   7. build_playlist_update(user_slot)    -- CMD=0x35 sub=0x03, maps slot to hardware address
    #   8. build_play_preset_command(hw_addr)  -- CMD=0x36, plays the slot
    #
    # WRITE_SLOT = 0xC5 is a fixed hardware write buffer (not a user-visible slot).
    # User slots 0-11 map to hardware addresses 0x24-0x2F (36-47).
    # -----------------------------------------------------------------------

    WRITE_SLOT = 0xC5  # Fixed hardware write-buffer slot, used for ALL file transfers

    def build_file_transfer_session_init(self, hw_addr: int, num_files: int = 2):
        """CMD=0x08: Open a file-transfer session targeting the hardware slot directly."""
        payload = bytearray()
        payload += build_tlv(0x08, bytes([0x00, hw_addr])) # T:08
        payload += build_tlv(0x09, bytes([0x01]))                     # T:09
        payload += build_tlv(0x0C, bytes([hw_addr]))                  # T:0C
        
        # T:1C seems to be global config (00 00 01 00 03 00 for flash, 00 02 03 00 for C5?)
        # Let's use the flash one from the official trace if targeting flash
        t1c_val = bytes.fromhex("000001000300") if hw_addr != 0xC5 else bytes.fromhex("00020300")
        payload += build_tlv(0x1C, t1c_val)
        
        for file_index in range(num_files):
            payload += build_tlv(0x0D, bytes([file_index])) # T:0D
            # T:1D is size metadata: 00 00 00 00 (size?) + 40 00 (64) + 14 00 (20) + file_index
            t1d_val = bytes([0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 0x14, 0x00, file_index])
            payload += build_tlv(0x1D, t1d_val)
            
        return self.build_packet(bytes(payload), cmd_type=0xC1, sub_type=0x02)

    def build_file_header(self, hw_addr: int, file_index: int, total_chunks: int = 1):
        """CMD=0x09 File Header: Initialize a specific file before its chunks."""
        payload = bytearray()
        payload += build_tlv(0x09, bytes([0x01]))              # T:09 L:01 V:01 (version)
        payload += build_tlv(0x0C, bytes([hw_addr]))           # T:0C L:01 V:hw_addr
        payload += build_tlv(0x0D, bytes([0x00]))              # T:0D L:01 V:00 (file_set)
        payload += build_tlv(0x0E, bytes([file_index]))        # T:0E L:01 V:[idx]
        
        # T:14 L:03 flags
        # For 0xC5 volatile live preview: 0x01, 0x0D, 0x03
        # For 0x24+ flash permanent memory: 0x00, 0x0C, 0x03
        flags = bytes([0x00, 0x0C, 0x03]) if hw_addr != 0xC5 else bytes([0x01, 0x0D, 0x03])
        payload += build_tlv(0x14, flags)
        
        payload += build_tlv(0x11, bytes([0x00, 0x01, 0x00, 0x0A]))  # T:11 L:04
        return self.build_packet(bytes(payload), cmd_type=0xC1, sub_type=0x02)

    def build_file_transfer_chunk(self, hw_addr: int, file_index: int, chunk_index: int, total_chunks: int, data: bytes, chunk_size: int = 960):
        """CMD=0x09 Chunk: Send a chunk of file data."""
        payload = bytearray()
        payload += build_tlv(0x09, bytes([0x01]))              # T:09 L:01 V:01 (version)
        payload += build_tlv(0x0C, bytes([hw_addr]))           # T:0C L:01 V:hw_addr
        payload += build_tlv(0x0D, bytes([0x00]))              # T:0D L:01 V:00 (file_set)
        payload += build_tlv(0x0E, bytes([file_index]))        # T:0E L:01 V:[idx]
        t12 = struct.pack("<H", total_chunks) + struct.pack("<H", chunk_index) + struct.pack("<H", chunk_size) + bytes([0x00])
        payload += build_tlv(0x12, t12)                        # T:12 chunk metadata
        payload += build_tlv(0x13, data)                       # T:13 chunk data
        return self.build_packet(bytes(payload), cmd_type=0xC1, sub_type=0x02)

    def build_file_transfer_complete(self, hw_addr: int, num_frames: int = 1, is_static: bool = False):
        """CMD=0x35 sub=0x02: Commit the file transfer from write buffer (0xC5) to hardware."""
        frame_bytes = (bytes([0x00, 0x00]) if is_static else bytes([0x01, 0x99])) * num_frames
        tail = bytes.fromhex("02025073019800000000")
        val = bytes([hw_addr]) + frame_bytes + tail
        payload = bytes([0x35, len(val)]) + val
        return self.build_packet(payload, cmd_type=0xC1, sub_type=0x02)

    def build_playlist_update(self):
        """CMD=0x35 sub=0x03: Map user slot to hardware addresses after file transfer.
        
        The real app updates the playlist to include the new
        hardware slots in strict numerical order.
        User slots 0-11 map to hardware addresses 0x24-0x2F (36-47).
        """
        all_hw = list(range(0x24, 0x24 + 12))  # [0x24, 0x25, ..., 0x2F]
        
        # Send first 10 slots, then remaining
        first_batch = bytes(all_hw[:10])
        rest_batch = bytes(all_hw[10:])
        
        p1 = bytes([0x35, len(first_batch)]) + first_batch
        p2 = bytes([0x35, len(rest_batch)]) + rest_batch
        pkt1 = self.build_packet(p1, cmd_type=0xC1, sub_type=0x03)
        pkt2 = self.build_packet(p2, cmd_type=0xC1, sub_type=0x03)
        return pkt1, pkt2

    def build_slot_session_init(self, slot_id: int):
        """CMD=0x08: Open file-transfer session targeting slot slot_id (0..11)."""
        payload = bytearray()
        payload += build_tlv(0x08, bytes([0x00, slot_id]))
        payload += build_tlv(0x09, bytes([0x01]))
        payload += build_tlv(0x0C, bytes([slot_id]))
        payload += build_tlv(0x1C, bytes.fromhex('000001000300'))
        payload += build_tlv(0x0D, bytes([0x00]))
        payload += build_tlv(0x1D, bytes.fromhex('000000004000140000'))
        return self.build_packet(bytes(payload), cmd_type=0xC1, sub_type=0x02)

    def build_slot_file_header(self, slot_id: int, anim_code: int = 1, speed_val: int = 13, stay_time: int = 3):
        """CMD=0x09 File Header: Initialize file 0 with animation and speed."""
        payload = bytearray()
        payload += build_tlv(0x09, bytes([0x01]))
        payload += build_tlv(0x0C, bytes([slot_id]))
        payload += build_tlv(0x0D, bytes([0x00]))
        payload += build_tlv(0x0E, bytes([0x00]))
        payload += build_tlv(0x14, bytes([anim_code, speed_val, stay_time]))
        payload += build_tlv(0x11, bytes.fromhex('0001000a'))
        return self.build_packet(bytes(payload), cmd_type=0xC1, sub_type=0x02)

    def build_slot_file_chunk(self, slot_id: int, chunk_idx: int, total_chunks: int, chunk_size: int, chunk_data: bytes):
        """CMD=0x09 File Chunk: Send chunk of file 0."""
        payload = bytearray()
        payload += build_tlv(0x09, bytes([0x01]))
        payload += build_tlv(0x0C, bytes([slot_id]))
        payload += build_tlv(0x0D, bytes([0x00]))
        payload += build_tlv(0x0E, bytes([0x00]))
        t12 = struct.pack('<HHHB', total_chunks, chunk_idx, chunk_size, 0)
        payload += build_tlv(0x12, t12)
        payload += build_tlv(0x13, chunk_data)
        return self.build_packet(bytes(payload), cmd_type=0xC1, sub_type=0x02)

    def build_slot_commit(self, slot_id: int, ystp_bytes: bytes):
        """CMD=0x35: Commit slot file transfer."""
        import hashlib, time
        key = struct.pack('<I', len(ystp_bytes)) + hashlib.md5(ystp_bytes).digest()
        ts = struct.pack('<I', int(time.time()))
        val = bytes([slot_id]) + key + ts
        payload = bytes([0x35, len(val)]) + val
        return self.build_packet(payload, cmd_type=0xC1, sub_type=0x02)

    def build_direct_slot_save_packet(self, slot_id: int, ystp_bytes: bytes, anim_code: int = 1, speed_val: int = 13, stay_time: int = 3):
        """Build the complete compound single-packet file transfer for a hardware slot.
        Matches official iOS app LOY SPACE trace:
          - Session Init (Tag-0x08, Tag-0x09, Tag-0x0C, Tag-0x1C, Tag-0x0D, Tag-0x1D)
          - File Header File 0 (Tag-0x09, Tag-0x0C, Tag-0x0D, Tag-0x0E, Tag-0x14, Tag-0x11)
          - File Chunk File 0 (Tag-0x09, Tag-0x0C, Tag-0x0D, Tag-0x0E, Tag-0x12, Tag-0x13) (YSTP payload)
          - Commit (Tag-0x35 Len-0x19 slot_id key ts)
        """
        import hashlib, time
        payload = bytearray()
        # 1. Session Init
        payload += build_tlv(0x08, bytes([0x00, slot_id]))
        payload += build_tlv(0x09, bytes([0x01]))
        payload += build_tlv(0x0C, bytes([slot_id]))
        payload += build_tlv(0x1C, bytes.fromhex('000001000300'))
        payload += build_tlv(0x0D, bytes([0x00]))
        payload += build_tlv(0x1D, bytes.fromhex('000000004000140000'))
        payload += build_tlv(0x0E, bytes([0x00]))
        
        # 2. File Header File 0
        payload += build_tlv(0x09, bytes([0x01]))
        payload += build_tlv(0x0C, bytes([slot_id]))
        payload += build_tlv(0x0D, bytes([0x00]))
        payload += build_tlv(0x0E, bytes([0x00]))
        payload += build_tlv(0x14, bytes([anim_code, speed_val, stay_time]))
        payload += build_tlv(0x11, bytes.fromhex('0001000a'))
        
        # 3. File Chunk File 0
        payload += build_tlv(0x09, bytes([0x01]))
        payload += build_tlv(0x0C, bytes([slot_id]))
        payload += build_tlv(0x0D, bytes([0x00]))
        payload += build_tlv(0x0E, bytes([0x00]))
        payload += build_tlv(0x12, bytes.fromhex('01000000c00300'))
        payload += build_tlv(0x13, ystp_bytes)

        # 4. Commit Tag 0x35
        key = struct.pack('<I', len(ystp_bytes)) + hashlib.md5(ystp_bytes).digest()
        ts = struct.pack('<I', int(time.time()))
        commit_val = bytes([slot_id]) + key + ts
        payload += build_tlv(0x35, commit_val)
        
        return self.build_packet(bytes(payload), cmd_type=0xC1, sub_type=0x02)

    def build_play_preset_command(self, user_slot: int, loop_mode: int = 0x00):
        """CMD=0x36: Play the slot that was just saved."""
        all_slots = bytes(range(60))
        val = bytes([loop_mode, user_slot]) + all_slots
        payload = bytes([0x36, len(val)]) + val
        return self.build_packet(payload, cmd_type=0xC1, sub_type=0x02)

    def build_slot_select_command(self, slot_id: int):
        """CMD=0xC1 sub=0x06: Legacy slot select command."""
        payload = bytes([0x36, 0x02, 0x00, slot_id])
        return self.build_packet(payload, cmd_type=0xC1, sub_type=0x06)

    def build_user_slot_play_command(self, slot_id: int, loop_mode: int = 0x00):
        """CMD=0xC1 sub=0x02: Select and play a saved slot from flash memory.
        Uses a playlist of length 1 (just the target slot) to enforce single mode.
        If slot_id == 0xFF, it stops the player (used by stop_slot_playback_command).
        """
        val = bytes([loop_mode, 0x00, slot_id])
        payload = bytes([0x36, len(val)]) + val
        return self.build_packet(payload, cmd_type=0xC1, sub_type=0x02)

    def build_query_slots_command(self, start_slot: int = 0, count: int = 10):
        """CMD=0x35 SubType 0x03: Query status of hardware slots."""
        slots = bytes(range(start_slot, start_slot + count))
        payload = bytes([0x35, len(slots)]) + slots
        return self.build_packet(payload, cmd_type=0xC1, sub_type=0x03)

    def build_post_save_packets(self, slot_id: int):
        """Builds the post-save finalization sequence for user flash slots:
        1. Flash session flush/close command for hw_addr (CMD=0xC1 sub=0x02, bytes: 0x08 0x02 0x00 hw_addr)
        2. Direct slot select command (CMD=0xC1 sub=0x06, bytes: 0x36 0x02 0x00 slot_id)
        """
        hw_addr = 0x24 + slot_id
        packets = []
        
        # 1. Session close / flush command for hw_addr
        val_flush = bytes([0x08, 0x02, 0x00, hw_addr])
        packets.append(self.build_packet(val_flush, cmd_type=0xC1, sub_type=0x02))
        
        # 2. Select and lock playback onto slot_id
        packets.append(self.build_slot_select_command(slot_id))
        
        return packets

    # Legacy aliases for backward compatibility (old signature had slot_id as first arg)
    def build_file_transfer_init(self, slot_id: int, files_metadata: list, total_chunks_0: int):
        """DEPRECATED: Use build_file_transfer_session_init() instead."""
        return self.build_file_transfer_session_init(hw_addr=slot_id, num_files=len(files_metadata))

    def stop_playlist_command(self):
        """CMD=0xC1 sub=0x03: Stop onboard playlist engine.
        Exact official trace packet (seq=3): 0x36 0x00 (CMD=0x36, length=0).
        """
        payload = bytes([0x36, 0x00])
        return self.build_packet(payload, cmd_type=0xC1, sub_type=0x03)

    def cancel_playlist_command(self):
        """CMD=0xC1 sub=0x02: Cancel active playlist (Tag 0x27 len=0x00).
        This is the LOY SPACE official 'cancel play_list' command observed in PCAP traces.
        Use before streaming local presets to prevent the sign from reverting to its
        saved hardware slot after the session ends.
        """
        payload = bytes([0x27, 0x00])
        return self.build_packet(payload, cmd_type=0xC1, sub_type=0x02)


