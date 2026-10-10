const devices = [
  { id: 'desk-lamp', type: 'light', powered: false, brightness: 0 },
  { id: 'smart-plug', type: 'plug', powered: true },
  { id: 'thermostat', type: 'thermostat', powered: true, temperatureC: 21 },
];

const [command, deviceId, value] = process.argv.slice(2);
const device = devices.find((item) => item.id === deviceId);

function fail(message) {
  console.error(message);
  process.exitCode = 2;
}

function output(result) {
  console.log(JSON.stringify({ simulated: true, ...result }));
}

if (command === 'list' && deviceId === undefined) {
  output({ devices });
} else if (command === 'status' && device && value === undefined) {
  output({ device });
} else if ((command === 'turn-on' || command === 'turn-off') && device && value === undefined) {
  device.powered = command === 'turn-on';
  if (device.id === 'desk-lamp') device.brightness = device.powered ? 50 : 0;
  output({ device, message: `Simulated ${command} for ${device.id}.` });
} else if (
  command === 'set-brightness' &&
  device?.id === 'desk-lamp' &&
  value !== undefined &&
  /^(?:100|[1-9]?\d)$/.test(value)
) {
  device.brightness = Number(value);
  device.powered = device.brightness > 0;
  output({ device, message: `Simulated brightness change for ${device.id}.` });
} else {
  fail(
    'Usage: device.js list | status <device-id> | turn-on <device-id> | turn-off <device-id> | set-brightness desk-lamp <0-100>',
  );
}
