import asyncio
from bleak import BleakScanner

async def scan():
    devices = await BleakScanner.discover(timeout=15.0)
    for d in devices:
        if d.name and (d.name.startswith("YS") or d.name.startswith("TL")):
            print(d.address)
            return
    print("NONE")

if __name__ == "__main__":
    asyncio.run(scan())
