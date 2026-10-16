import struct

class LOYProtocol:
    SERVICE_UUID = "0000FFF0-0000-1000-8000-00805F9B34FB"
    WRITE_UUID = "0000FFF2-0000-1000-8000-00805F9B34FB"
    NOTIFY_UUID = "0000FFF1-0000-1000-8000-00805F9B34FB"

    def __init__(self):
        self._sno = 1

    def build_packet(self, payload, sno=None, cmd_type=0xC1, sub_type=0x02):
        """
        Builds a full LOY protocol packet.
        Format: AA 55 | FF FF | LEN (2B LE) | SNO (2B LE) | TYPE | SUB | PAYLOAD | CS (2B LE)
        """
        if sno is None:
            sno = self._sno
            self._sno = (self._sno + 1) % 0xFFFF

        # Packet header part (10 bytes)
        # AA 55 (0x55AA in LE)
        # FF FF (Target/Source)
        # Length (Payload length + 6) -> 2 bytes for C1 02, 2 bytes for CS, plus payload length?
        # Actually, the app says a+4 where a = payload_len + 2. So payload_len + 6.
        payload_len = len(payload)
        pkt_len = payload_len + 6
        
        header = struct.pack("<HHHHBB", 
            0x55AA, # AA 55
            0xFFFF, # Target
            pkt_len,
            sno,
            cmd_type,
            sub_type
        )
        
        # Combine header and payload
        packet_without_cs = header + payload
        
        # Calculate checksum: sum of all bytes in the header and payload
        checksum = sum(packet_without_cs) & 0xFFFF
        
        # Add checksum (2 bytes LE)
        final_packet = packet_without_cs + struct.pack("<H", checksum)
        
        return final_packet

    def power_command(self, on=True):
        """
        Power ON/OFF command.
        Payload: [0x04, 0x02, 0x00, 0x01/0x00]
        """
        val = 0x01 if on else 0x00
        return self.build_packet(bytes([0x04, 0x02, 0x00, val]))

    def brightness_command(self, level):
        """
        Set brightness level (1-15).
        """
        level = max(1, min(15, level))
        return self.build_packet(bytes([0x06, 0x02, 0x00, level]))

    def info_command(self):
        """
        Request device info.
        Payload: [0x0A, 0x00]
        """
        return self.build_packet(bytes([0x0A, 0x00]))

    def device_info_all_command(self, passcode: str = ""):
        """Request the device-info bundle used by current LOY apps.

        A password-protected sign expects the optional six-digit Bluetooth
        passcode immediately after the ``0x0A`` device-info tag.  This is an
        application protocol credential, not an operating-system Bluetooth
        pairing PIN.
        """
        code = passcode.encode("ascii") if passcode else b""
        if code and (len(code) != 6 or not code.isdigit()):
            raise ValueError("The Bluetooth passcode must contain exactly six digits")
        # 0x1B, 0x04 and 0x06 request the same extended device-info fields
        # queried by LOY PLAY/LOY SPACE when a connection opens.
        payload = bytes([0x0A, len(code)]) + code + bytes([0x1B, 0x00, 0x04, 0x00, 0x06, 0x00])
        return self.build_packet(payload, cmd_type=0xC1, sub_type=0x03)

    def password_set_command(self, passcode: str):
        code = passcode.encode("ascii")
        if len(code) != 6 or not code.isdigit():
            raise ValueError("The Bluetooth passcode must contain exactly six digits")
        return self.build_packet(bytes([0x37, len(code) + 1, 0x01]) + code)

    def password_disable_command(self):
        return self.build_packet(bytes([0x37, 0x01, 0x02]))

    def password_status_command(self):
        """Query the sign's passcode state (the LOY app's get pwd/type 2)."""
        return self.build_packet(bytes([0x37, 0x01, 0x02]), cmd_type=0xC1, sub_type=0x03)

# Example usage/test
if __name__ == "__main__":
    proto = LOYProtocol()
    # Test Power ON (SNO=1)
    # Expected: AA 55 FF FF 0A 00 01 00 C1 02 04 02 00 01 D2 03
    pkt = proto.build_packet(bytes([0x04, 0x02, 0x00, 0x01]), sno=1)
    print(f"Power ON Packet: {pkt.hex(' ')}")
