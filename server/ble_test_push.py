import asyncio
import struct
from bleak import BleakClient

# MAC Address from user's logs
ADDRESS = "FF:24:10:29:44:9B"
WRITE_UUID = "0000FFF2-0000-1000-8000-00805F9B34FB"

def encode_var_len(val: int) -> bytes:
    if val < 128:
        return bytes([val])
    elif val < 16384:
        return bytes([val % 128 | 128, val // 128])
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

    def test_0x32_static(self):
        # 64x20 full white screen (1 bit per pixel)
        width, height = 64, 20
        data = bytearray([0xFF] * ((width * height) // 8))
        inner_payload = bytearray([0x00, 0, 0, width, height, 0x01, 0x00]) + data
        return self.build_packet(bytes([0x32]) + encode_var_len(len(inner_payload)) + inner_payload)

    def test_0x1E_dynamic(self):
        width, height = 64, 20
        data = bytearray([0xFF] * ((width * height) // 8))
        header = bytes([0x01, 0x00, 0x00, 0x00, 0x00, width, height, 1, 5]) + struct.pack("<H", len(data))
        payload = bytes([0x1E]) + encode_var_len(len(header) + len(data)) + header + data
        return self.build_packet(payload)

    def test_0x1E_dynamic_rgb(self):
        width, height = 64, 20
        data = bytearray([0xFF] * ((width * height) // 8))
        # Add RGB bytes
        header = bytes([0x01, 255, 0, 0, 0x00, width, height, 1, 5]) + struct.pack("<H", len(data))
        payload = bytes([0x1E]) + encode_var_len(len(header) + len(data)) + header + data
        return self.build_packet(payload)

async def run_test():
    tester = ProtocolTester()
    
    print(f"Connecting to {ADDRESS}...")
    try:
        async with BleakClient(ADDRESS, timeout=10.0) as client:
            print("Connected! Clearing screen...")
            clear_pkt = tester.build_packet(bytes([0x05, 0x01, 0x00]))
            await client.write_gatt_char(WRITE_UUID, clear_pkt, response=True)
            await asyncio.sleep(0.5)

            print("1. Sending 0x32 (Static Bitmap)...")
            pkt = tester.test_0x32_static()
            for i in range(0, len(pkt), 20):
                await client.write_gatt_char(WRITE_UUID, pkt[i:i+20], response=False)
                await asyncio.sleep(0.01)
            
            print("Wait 3 seconds...")
            await asyncio.sleep(3)

            print("2. Sending 0x1E (Dynamic) without RGB...")
            await client.write_gatt_char(WRITE_UUID, clear_pkt, response=True)
            await asyncio.sleep(0.5)
            pkt = tester.test_0x1E_dynamic()
            for i in range(0, len(pkt), 20):
                await client.write_gatt_char(WRITE_UUID, pkt[i:i+20], response=False)
                await asyncio.sleep(0.01)
                
            print("Wait 3 seconds...")
            await asyncio.sleep(3)
            
            print("3. Sending 0x1E (Dynamic) with RED RGB...")
            await client.write_gatt_char(WRITE_UUID, clear_pkt, response=True)
            await asyncio.sleep(0.5)
            pkt = tester.test_0x1E_dynamic_rgb()
            for i in range(0, len(pkt), 20):
                await client.write_gatt_char(WRITE_UUID, pkt[i:i+20], response=False)
                await asyncio.sleep(0.01)
                
            print("Tests complete!")
    except Exception as e:
        print(f"Failed: {e}")

if __name__ == "__main__":
    asyncio.run(run_test())
