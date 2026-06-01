import asyncio
import struct
from bleak import BleakClient

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

    def test_0x32_checkered(self):
        width, height = 64, 20
        data = bytearray()
        for y in range(height):
            for x in range(0, width, 8):
                # Checkered pattern
                data.append(0xAA if (y % 2 == 0) else 0x55)
        
        inner_payload = bytearray([0x00, 0, 0, width, height, 0x01, 0x00]) + data
        return self.build_packet(bytes([0x32]) + encode_var_len(len(inner_payload)) + inner_payload)

async def run_test():
    tester = ProtocolTester()
    print(f"Connecting to {ADDRESS}...")
    try:
        async with BleakClient(ADDRESS, timeout=10.0) as client:
            print("Connected!")
            
            print("Sending 0x32 Checkered Pattern...")
            pkt = tester.test_0x32_checkered()
            for i in range(0, len(pkt), 20):
                await client.write_gatt_char(WRITE_UUID, pkt[i:i+20], response=False)
                await asyncio.sleep(0.05) # Increased delay to 50ms!
                
            print("Done! Disconnecting...")
    except Exception as e:
        print(f"Failed: {e}")

if __name__ == "__main__":
    asyncio.run(run_test())
