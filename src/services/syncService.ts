// src/services/syncService.ts
import { PrismaClient } from '@prisma/client';
import { huaweiService, HuaweiDevice, HuaweiStation } from './huaweiService';

const prisma = new PrismaClient();

function pickStationCode(s: HuaweiStation): string | null {
  return (s.plantCode ?? s.stationCode)?.toString() ?? null;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * ปัดเวลาเป็น slot เดียวกันกับ cron (ค่า default 5 นาที)
 * เพื่อให้ unique([inverterId, ts]) predictable และไม่ชนมั่ว
 */
const SNAPSHOT_SLOT_MS = Number(process.env.HUAWEI_SNAPSHOT_SLOT_MS ?? 5 * 60 * 1000);
function snapTsNow(): Date {
  const t = Date.now();
  const slot = Math.floor(t / SNAPSHOT_SLOT_MS) * SNAPSHOT_SLOT_MS;
  return new Date(slot);
}

/**
 * Derive string status สำหรับ UI แบบ FusionSolar:
 * - ถ้า voltage/current เป็น null ทั้งคู่ → Disconnected
 * - ถ้า voltage > 0 แต่ current ~ 0 → Lost (เหมือนมีแรงดันแต่ไม่ไหล)
 * - อื่น ๆ → Normal
 */
function deriveStringStatus(voltage: number | null, current: number | null): 'Normal' | 'Lost' | 'Disconnected' {
  if (voltage == null && current == null) return 'Disconnected';
  const v = voltage ?? 0;
  const i = current ?? 0;
  if (v > 50 && i < 0.05) return 'Lost';
  return 'Normal';
}

const MAX_PLANTS_PER_TICK = Number(process.env.HUAWEI_MAX_PLANTS_PER_TICK ?? 1);
const DEV_BATCH_SIZE = Number(process.env.HUAWEI_DEV_BATCH_SIZE ?? 100);

// ✅ cache stations เพื่อลดการเรียก endpoint /thirdData/stations
const STATION_CACHE_TTL_MS = Number(process.env.HUAWEI_STATION_CACHE_TTL_MS ?? 6 * 60 * 60 * 1000); // 6 ชั่วโมง
let stationCache: { expiresAt: number; stationCodes: string[] } | null = null;

async function refreshStationsIfNeeded(): Promise<string[]> {
  const now = Date.now();

  // 1) ถ้า cache ยังไม่หมดอายุ ใช้เลย
  if (stationCache && now < stationCache.expiresAt && stationCache.stationCodes.length > 0) {
    return stationCache.stationCodes;
  }

  // 2) ลองดึงจาก Huawei (ถ้าโดน 407 ให้ fallback ไปใช้ DB)
  try {
    const stationCodes: string[] = [];
    let pageNo = 1;

    // ปรับ pageSize ได้ผ่าน env (default 100 ตามตัวอย่าง response)
    const pageSize = Number(process.env.HUAWEI_STATION_PAGE_SIZE ?? 100);

    while (true) {
      const res = await huaweiService.stations({ pageNo, pageSize });

      if (!res?.success) {
        throw new Error(`stations failed (failCode=${res?.failCode}): ${res?.message ?? 'unknown'}`);
      }

      const list: HuaweiStation[] = res?.data?.list ?? [];
      const pageCount = Number(res?.data?.pageCount ?? 0);

      // --- กัน API บาง tenant ไม่ส่ง pageCount: ใช้วิธี "ถ้า list ว่างให้หยุด" ---
      if (list.length === 0) break;

      // upsert site เฉพาะตอน refresh เท่านั้น
      for (const st of list) {
        const code = pickStationCode(st);
        if (!code) continue;

        stationCodes.push(code);

        await prisma.site.upsert({
          where: { plantCode: code },
          create: {
            plantCode: code,
            name: (st.plantName ?? st.stationName ?? code).toString(),
            address: (st.plantAddress ?? st.stationAddr ?? undefined) as any,
            latitude: st.latitude != null ? Number(st.latitude) : undefined,
            longitude: st.longitude != null ? Number(st.longitude) : undefined,
            capacityKWp: st.capacity != null ? Number(st.capacity) : 0,
          },
          update: {
            name: (st.plantName ?? st.stationName ?? code).toString(),
            address: (st.plantAddress ?? st.stationAddr ?? undefined) as any,
            latitude: st.latitude != null ? Number(st.latitude) : undefined,
            longitude: st.longitude != null ? Number(st.longitude) : undefined,
            capacityKWp: st.capacity != null ? Number(st.capacity) : undefined,
          },
        });
      }

      // ใช้ pageCount ถ้ามี
      if (pageCount > 0) {
        if (pageNo >= pageCount) break;
        pageNo++;
        continue;
      }

      // ถ้าไม่มี pageCount: ใช้ heuristic ว่า list < pageSize = หน้าสุดท้าย
      if (list.length < pageSize) break;
      pageNo++;
    }

    const uniq = Array.from(new Set(stationCodes));

    stationCache = {
      expiresAt: now + STATION_CACHE_TTL_MS,
      stationCodes: uniq,
    };

    console.log(`✅ Station cache refreshed: ${uniq.length} stations (ttl=${STATION_CACHE_TTL_MS}ms)`);
    return uniq;
  } catch (e: any) {
    console.warn('⚠️ Cannot refresh stations from Huawei (will fallback to DB):', e?.message ?? e);

    // 3) fallback: ใช้ sites ที่มีอยู่ใน DB
    const sites = await prisma.site.findMany({
      select: { plantCode: true },
      orderBy: [{ createdAt: 'asc' }],
      take: 5000,
    });

    const codes = sites.map((s) => s.plantCode).filter(Boolean);

    // ตั้ง cache สั้น ๆ กัน loop พยายามดึง stations ถี่ ๆ
    stationCache = {
      expiresAt: now + 10 * 60 * 1000,
      stationCodes: codes,
    };

    console.log(`✅ Using DB fallback station codes: ${codes.length} stations (short ttl=10min)`);
    return codes;
  }
}

export const syncMonitoringTick = async () => {
  console.log('⏳ Starting Sync Monitoring Tick...');

  try {
    // ✅ ไม่เรียก stations ทุก tick แล้ว (ใช้ cache)
    const stationCodes = await refreshStationsIfNeeded();

    if (!stationCodes || stationCodes.length === 0) {
      console.log('⚠️ No stations available (Huawei + DB).');
      return;
    }

    // เลือก site บางส่วนต่อ tick เพื่อลด request (ตาม MAX_PLANTS_PER_TICK)
    const sitesToSync = await prisma.site.findMany({
      orderBy: [{ updatedAt: 'asc' }, { createdAt: 'asc' }],
      take: MAX_PLANTS_PER_TICK,
    });

    if (sitesToSync.length === 0) {
      console.log('⚠️ No sites in DB.');
      return;
    }

    const ts = snapTsNow(); // ใช้ร่วมทั้ง tick

    for (const site of sitesToSync) {
      const stationCode = site.plantCode;
      console.log(`🔁 Sync plant ${stationCode} (${site.name ?? ''})`);

      // (A) station real KPI → บันทึก SiteDailyEnergy (เติมให้หน้า Monitoring มีกราฟ yield)
      try {
        const end2 = await huaweiService.getStationRealKpi(stationCode);

        if (!end2?.success) {
          console.warn('⚠️ getStationRealKpi failed:', {
            failCode: end2?.failCode,
            message: end2?.message,
            params: end2?.params,
          });
        } else {
          // end2.data เป็น array: [{ stationCode, dataItemMap: {...} }]
          const row = Array.isArray(end2?.data) ? end2.data.find((x: any) => String(x.stationCode) === String(stationCode)) : null;
          const map = row?.dataItemMap ?? {};
          const dayPower = map.day_power != null ? Number(map.day_power) : null; // kWh/day ตามตัวอย่าง end2.json

          if (dayPower != null && Number.isFinite(dayPower)) {
            // normalize date เป็น 00:00:00 ของวันนี้
            const d = new Date();
            d.setHours(0, 0, 0, 0);

            await prisma.siteDailyEnergy.upsert({
              where: { siteId_date: { siteId: site.id, date: d } },
              create: { siteId: site.id, date: d, yieldKWh: dayPower },
              update: { yieldKWh: dayPower },
            });
          }
        }
      } catch (e: any) {
        console.warn('⚠️ getStationRealKpi error (skip):', e?.message ?? e);
      }

      // (B) getDevList → seed/update inverter list
      const end4 = await huaweiService.getDevList(stationCode);
      if (!end4?.success) {
        console.warn('⚠️ getDevList failed:', { failCode: end4?.failCode, message: end4?.message });
        continue;
      }

      const devices: HuaweiDevice[] = end4?.data ?? [];
      const inverters = devices.filter((d) => Number(d.devTypeId) === 1);

      for (const inv of inverters) {
        const devIdStr = String(inv.id);
        const sn = inv.esnCode ? String(inv.esnCode) : `DEV-${devIdStr}`;

        await prisma.inverter.upsert({
          where: { serialNumber: sn },
          create: {
            serialNumber: sn,
            name: (inv.devName ?? devIdStr).toString(),
            model: (inv.model ?? inv.invType ?? 'UNKNOWN').toString(),
            siteId: site.id,
            huaweiDevId: devIdStr,
            stationCode: stationCode,
          },
          update: {
            name: (inv.devName ?? devIdStr).toString(),
            model: (inv.model ?? inv.invType ?? 'UNKNOWN').toString(),
            siteId: site.id,
            huaweiDevId: devIdStr,
            stationCode: stationCode,
          },
        });
      }

      console.log(`✅ Seeded/updated ${inverters.length} inverters for plant ${stationCode}`);

      // (C) getDevRealKpi (batch) → update inverter realtime + write snapshots/strings
      const devIds = inverters.map((d) => String(d.id));
      if (devIds.length > 0) {
        const batches = chunk(devIds, DEV_BATCH_SIZE);

        for (const batchIds of batches) {
          const end5 = await huaweiService.getDevRealKpi({
            devTypeId: 1,
            devIds: batchIds,
          });

          if (!end5?.success || !Array.isArray(end5?.data)) {
            console.warn('⚠️ getDevRealKpi failed:', { failCode: end5?.failCode, message: end5?.message });
            continue;
          }

          for (const item of end5.data) {
            const devId = String(item.devId ?? '');
            const map = item.dataItemMap ?? {};

            const activePower = map.active_power != null ? Number(map.active_power) : 0;
            const dayEnergy = map.day_cap != null ? Number(map.day_cap) : null;
            const runState = map.run_state != null ? Number(map.run_state) : null;

            const temperature = map.temperature != null ? Number(map.temperature) : null;
            const powerFactor = map.power_factor != null ? Number(map.power_factor) : null;
            const totalEnergy = map.total_cap != null ? Number(map.total_cap) : null;

            const inv = await prisma.inverter.findFirst({
              where: { huaweiDevId: devId, siteId: site.id },
            });
            if (!inv) continue;

            // 1) update realtime table (ของเดิม)
            await prisma.inverter.update({
              where: { id: inv.id },
              data: {
                activePower,
                lastDailyEnergy: dayEnergy ?? inv.lastDailyEnergy,
                status: runState === 0 ? 'Normal' : runState == null ? inv.status : 'Fault',
                lastSyncAt: new Date(),
              },
            });

            // 2) upsert KPI snapshot (เติมให้ /history ใช้งานได้จริง)
            const snap = await prisma.inverterKpiSnapshot.upsert({
              where: { inverterId_ts: { inverterId: inv.id, ts } },
              create: {
                inverterId: inv.id,
                ts,
                activePower: Number.isFinite(activePower) ? activePower : 0,
                dayEnergy: dayEnergy != null && Number.isFinite(dayEnergy) ? dayEnergy : 0,
                totalEnergy: totalEnergy != null && Number.isFinite(totalEnergy) ? totalEnergy : null,
                runState: runState != null && Number.isFinite(runState) ? runState : null,
                temperature: temperature != null && Number.isFinite(temperature) ? temperature : null,
                powerFactor: powerFactor != null && Number.isFinite(powerFactor) ? powerFactor : null,
                raw: item,
              },
              update: {
                activePower: Number.isFinite(activePower) ? activePower : 0,
                dayEnergy: dayEnergy != null && Number.isFinite(dayEnergy) ? dayEnergy : 0,
                totalEnergy: totalEnergy != null && Number.isFinite(totalEnergy) ? totalEnergy : null,
                runState: runState != null && Number.isFinite(runState) ? runState : null,
                temperature: temperature != null && Number.isFinite(temperature) ? temperature : null,
                powerFactor: powerFactor != null && Number.isFinite(powerFactor) ? powerFactor : null,
                raw: item,
              },
            });

            // 3) write String snapshots PV1..PV20 (เติมให้ /strings/latest ใช้งานได้จริง)
            // จาก end5.json มี pv1_u/pv1_i ... pv20_u/pv20_i (และบางรุ่นมีมากกว่า)
            const stringRows: { snapshotId: number; stringNo: number; voltage?: number | null; current?: number | null; status?: string | null }[] = [];

            for (let n = 1; n <= 20; n++) {
              const uKey = `pv${n}_u`;
              const iKey = `pv${n}_i`;

              const voltage = map[uKey] != null ? Number(map[uKey]) : null;
              const current = map[iKey] != null ? Number(map[iKey]) : null;

              // ถ้าทั้งคู่ null และไม่มี key เลย ก็ยังสร้างแถวได้ (FE จะเห็น disconnected)
              const status = deriveStringStatus(
                voltage != null && Number.isFinite(voltage) ? voltage : null,
                current != null && Number.isFinite(current) ? current : null
              );

              stringRows.push({
                snapshotId: snap.id,
                stringNo: n,
                voltage: voltage != null && Number.isFinite(voltage) ? voltage : null,
                current: current != null && Number.isFinite(current) ? current : null,
                status,
              });
            }

            // ใช้ transaction: ลบของ ts นี้ก่อน แล้วค่อยใส่ใหม่ (ป้องกันซ้ำ)
            await prisma.$transaction([
              prisma.inverterStringSnapshot.deleteMany({ where: { snapshotId: snap.id } }),
              prisma.inverterStringSnapshot.createMany({
                data: stringRows,
              }),
            ]);
          }
        }
      }

      console.log(`✅ Sync done for plant ${stationCode}`);
      await prisma.site.update({ where: { id: site.id }, data: { updatedAt: new Date() } });
    }

    console.log('✅ Sync tick done.');
  } catch (error: any) {
    console.error('❌ Sync Job Failed:', error?.message ?? error);
  }
};

export const syncInverterData = syncMonitoringTick;
