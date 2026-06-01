import asyncio
import struct
from bleak import BleakClient
from PIL import Image, ImageDraw, ImageFont

ADDRESS = "FF:24:10:29:44:9B"
WRITE_UUID = "0000FFF2-0000-1000-8000-00805F9B34FB"

def encode_var_len(val: int) -> bytes:
    if val < 128: return bytes([val])
    elif val < 16384: return bytes([val % 128 | 128, val // 128])
    return bytes([val % 128 | 128, (val // 128) % 128 | 128, val // 16384])

class ProtocolTester:
    def __init__(self):
        self._sno = 1
        
    def build_packet(self, payload, cmd_type=0xC1, sub_type=0x01):
        pkt_len = len(payload) + 6
        header = struct.pack("<HHHHBB", 0x55AA, 0xFFFF, pkt_len, self._sno, cmd_type, sub_type)
        self._sno += 1
        packet_without_cs = header + payload
        checksum = sum(packet_without_cs) & 0xFFFF
        return packet_without_cs + struct.pack("<H", checksum)

    def text_bitmap(self, text):
        font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 18)
        img = Image.new("1", (255, 20), 0)
        draw = ImageDraw.Draw(img)
        draw.text((0, -2), text, font=font, fill=1)
        
        # crop to 64px for simplicity
        img = img.crop((0, 0, 64, 20))
        pixels = list(img.getdata())
        bitmap = [1 if p > 0 else 0 for p in pixels]
        
        data = bytearray()
        width, height = 64, 20
        for row in range(height):
            byte = 0
            bit_pos = 7
            for col in range(width):
                if bitmap[row * width + col]:
                    byte |= (1 << bit_pos)
                bit_pos -= 1
                if bit_pos < 0:
                    data.append(byte)
                    byte = 0
                    bit_pos = 7
            if bit_pos < 7:
                data.append(byte)
                
        inner_payload = bytearray([0x00, 0, 0, width, height, 0x01, 0x00]) + data
        return self.build_packet(bytes([0x32]) + encode_var_len(len(inner_payload)) + inner_payload)

async def run_test():
    tester = ProtocolTester()
    print(f"Connecting to {ADDRESS}...")
    try:
        async with BleakClient(ADDRESS, timeout=10.0) as client:
            print("Connected!")
            
            start_pkt = tester.build_packet(bytes([0x31, 0x01, 0x00]))
            await client.write_gatt_char(WRITE_UUID, start_pkt, response=True)
            await asyncio.sleep(0.1)

            clear_pkt = tester.build_packet(bytes([0x05, 0x01, 0x00]))
            await client.write_gatt_char(WRITE_UUID, clear_pkt, response=True)
            await asyncio.sleep(0.5)
            
            print("Sending First Text: HELLO")
            pkt1 = tester.text_bitmap("HELLO")
            for i in range(0, len(pkt1), 20):
                await client.write_gatt_char(WRITE_UUID, pkt1[i:i+20], response=False)
                await asyncio.sleep(0.02)
                
            print("Sending Second Text: WORLD")
            pkt2 = tester.text_bitmap("WORLD")
            for i in range(0, len(pkt2), 20):
                await client.write_gatt_char(WRITE_UUID, pkt2[i:i+20], response=False)
                await asyncio.sleep(0.02)
                
            end_pkt = tester.build_packet(bytes([0x33, 0x01, 0x00]))
            await client.write_gatt_char(WRITE_UUID, end_pkt, response=True)
            await asyncio.sleep(0.5)

            print("Done! Disconnecting...")
    except Exception as e:
        print(f"Failed: {e}")

if __name__ == "__main__":
    asyncio.run(run_test())
