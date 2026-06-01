import asyncio
import struct
from bleak import BleakClient

ADDRESS = "FF:24:10:29:44:9B"
WRITE_UUID = "0000FFF2-0000-1000-8000-00805F9B34FB"

def encode_var_len(val: int) -> bytes:
    if val < 128:
        return bytes([val])
    elif val < 16384:
        return bytes([val % 128 | 128, val // 128])
    return bytes([val % 128 | 128, (val // 128) % 128 | 128, val // 16384])

def build_packet(payload, cmd_type=0xC1, sub_type=0x01):
    pkt_len = len(payload) + 6
    # sno = 1 for test
    header = struct.pack("<HHHHBB", 0x55AA, 0xFFFF, pkt_len, 1, cmd_type, sub_type)
    packet_without_cs = header + payload
    checksum = sum(packet_without_cs) & 0xFFFF
    return packet_without_cs + struct.pack("<H", checksum)

async def run_test():
    try:
        async with BleakClient(ADDRESS, timeout=10.0) as client:
            print("Connected! Sending RGB565 test...")
            
            # 64x20 RGB565
            width, height = 64, 20
            # Let's make half red, half green
            data = bytearray()
            for r in range(height):
                for c in range(width):
                    if c < 32:
                        # Red RGB565 = 0xF800 -> Little endian: 0x00, 0xF8
                        data += bytes([0x00, 0xF8])
                    else:
                        # Green RGB565 = 0x07E0 -> Little endian: 0xE0, 0x07
                        data += bytes([0xE0, 0x07])
            
            # Let's guess the command for RGB. 
            # If 0x32 is bitmap, maybe 0x33 or 0x34?
            # Or maybe 0x32 Type 3?
            
            inner_payload = bytearray([0x03, 0, 0, width, height, 0x01, 0x00]) + data
            payload = bytes([0x32]) + encode_var_len(len(inner_payload)) + inner_payload
            pkt = build_packet(payload)
            
            for i in range(0, len(pkt), 20):
                await client.write_gatt_char(WRITE_UUID, pkt[i:i+20], response=False)
                await asyncio.sleep(0.01)
                
            print("Sent 0x32 Type 3. Wait 3 seconds...")
            await asyncio.sleep(3)
            
            # Try 0x1E Type 2 (RGB565?)
            header = bytes([0x02, 0x00, width, height, 1, 5]) + struct.pack("<H", len(data))
            payload = bytes([0x1E]) + encode_var_len(len(header) + len(data)) + header + data
            pkt = build_packet(payload)
            
            for i in range(0, len(pkt), 20):
                await client.write_gatt_char(WRITE_UUID, pkt[i:i+20], response=False)
                await asyncio.sleep(0.01)
                
            print("Sent 0x1E Type 2. Done.")
            await asyncio.sleep(3)
    except Exception as e:
        print(f"Failed: {e}")

if __name__ == "__main__":
    asyncio.run(run_test())
