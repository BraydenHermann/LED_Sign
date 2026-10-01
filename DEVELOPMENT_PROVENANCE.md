# Development Provenance

This document outlines the historical development methodology used to implement hardware compatibility in this independently developed application. 

## Implementation Methodology
* The application was independently developed to communicate with compatible LED sign hardware.
* Protocol behavior was determined strictly through functional testing of owned and authorized hardware, as well as observation of communication and log output generated while performing standard actions in the LOY SPACE mobile application.
* Development involved comparing actions performed in the mobile application with captured Bluetooth/HCI and application log behaviors, and then implementing compatible command structures based entirely on those observations.
* AI-assisted development tools (including Antigravity) were utilized to help analyze these observational data, implement functionality, debug behavior, and streamline application development.
* This implementation does not originate from access to ATOTO or LOY SPACE source code, nor is it represented as such. 
* No claim is made that the protocol itself is owned by this project.

## Development and Provenance Artifacts
The following categories of files and scripts exist in the repository's history and represent the empirical evidence and tooling used during development. These artifacts establish the provenance of the implementation but are intended for development only and should not be included in customer or acquisition distribution packages:

* **HCI/Bluetooth Captures**: Raw trace files of Bluetooth data between the mobile application and the hardware.
* **LOY SPACE Behavioral Test Logs**: Logs of application output captured during interaction with the official app.
* **Protocol Experimentation Scripts**: Scripts used to iterate on byte formats and understand the checksum/encoding rules (e.g., server/ble_test_*.py).
* **Debugging Scripts**: Ad-hoc scripts used to test specific Bluetooth write characteristics or payload splitting logic.
* **Development Notes**: Markdown or text files noting down byte offsets and behavior observations.
* **Test Utilities**: Scripts dedicated to scanning and attempting connections.
