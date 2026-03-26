export class HRMonitor {
  constructor() {
    this.device = null;
    this.server = null;
    this.characteristic = null;
    this.onHeartRate = null;
    this.onRRInterval = null;
    this.onDisconnect = null;
  }

  get isConnected() {
    return this.server?.connected ?? false;
  }

  async connect() {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth wird von diesem Browser nicht unterstützt. Bitte Chrome, Edge oder Opera verwenden.');
    }

    // Try auto-reconnect: first direct gatt.connect(), then watchAdvertisements()
    this.device = await this._tryAutoReconnect();

    // Fall back to picker dialog if no known device found
    if (!this.device) {
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ services: ['heart_rate'] }],
        optionalServices: ['heart_rate']
      });
    }

    this.device.addEventListener('gattserverdisconnected', () => {
      if (this.onDisconnect) this.onDisconnect();
    });

    // Only connect if not already connected from auto-reconnect
    if (!this.device.gatt.connected) {
      this.server = await this._connectWithRetry(this.device, 3, 500);
    } else {
      this.server = this.device.gatt;
    }

    const service = await this.server.getPrimaryService('heart_rate');
    this.characteristic = await service.getCharacteristic('heart_rate_measurement');

    this.characteristic.addEventListener('characteristicvaluechanged', (e) => this._onNotification(e));
    await this.characteristic.startNotifications();
  }

  async _connectWithRetry(device, maxAttempts = 3, delayMs = 500) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const server = await Promise.race([
          device.gatt.connect(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('GATT connect timeout')), 5000))
        ]);
        console.log(`[HRM] GATT connect succeeded on attempt ${attempt}`);
        return server;
      } catch (e) {
        console.log(`[HRM] GATT connect attempt ${attempt}/${maxAttempts} failed: ${e.message}`);
        if (attempt === maxAttempts) throw e;
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }

  async _tryAutoReconnect() {
    if (!navigator.bluetooth.getDevices) return null;

    try {
      const devices = await navigator.bluetooth.getDevices();
      if (devices.length === 0) return null;

      console.log(`[HRM] getDevices() returned ${devices.length} device(s):`, devices.map(d => d.name || d.id));

      // Strategy 1: Try direct gatt.connect() with retry on each known device
      for (const device of devices) {
        try {
          this.server = await this._connectWithRetry(device, 2, 300);
          console.log(`[HRM] Direct reconnect to ${device.name || device.id} succeeded`);
          return device;
        } catch (e) {
          console.log(`[HRM] Direct connect to ${device.name || device.id} failed: ${e.message}`);
        }
      }

      // Strategy 2: Watch for advertisements
      const ac = new AbortController();
      const result = await Promise.race([
        ...devices.map(device => this._waitForDevice(device, ac)),
        new Promise(resolve => setTimeout(() => { ac.abort(); resolve(null); }, 5000))
      ]);
      return result;
    } catch (e) {
      console.log('[HRM] Auto-reconnect failed:', e.message);
    }
    return null;
  }

  _waitForDevice(device, abortController) {
    return new Promise((resolve) => {
      const onAdvert = async () => {
        device.removeEventListener('advertisementreceived', onAdvert);
        abortController.abort();
        console.log(`[HRM] Advertisement from ${device.name || device.id}, connecting...`);
        try {
          this.server = await device.gatt.connect();
          resolve(device);
        } catch (e) {
          resolve(null);
        }
      };
      device.addEventListener('advertisementreceived', onAdvert);
      device.watchAdvertisements({ signal: abortController.signal }).catch(() => resolve(null));
    });
  }

  async reconnect() {
    if (!this.device) throw new Error('No device to reconnect to');

    this.server = await Promise.race([
      this.device.gatt.connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Reconnect timeout')), 5000))
    ]);

    const service = await this.server.getPrimaryService('heart_rate');
    this.characteristic = await service.getCharacteristic('heart_rate_measurement');
    this.characteristic.addEventListener('characteristicvaluechanged', (e) => this._onNotification(e));
    await this.characteristic.startNotifications();
  }

  disconnect() {
    if (this.characteristic) {
      this.characteristic.removeEventListener('characteristicvaluechanged', this._onNotification);
    }
    if (this.device?.gatt?.connected) {
      this.device.gatt.disconnect();
    }
    this.device = null;
    this.server = null;
    this.characteristic = null;
  }

  _onNotification(event) {
    const data = event.target.value;
    const flags = data.getUint8(0);
    const hrIs16Bit = flags & 0x01;
    const eePresent = flags & 0x08;
    const rrPresent = flags & 0x10;

    let offset = 1;
    let hr;

    if (hrIs16Bit) {
      hr = data.getUint16(offset, true);
      offset += 2;
    } else {
      hr = data.getUint8(offset);
      offset += 1;
    }

    if (eePresent) offset += 2;

    console.log(`[HRM] HR=${hr} flags=0b${flags.toString(2).padStart(8,'0')} rrPresent=${!!rrPresent} bytes=${data.byteLength}`);

    if (this.onHeartRate) this.onHeartRate(hr);

    if (rrPresent) {
      while (offset + 1 < data.byteLength) {
        const rrRaw = data.getUint16(offset, true);
        const rrMs = rrRaw / 1.024;
        offset += 2;
        console.log(`[HRM] RR raw=${rrRaw} (${rrMs.toFixed(1)} ms) → ${rrMs > 200 && rrMs < 2000 ? 'OK' : 'FILTERED'}`);
        if (rrMs > 200 && rrMs < 2000) {
          if (this.onRRInterval) this.onRRInterval(rrMs);
        }
      }
    }
  }
}
