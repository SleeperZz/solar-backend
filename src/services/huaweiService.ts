// src/services/huaweiService.ts
import axios, { AxiosError, AxiosInstance, InternalAxiosRequestConfig } from 'axios';

/**
 * Huawei Northbound API (บาง tenant) ตอบ rate limit เป็น HTTP 407
 * แนวทางแก้:
 * 1) Global Throttle (คิวเดียว): เว้นระยะขั้นต่ำทุก request
 * 2) Global Cooldown: ถ้าโดน 407 ให้ "พักทั้งระบบ" ชั่วคราว (request ถัดไปต้องรอ)
 * 3) Retry 407: backoff + jitter และขยาย throttle อัตโนมัติ
 */

type RetryRequestConfig = InternalAxiosRequestConfig & {
  _retry?: boolean;
  _retryCount?: number;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const jitter = (ms: number) => ms + Math.floor(Math.random() * 350);

// ✅ export types ให้ syncService.ts import ได้
export type HuaweiStation = {
  plantCode?: string;
  stationCode?: string;
  plantName?: string;
  stationName?: string;
  capacity?: number;
  plantAddress?: string;
  stationAddr?: string;
  latitude?: string | number;
  longitude?: string | number;
};

export type HuaweiDevice = {
  id: number | string; // devId
  devDn?: string;
  devName?: string;
  esnCode?: string;
  stationCode?: string;
  devTypeId?: number; // 1=inverter
  model?: string;
  invType?: string;
  softwareVersion?: string;
  latitude?: number;
  longitude?: number;
};

class HuaweiService {
  private client: AxiosInstance;
  private token: string | null = null;
  private loginPromise: Promise<void> | null = null;

  private baseUrl = process.env.HUAWEI_API_BASE_URL || 'https://intl.fusionsolar.huawei.com';

  // -------- Throttle / Cooldown (global) --------
  private throttleChain: Promise<void> = Promise.resolve();

  // แนะนำเริ่มต้นสูง ๆ เพราะ tenant บางที่ limit ต่ำมาก
  private minIntervalMs = Number(process.env.HUAWEI_MIN_INTERVAL_MS ?? 6500);

  // ถ้าโดน 407 ให้พักทั้งระบบจนถึงเวลานี้
  private cooldownUntil = 0;

  constructor() {
    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: { 'Content-Type': 'application/json' },
      timeout: 30_000,
    });

    // Global throttle + cooldown + แนบ token
    this.client.interceptors.request.use(async (config) => {
      const now = Date.now();
      if (now < this.cooldownUntil) {
        const wait = this.cooldownUntil - now;
        console.warn(`🧊 Huawei cooldown active. Waiting ${wait}ms...`);
        await sleep(jitter(wait));
      }

      const waitMyTurn = this.throttleChain.then(async () => {
        await sleep(jitter(this.minIntervalMs));
      });

      this.throttleChain = waitMyTurn.catch(() => undefined);
      await waitMyTurn;

      if (this.token) {
        config.headers = config.headers ?? {};
        config.headers['xsrf-token'] = this.token;
      }
      return config;
    });

    this.client.interceptors.response.use(
      (r) => r,
      async (error: AxiosError) => {
        const originalRequest = error.config as RetryRequestConfig | undefined;
        if (!originalRequest) return Promise.reject(error);

        const status = error.response?.status;
        const failCode = (error.response?.data as any)?.failCode;

        const isAuthError = status === 401 || failCode === 305;
        const isRateLimit = status === 407 || failCode === 407;

        // ---- token หมดอายุ -> relogin แล้ว retry 1 ครั้ง ----
        if (isAuthError && !originalRequest._retry) {
          originalRequest._retry = true;
          console.log('🔄 Huawei token expired. Relogin and retry...');
          await this.ensureLoggedIn({ force: true });
          return this.client(originalRequest);
        }

        // ---- rate limit ----
        if (isRateLimit) {
          originalRequest._retryCount = (originalRequest._retryCount ?? 0) + 1;

          const retryAfterHeader = (error.response?.headers as any)?.['retry-after'];
          const retryAfterMs =
            retryAfterHeader != null && !Number.isNaN(Number(retryAfterHeader))
              ? Number(retryAfterHeader) * 1000
              : null;

          // backoff: 30s, 60s, 90s, 120s ... (cap 5 นาที)
          const baseDelay = Math.min(300_000, 30_000 * originalRequest._retryCount);
          const delay = retryAfterMs != null ? Math.max(baseDelay, retryAfterMs) : baseDelay;

          // ✅ ตั้ง cooldown ทั้งระบบ
          this.cooldownUntil = Date.now() + delay;

          // ✅ ปรับ throttle ช้าลงแบบ adaptive
          const newMin = Math.min(15_000, Math.floor(this.minIntervalMs * 1.25));
          if (newMin !== this.minIntervalMs) {
            console.warn(`🐢 Increasing Huawei minIntervalMs: ${this.minIntervalMs} -> ${newMin}`);
            this.minIntervalMs = newMin;
          }

          // จำกัดจำนวน retry ต่อ request
          if (originalRequest._retryCount <= 8) {
            console.warn(`Huawei rate limit (407). Cooling down ${delay}ms then retry...`);
            await sleep(jitter(delay));
            return this.client(originalRequest);
          }
        }

        return Promise.reject(error);
      }
    );
  }

  public async ensureLoggedIn(opts?: { force?: boolean }) {
    const force = opts?.force ?? false;

    if (force) {
      this.token = null;
      delete this.client.defaults.headers.common['xsrf-token'];
    }
    if (this.token) return;

    if (!this.loginPromise) {
      this.loginPromise = this.login().finally(() => (this.loginPromise = null));
    }
    await this.loginPromise;
  }

  private async login() {
    const userName = process.env.HUAWEI_USER;
    const systemCode = process.env.HUAWEI_PASSWORD;

    if (!userName || !systemCode) {
      throw new Error('Missing HUAWEI_USER or HUAWEI_PASSWORD in .env');
    }

    const response = await this.client.post('/thirdData/login', { userName, systemCode });

    if (!response.data?.success) {
      console.error('❌ Huawei Login Failed:', response.data);
      throw new Error('Huawei Login Failed');
    }

    const token = response.headers['xsrf-token'];
    this.token = Array.isArray(token) ? token[0] : token ?? null;

    if (!this.token) throw new Error('Huawei login succeeded but xsrf-token header missing');

    this.client.defaults.headers.common['xsrf-token'] = this.token;
    console.log('✅ Huawei Login Success');
    console.log('xsrf-token:', this.token);
  }

  // ---------- Endpoint: stations ----------
  public async stations(params?: { pageNo?: number; pageSize?: number }) {
    await this.ensureLoggedIn();
    const pageNo = params?.pageNo ?? 1;
    const pageSize = params?.pageSize ?? 100;
    const res = await this.client.post('/thirdData/stations', { pageNo, pageSize });
    return res.data;
  }

  // alias กันโค้ดเก่าเรียก getStations
  public async getStations(params?: { pageNo?: number; pageSize?: number }) {
    return this.stations(params);
  }

  // ---------- Endpoint: getStationRealKpi ----------
  public async getStationRealKpi(stationCodes: string[] | string) {
    await this.ensureLoggedIn();
    const stationCodesStr = Array.isArray(stationCodes) ? stationCodes.join(',') : stationCodes;
    const res = await this.client.post('/thirdData/getStationRealKpi', { stationCodes: stationCodesStr });
    return res.data;
  }

  // ---------- Endpoint: getDevList ----------
  public async getDevList(stationCodes: string[] | string) {
    await this.ensureLoggedIn();
    const stationCodesStr = Array.isArray(stationCodes) ? stationCodes.join(',') : stationCodes;
    const res = await this.client.post('/thirdData/getDevList', { stationCodes: stationCodesStr });
    return res.data;
  }

  // ---------- Endpoint: getDevRealKpi ----------
  public async getDevRealKpi(params: { devTypeId: number; devIds?: string[] | string; sns?: string[] | string }) {
    await this.ensureLoggedIn();

    const body: any = { devTypeId: params.devTypeId };
    if (params.devIds) body.devIds = Array.isArray(params.devIds) ? params.devIds.join(',') : params.devIds;
    if (params.sns) body.sns = Array.isArray(params.sns) ? params.sns.join(',') : params.sns;

    const res = await this.client.post('/thirdData/getDevRealKpi', body);
    return res.data;
  }

  // ---------- Endpoint: Station History KPI (optional) ----------
  // ตามเอกสาร: /thirdData/getKpiStationDay, /thirdData/getKpiStationMonth, /thirdData/getKpiStationYear【:contentReference[oaicite:11]{index=11}】
  public async getKpiStationDay(params: { stationCodes: string[] | string; collectTime: number }) {
    await this.ensureLoggedIn();
    const stationCodesStr = Array.isArray(params.stationCodes) ? params.stationCodes.join(',') : params.stationCodes;
    const res = await this.client.post('/thirdData/getKpiStationDay', { stationCodes: stationCodesStr, collectTime: params.collectTime });
    return res.data;
  }

  public async getKpiStationMonth(params: { stationCodes: string[] | string; collectTime: number }) {
    await this.ensureLoggedIn();
    const stationCodesStr = Array.isArray(params.stationCodes) ? params.stationCodes.join(',') : params.stationCodes;
    const res = await this.client.post('/thirdData/getKpiStationMonth', { stationCodes: stationCodesStr, collectTime: params.collectTime });
    return res.data;
  }

  public async getKpiStationYear(params: { stationCodes: string[] | string; collectTime: number }) {
    await this.ensureLoggedIn();
    const stationCodesStr = Array.isArray(params.stationCodes) ? params.stationCodes.join(',') : params.stationCodes;
    const res = await this.client.post('/thirdData/getKpiStationYear', { stationCodes: stationCodesStr, collectTime: params.collectTime });
    return res.data;
  }
}

export const huaweiService = new HuaweiService();
