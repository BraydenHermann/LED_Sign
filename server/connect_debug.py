import asyncio
import traceback
from bleak import BleakClient

async def main():
    address = "FF:24:10:29:44:9B"
    print(f"Attempting to connect to {address}...")
    client = BleakClient(address)
    try:
        await asyncio.wait_for(client.connect(), timeout=20.0)
        print("Successfully connected!")
        await client.disconnect()
    except Exception as e:
        print("Connection failed!")
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(main())
