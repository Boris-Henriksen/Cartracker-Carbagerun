# MikroTik LtAP setup

This project expects the LtAP to send GPS points outward over HTTPS. That works through mobile carrier NAT and through a company firewall as long as outbound TCP 443 is allowed.

## Important: use the public HTTPS address

The vehicle reaches the server over mobile data, so it can't use the server's LAN address. Install CarTracker in **Public** mode (domain + Let's Encrypt). The exact URL and vehicle token are shown under **Admin → Overview**; it looks like:

```text
https://tracker.example.com/api/telemetry
```

Do not use plain HTTP or a LAN IP on the vehicle.

## Before writing the RouterOS script

Record:

- Exact LtAP model
- RouterOS version
- GPS port/interface name
- Whether the GPS monitor exposes latitude, longitude, speed, and course
- Reporting interval, normally 10 to 30 seconds

On the LtAP, collect this information and send it back:

```routeros
/system resource print
/system package update print
/system gps print
/system gps monitor once
```

The RouterOS GPS field names differ by version and hardware, so test the monitor command on the actual device before automating it.

## Device-side responsibilities

1. Enable the GPS interface.
2. Read one GPS sample on a scheduler interval.
3. Build the JSON payload from the sample.
4. Send it with RouterOS `/tool fetch` to the API URL.
5. Use a unique bearer token for each vehicle.
6. Log failures locally and retry on the next interval.

The vehicle token is created by the installer. Copy it from **Admin → Overview**, where you can also generate a new one if the device is lost (the old token stops working immediately).

## Test the network before reading GPS

After the public hostname is working, test one fixed payload from the LtAP. **Admin → Overview** shows this command with your URL and token already filled in. Do not leave this sample payload as the scheduler script.

```routeros
/tool fetch url="https://tracker.example.com/api/telemetry" \
	http-method=post \
	http-header-field="Authorization: Bearer YOUR_TOKEN,Content-Type: application/json" \
	http-data="{\"vehicleId\":\"car-1\",\"latitude\":-26.2041,\"longitude\":28.0473,\"speed\":0,\"heading\":0,\"timestamp\":\"2026-09-22T12:00:00Z\"}" \
	output=user
```

Expected result: HTTP `201` and a JSON response containing `vehicle`. Then check the dashboard. If this fails, fix DNS, the tunnel, cellular connectivity, or the token before adding GPS parsing.

## Example target request

```text
POST https://tracker.example.com/api/telemetry
Authorization: Bearer <vehicle-token>
Content-Type: application/json
```

Do not copy a GPS scheduler script into production until the GPS monitor output from the specific LtAP has been checked. RouterOS GPS field names and timestamp formatting vary by version and hardware. The next implementation step is to provide the output of the commands above and write a version-specific script.

## Sending the extra GPS quality fields

`/system gps monitor once` also exposes altitude, satellite count, fix quality, and horizontal dilution (accuracy). These are optional on the API but worth sending since they show up on the dashboard. Add them to the script's payload alongside the existing fields:

```routeros
:local altitude ($gps->"altitude")
:local satellites ($gps->"satellites")
:local fixQuality ($gps->"fix-quality")
:local accuracy ($gps->"horizontal-dilution")

:local payload ("{\"vehicleId\":\"car-1\",\"latitude\":" . $latitude . ",\"longitude\":" . $longitude . ",\"speed\":" . $speed . ",\"heading\":" . $heading . ",\"timestamp\":\"" . $timestamp . "\",\"altitude\":" . $altitude . ",\"satellites\":" . $satellites . ",\"fixQuality\":" . $fixQuality . ",\"accuracy\":" . $accuracy . "}")
```

Only add a field if the corresponding GPS value is reliably numeric on your device; if any of them ever prints as `none`, guard it the same way `speed`/`heading` are guarded elsewhere in the script, or leave that field out of the payload entirely.
