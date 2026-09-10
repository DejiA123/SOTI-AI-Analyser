# SOTI Connect — Product Overview
Source: https://www.soti.net/soticonnect/

SOTI Connect is an expandable system for managing printers and other devices in an Internet of Things (IoT) network. Device administrators use SOTI Connect to remotely update, configure, reboot, and query the state of devices, and to execute custom actions defined in XML protocol definitions supplied by device manufacturers. It is part of the SOTI ONE Platform and is a separate product from SOTI MobiControl, though the two can be integrated. Typical managed devices include networked and Wi-Fi printers (for example Zebra, Honeywell and Brother), barcode scanners, and other IoT/edge devices. SOTI Connect can be deployed on-premise or consumed as a cloud instance.

# SOTI Connect — Architecture and Components
Source: https://www.soti.net/soticonnect/v2.5/en/

SOTI Connect is built from several cooperating components:

- Management Service (MS): the core service that runs the console, business logic, rules and the device inventory. A backup Management Service can be added to form a cluster for failover redundancy.
- SQL Server database: stores device inventory, configuration, rules, users and audit data. All Connect services depend on it.
- HiveMQ MQTT broker: provides MQTT device brokering for devices that communicate over MQTT. It requires Java components and keystore-generation tooling, and is set up as part of installation.
- Protocol Adapters: each protocol adapter implements a device-management protocol and uses a protocol definition (XML) to translate console actions to and from a specific device type. Protocol adapters can be grouped into clusters for scale and robustness. In a cloud instance, the only component that must run locally is the protocol adapter for the desired device type.
- REST device middleware: for REST-based devices, third-party middleware such as Honeywell Cloud Connect or Brother Device Conductor is installed alongside Connect.
- Console / Swagger API: the web console for administration, plus a Swagger API service for programmatic access.

Data flow: IoT/printer devices communicate via their protocol adapter (or the MQTT broker) to the Management Service, which persists state in SQL and presents it in the console; integrations (for example with MobiControl/XSight) and the API sit on top.

# SOTI Connect — System Management and Protocol Adapters
Source: https://www.soti.net/soticonnect/v2.5/en/console/

The System Management area of the console lists the device-management protocols and the protocol adapters developed for them. Each protocol adapter uses a protocol definition to communicate actions to and from a specific type of device, so adding support for a new device family is largely a matter of deploying the right protocol adapter and definition. Protocol adapters can be grouped into clusters for ease of administration and greater robustness; if one adapter in a cluster is unavailable, others can continue to serve devices of that protocol. A protocol adapter being offline takes every device of that protocol offline at once — a common cause of a "many devices offline" alert that is actually a single adapter or broker fault.

# SOTI Connect — Installation and Setup
Source: https://www.soti.net/soticonnect/v2.4/en/setup/setup.html

General pre-setup: review the SOTI Connect Components topic to understand the architecture, download the SOTI Connect installer (which includes the release notes), and review the hardware and software requirements for cloud or on-premise deployment.

On-premise new installation checklist:
1. Network configuration — open the required network ports. The installer adds Windows Firewall rules, but additional ports may be needed depending on device types.
2. SQL Server — install and configure SQL Server per the setup documentation.
3. HiveMQ / MQTT — set up HiveMQ for MQTT device brokering, including the Java components and keystore-generation tools (required for MQTT devices).
4. REST device middleware — install third-party middleware such as Honeywell Cloud Connect or Brother Device Conductor (needed for REST devices).
5. SOTI Connect — run the installer for a typical all-in-one deployment; the installer can be re-run later to add or modify components.
6. Optional — Protocol Adapter clustering: add multiple protocol adapters to form a cluster.
7. Optional — Management Service clustering: set up a backup Management Service for failover.

Post-installation: review the update procedure for future releases, the uninstallation process, and configure initial console settings including user and device management.

# SOTI Connect — Device Onboarding and Discovery
Source: https://www.soti.net/soticonnect/v2.5/en/

Devices are brought under management through the appropriate protocol adapter for their type. Depending on the device family this is done by network discovery (scanning an IP range so the adapter finds devices of its protocol), by the device connecting to the MQTT broker, or via REST middleware for REST-based devices. Once discovered, a device appears in the console inventory where it can be configured, grouped, and have rules and actions applied. Accurate device onboarding depends on the correct protocol adapter/definition being deployed and reachable, and on the device's network path to the adapter or broker being open. SOTI Connect device onboarding is distinct from SOTI MobiControl enrolment (which uses agents and enrolment IDs); Connect manages IoT/printer devices through protocol adapters rather than a device agent.

# SOTI Connect — Network Ports and Connectivity
Source: https://www.soti.net/soticonnect/v2.5/en/setup/

Connectivity essentials:
- 1883 (MQTT) and 8883 (MQTT over TLS): device-to-broker communication for MQTT devices via HiveMQ.
- 443 (HTTPS): console/web UI and REST API.
- 1433 (TCP): SOTI Connect services to SQL Server.
- 161 / 162 (SNMP): printer and device discovery and supply/status telemetry.
The installer creates Windows Firewall rules, but device-type-specific ports may need to be opened manually. Because all Connect services share one SQL database, a database connectivity problem surfaces in every service log at the same timestamps.

# SOTI Connect — Common Issues and Troubleshooting
Source: https://pulse.soti.net/support/soti-connect/help/

High-value symptoms and where to look:
- Device connectivity: "Device connection timeout", "MQTT broker unreachable", "Protocol negotiation failed", "TLS handshake error", "Device certificate rejected", "CONNACK refused" — check the network path, certificates, broker health, and protocol/firmware compatibility.
- Protocol adapter / connector: "Connector offline", "Protocol Adapter stopped", "resource exhausted", "Connection pool depleted", "Upstream timeout" — check the adapter service status and resources. One offline adapter takes all of its protocol's devices offline.
- Data processing: "Payload parse error", "Schema mismatch for device type", "Unsupported firmware response", "Command execution timeout" — usually a device driver/definition mismatch with the device firmware.
- Printer/IoT-specific: "SNMP community string mismatch", "Print queue stuck", "Firmware update failed", "Supply level read error", "PJL command rejected" — check device configuration, firmware, and driver/definition version.
- Database: shared SQL issues ("SqlException", "Login failed for user", "Timeout expired") appear across every Connect service log simultaneously.

Domino patterns:
- MQTT broker down → every device's last-will (LWT) fires at once → mass "offline" alerts with identical timestamps (look for the broker restart, not device faults).
- Protocol adapter offline → all devices of that protocol unreachable → dashboard shows them offline though the devices themselves are fine.
- Certificate expired on the broker/gateway → TLS handshake fails → devices cannot report → status shows "unknown".

# SOTI Connect — Integration with the SOTI ONE Platform
Source: https://www.soti.net/soticonnect/

SOTI Connect integrates with other SOTI ONE products. It can surface device data to SOTI XSight for operational intelligence and can be used alongside SOTI MobiControl. Integration credentials and API access are configured in the console; an expired integration credential stops cross-product data flow even though each product remains healthy on its own.
