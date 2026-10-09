---
name: device-automation
description: 'Use when asked to demonstrate device automation with the built-in virtual device simulator.'
license: MIT
compatibility: Requires Node.js on PATH.
---

# Simulated device automation

This skill operates only on a fixed set of virtual devices. It never connects to or controls real hardware, services, or networks. Every result is a simulation and must not be described as a real device state or completed physical action.

Run `scripts/device.js` with one of these command forms:

- `list` to list virtual devices.
- `status <device-id>` to inspect one device.
- `turn-on <device-id>` or `turn-off <device-id>` to simulate changing a device's power.
- `set-brightness desk-lamp <0-100>` to simulate setting the virtual desk lamp brightness.

The device IDs are `desk-lamp`, `smart-plug`, and `thermostat`. Each invocation starts from the same sample state; simulated changes are not persisted.
