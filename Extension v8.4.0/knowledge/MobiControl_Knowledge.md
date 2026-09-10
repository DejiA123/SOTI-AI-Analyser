# SOTI MobiControl — Cannot Access the Web Console (Console Access Troubleshooting)
Source: https://pulse.soti.net/support/soti-mobicontrol/help/

If you cannot access the SOTI MobiControl web console (also written "webconsole"), work through this checklist. The web console is hosted by the SOTI MobiControl Management Service — it is not a separate web server product — so console availability follows Management Service health.

1. Management Service health: on the server, confirm the SOTI MobiControl Management Service Windows service is running. If it is stopped or crash-looping, the console URL will not load at all. Restarting the Management Service restores the console in most outage cases.
2. HTTPS / port 443: the console is served over HTTPS (TCP 443). Confirm the port is reachable from your browser's network (firewall, VPN, load balancer) and that nothing else is bound to it.
3. Certificate: an expired or untrusted server certificate causes browser security errors or a blocked page. Verify the certificate presented on the console URL is valid, matches the server FQDN you are browsing to, and its chain is trusted.
4. URL / FQDN: use the exact enrollment/console FQDN configured during installation. A hostname that does not resolve from the client network (internal-only DNS name) fails even though the server is healthy.
5. SQL Server dependency: the Management Service depends on the SOTI MobiControl SQL database. If SQL Server is down, out of space, or refusing logins, the console can fail to load or fail at sign-in. Check the MS log for SqlException / "Login failed for user" entries at the failure time.
6. Sign-in vs access: if the page loads but your account cannot sign in, the problem is authentication (LDAP/directory connection, SOTI Identity/SSO configuration, or a locked/disabled account), not console availability. Test with a local administrator account to separate the two.

# SOTI MobiControl — Device Shows Offline / Not Checking In (Agent Connectivity Troubleshooting)
Source: https://pulse.soti.net/support/soti-mobicontrol/help/

When devices are showing offline or disconnected in the web console but the devices themselves have internet access, the issue is almost always the agent-to-Deployment-Server path, not the device's general connectivity.

1. Agent → Deployment Server path: device agents connect OUTBOUND from the device to the SOTI MobiControl Deployment Server on TCP 5494 (Binary) and/or 443 (HTTPS). "Has internet" does not prove this path — a firewall, proxy, or mobile network can allow web browsing while blocking the deployment server address or port. Verify the DS FQDN resolves from the device network and that 5494/443 to it are open.
2. Deployment Server health: if the Deployment Server service is stopped or overloaded, every device shows offline at once. Many devices dropping at the same timestamp points at the server side (DS service, its host, or the SQL database), not at the devices.
3. Certificate / TLS: an expired or replaced server certificate can break the agent TLS connection. Check the DS log for TLS/handshake errors at the time devices dropped.
4. Device-side checks: confirm the agent is still installed and running, the device date/time is correct (TLS fails with a badly wrong clock), and the device was not re-imaged or factory reset without re-enrollment.
5. Last check-in evidence: in the console, sort by last check-in/connected time. A single device offline = device-side issue; a whole group or all devices offline = server, network, or certificate issue upstream.
6. After connectivity is restored, devices reconnect on their own; you can also verify from the device by launching the agent and forcing a connection attempt.

# SOTI MobiControl — Ports You Need to Open Between Devices and the Deployment Server (Core Network Ports and Topology)
Source: https://pulse.soti.net/support/soti-mobicontrol/help/

Which ports need to be open between devices, the deployment server, and the other SOTI MobiControl components. Core topology: Device Agent ⇄ Deployment Server (DS) ⇄ SQL Server ⇄ Management Service (MS, hosts the web console). SOTI XSight and SOTI Connect are separate products that integrate with MobiControl.

Key ports (from the SOTI MobiControl network configuration diagram):
- Device agents → Deployment Server: TCP 5494 (Binary) and/or 443 (HTTPS), OUTBOUND from the device. This is the port pair to open between devices and the deployment server.
- Deployment Server ⇄ Deployment Server (caching, multi-DS): TCP 5495.
- Deployment Server ⇄ Management Server: Binary 5494/5495.
- Web console (Management Service): HTTPS 443 inbound from administrator browsers.
- SOTI MobiControl services → SQL Server: TCP 1433.
- SOTI Signal Service: HTTPS 13131 (outbound to the server hosting Signal Service; inbound on the host running it).
- Apple Push Notification Service (APNs): HTTPS 443 outbound (Apple notification path for iOS/macOS management).
- Windows Notification Service (WNS): HTTP/HTTPS 80/443 outbound.
- Remote control: Binary 5494 inbound.
Open these before enrollment: a device that cannot reach the DS on 5494/443 enrolls partially or shows offline immediately after enrollment.
