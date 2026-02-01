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
    const pageSize = 100;

    while (true) {
      const res = await huaweiService.stations({ pageNo, pageSize });

      if (!res?.success) {
        // ถ้า failCode=407 จะเด้งมาที่ catch แล้ว fallback
        throw new Error(`stations failed (failCode=${res?.failCode}): ${res?.message ?? 'unknown'}`);
      }

      const list: HuaweiStation[] = res?.data?.list ?? [];
      for (const st of list) {
        const code = pickStationCode(st);
        if (!code) continue;
        stationCodes.push(code);

        // upsert site (ทำเมื่อ refresh เท่านั้น ไม่ทำทุก tick)
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

      const pageCount = Number(res?.data?.pageCount ?? 1);
      if (pageNo >= pageCount) break;
      pageNo++;
    }

    const uniq = Array.from(new Set(stationCodes));

    // อัปเดต cache
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

    // ตั้ง cache สั้น ๆ (เช่น 10 นาที) กัน loop พยายามดึง stations ถี่ ๆ
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
    // ✅ ไม่เรียก stations ทุก tick แล้ว
    const stationCodes = await refreshStationsIfNeeded();

    if (!stationCodes || stationCodes.length === 0) {
      console.log('⚠️ No stations available (Huawei + DB).');
      return;
    }

    // เลือก site บางส่วนต่อ tick เพื่อลด request
    const sitesToSync = await prisma.site.findMany({
      orderBy: [
        { updatedAt: 'asc' },   // ตัวที่อัปเดตนานสุดมาก่อน
        { createdAt: 'asc' },    // tie-breaker
      ],
      take: MAX_PLANTS_PER_TICK,
    });

    if (sitesToSync.length === 0) {
      console.log('⚠️ No sites in DB.');
      return;
    }

    for (const site of sitesToSync) {
      const stationCode = site.plantCode;
      console.log(`🔁 Sync plant ${stationCode} (${site.name ?? ''})`);

      // (A) station real KPI (optional)
      try {
        const end2 = await huaweiService.getStationRealKpi(stationCode);
        if (!end2?.success) {
          console.warn('⚠️ getStationRealKpi failed:', {
            failCode: end2?.failCode,
            message: end2?.message,
            params: end2?.params,
          });
        }
      } catch (e: any) {
        console.warn('⚠️ getStationRealKpi error (skip):', e?.message ?? e);
      }

      // (B) getDevList
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

      // (C) getDevRealKpi (batch)
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

            const inv = await prisma.inverter.findFirst({
              where: { huaweiDevId: devId, siteId: site.id },
            });
            if (!inv) continue;

            await prisma.inverter.update({
              where: { id: inv.id },
              data: {
                activePower,
                lastDailyEnergy: dayEnergy ?? inv.lastDailyEnergy,
                status: runState === 0 ? 'Normal' : runState == null ? inv.status : 'Fault',
                lastSyncAt: new Date(),
              },
            });
          }
        }
      }

      console.log(`✅ Sync done for plant ${stationCode}`);

      await prisma.site.update({ where: { id: site.id }, data: { updatedAt: new Date() }, });

    }

    console.log('✅ Sync tick done.');
  } catch (error: any) {
    console.error('❌ Sync Job Failed:', error?.message ?? error);
  }
};

export const syncInverterData = syncMonitoringTick;
