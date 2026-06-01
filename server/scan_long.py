import asyncio
from bleak import BleakScanner

async def main():
    print("Starting 30 seconds scan...")
    
    def detection_callback(device, advertisement_data):
        name = device.name or "None"
        if "hello" in name.lower() or device.address.lower() == "ff:24:10:29:44:9b":
            print(f"FOUND IT! Addr: {device.address} | Name: {device.name} | RSSI: {advertisement_data.rssi} dBm | Services: {advertisement_data.service_uuids}")

    scanner = BleakScanner(detection_callback=detection_callback)
    await scanner.start()
    await asyncio.sleep(30.0)
    await scanner.stop()
    print("Scan finished.")

if __name__ == "__main__":
    asyncio.run(main())
