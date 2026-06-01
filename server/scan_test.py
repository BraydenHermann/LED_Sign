import asyncio
from bleak import BleakScanner

async def main():
    print("Scanning for 15 seconds...")
    devices = await BleakScanner.discover(timeout=15.0)
    for d in devices:
        print(f"{d.address} - {d.name}")
    print("Scan complete.")

if __name__ == "__main__":
    asyncio.run(main())
