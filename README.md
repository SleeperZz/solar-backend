# Frontend API Documentation
- Homepage module (`/api/homepage`) สำหรับหน้า homepage
- Monitoring module (`/api/monitoring`) สำหรับหน้า monitoring - Home กับ InvwerterDetail
- Stock module (`/api/stock`) สำหรับระบบstock
**หมายเหตุalarm ยังดึงมาไม่ได้

## 0) Prerequisites

- **Node.js** แนะนำ `18+` (ควรเป็น LTS)
- **Docker + Docker Compose** (ใช้รัน PostgreSQL แบบง่ายที่สุด)
- DBeaver สำหรับดู database

## 1) Base Configuration วิธีรันโปรเจกต์
-ในvs code รัยคำสั่ง
  "npm install"
  "prisma generate"

-สร้าง .env
  "อยู่ใน discord"
-เปิดอีก terminal
  "docker compose up"
-รันโปรเจกต์
  "npm run dev"

**** แนะนำรันครั้งแรกปล่อยทิ้งไว้ 1-2 ชั่วโมงก่อน ให้ข้อมูลมันลง database ก่อนค่อยเรียกไป api มาใช้ ******

  Backend จะพร้อมใช้งานที่:
- Base URL: `http://localhost:3000`


### Response shape note

1. `homepage` and `stock` mostly return:
```json
{
  "success": true,
  "data": {}
}
```

2. `monitoring` returns:
```json
{
  "data": {}
}
```

Error payloads are not fully unified across all modules yet.

---

## 2) Homepage APIs (`/api/homepage`)

### 2.1 GET `/api/homepage/summary`

Use for dashboard pie/chart summary.

Query params: none

Success response:
```json
{
  "success": true,
  "data": {
    "plantStatus": {
      "normal": 3,
      "faulty": 1,
      "disconnected": 2
    },
    "activeAlarms": {
      "critical": 0,
      "major": 0,
      "minor": 0,
      "warning": 0,
      "supported": false
    },
    "notificationAlarms": []
  }
}
```

Notes:
- `activeAlarms` and `notificationAlarms` are currently placeholder values.
- `supported: false` means alarm sync is not fully enabled yet.

---

### 2.2 GET `/api/homepage/plants`

Use for homepage plant table.

Query params:
- `q` (optional): search by `name` or `plantCode`
- `page` (optional, default `1`)
- `pageSize` (optional, default `20`, min `10`, max `100`)

Success response:
```json
{
  "success": true,
  "data": {
    "list": [
      {
        "siteId": 1,
        "plantCode": "PLANT-001",
        "plantName": "Solar Farm A",
        "address": "Bangkok",
        "status": "Normal",
        "gridConnectionDate": null,
        "totalStringCapacityKWp": 500,
        "optimizerQuantity": null,
        "currentPowerKW": 42.123,
        "specificEnergyKWhPerKWp": 1.2345,
        "yieldTodayKWh": 617.5,
        "totalYieldKWh": null,
        "performanceRatio": null,
        "lastUpdatedAt": "2026-02-03T01:00:00.000Z"
      }
    ],
    "pagination": {
      "page": 1,
      "pageSize": 20,
      "total": 1,
      "totalPages": 1
    }
  }
}
```

Notes:
- `gridConnectionDate`, `optimizerQuantity`, `totalYieldKWh`, `performanceRatio` are currently `null` placeholders.

---

## 3) Monitoring APIs (`/api/monitoring`)

### 3.1 GET `/api/monitoring/sites`

Use to list all sites for monitoring screens.

Success response:
```json
{
  "data": [
    {
      "id": 1,
      "plantCode": "PLANT-001",
      "name": "Solar Farm A",
      "capacityKWp": 500,
      "address": "Bangkok",
      "latitude": 13.7,
      "longitude": 100.5,
      "updatedAt": "2026-02-03T01:00:00.000Z"
    }
  ]
}
```

---

### 3.2 GET `/api/monitoring/sites/:siteId/overview`

Use for site overview page (site info + inverter list + recent daily energy).

Path params:
- `siteId` (required, number)

Success response:
```json
{
  "data": {
    "site": {
      "id": 1,
      "plantCode": "PLANT-001",
      "name": "Solar Farm A",
      "capacityKWp": 500
    },
    "inverters": [
      {
        "id": 10,
        "name": "INV-1",
        "model": "SUN2000",
        "serialNumber": "SN-ABC",
        "activePower": 8.2,
        "lastDailyEnergy": 34.5,
        "status": "Normal",
        "lastSyncAt": "2026-02-03T01:00:00.000Z"
      }
    ],
    "energySeries": [
      {
        "date": "2026-02-01T00:00:00.000Z",
        "yieldKWh": 613.5
      }
    ],
    "lastUpdatedAt": "2026-02-03T01:05:00.000Z"
  }
}
```

Errors:
- `400` invalid `siteId`
- `404` site not found

---

### 3.3 GET `/api/monitoring/inverters/:inverterId`

Use for inverter detail header/realtime summary.

Path params:
- `inverterId` (required, number)

Success response:
```json
{
  "data": {
    "id": 10,
    "name": "INV-1",
    "model": "SUN2000",
    "serialNumber": "SN-ABC",
    "stationCode": "ST-001",
    "site": {
      "id": 1,
      "name": "Solar Farm A",
      "plantCode": "PLANT-001"
    },
    "realtime": {
      "activePower": 8.2,
      "dayEnergy": 34.5,
      "status": "Normal",
      "lastSyncAt": "2026-02-03T01:00:00.000Z"
    }
  }
}
```

Errors:
- `400` invalid `inverterId`
- `404` inverter not found

---

### 3.4 GET `/api/monitoring/inverters/:inverterId/strings/latest`

Use for latest string table.

Path params:
- `inverterId` (required, number)

Success response:
```json
{
  "data": {
    "ts": "2026-02-03T01:00:00.000Z",
    "strings": [
      { "stringNo": 1, "voltage": 450.2, "current": 9.5, "status": "Normal" }
    ]
  }
}
```

If no snapshot exists:
```json
{
  "data": {
    "ts": null,
    "strings": []
  }
}
```

---

### 3.5 GET `/api/monitoring/inverters/:inverterId/history`

Use for line charts.

Path params:
- `inverterId` (required, number)

Query params:
- `metric` (optional, default `activePower`)
  - allowed: `activePower`, `dayEnergy`, `temperature`, `powerFactor`
- `range` (optional, default `day`)
  - allowed: `day`, `week`, `month`

Success response:
```json
{
  "data": {
    "metric": "activePower",
    "range": "day",
    "series": [
      { "t": "2026-02-03T00:00:00.000Z", "v": 2.3 },
      { "t": "2026-02-03T00:05:00.000Z", "v": 2.8 }
    ]
  }
}
```

Errors:
- `400` invalid `inverterId`
- `400` invalid `range`
- `400` invalid `metric`

---

## 4) Stock APIs (`/api/stock`)

### 4.1 Recommended frontend mapping by page

- All Stock page:
  - `GET /api/stock/meta`
  - `GET /api/stock/summary`
- Add Product modal:
  - `GET /api/stock/meta` (dropdown source)
  - `POST /api/stock/products`
- Stock In page:
  - `GET /api/stock/meta` or `GET /api/stock/products`
  - `GET /api/stock/in`
  - `POST /api/stock/in`
- Stock Out page:
  - `GET /api/stock/meta` or `GET /api/stock/products?availableOnly=true`
  - `GET /api/stock/out`
  - `POST /api/stock/out`

---

### 4.2 GET `/api/stock/meta`

Returns category/unit/product dropdown data.

Query params:
- `includeInactive` (optional: `true|false`, default `false`)

Success response:
```json
{
  "success": true,
  "data": {
    "categories": [{ "id": 1, "name": "Spare Parts" }],
    "units": [{ "id": 1, "name": "pcs" }],
    "products": [
      {
        "id": 1,
        "sku": "SKU-001",
        "name": "MC4 Connector",
        "categoryId": 1,
        "category": "Spare Parts",
        "unitId": 1,
        "unit": "pcs",
        "inQty": 20,
        "outQty": 5,
        "onHand": 15,
        "isActive": true
      }
    ]
  }
}
```

---

### 4.3 Category master

#### GET `/api/stock/categories`
#### POST `/api/stock/categories`
Body:
```json
{ "name": "Spare Parts" }
```

#### PATCH `/api/stock/categories/:id`
Body:
```json
{ "name": "Updated Name" }
```

#### DELETE `/api/stock/categories/:id`

Notes:
- DELETE fails with `400` if category is used by products.

---

### 4.4 Unit master

#### GET `/api/stock/units`
#### POST `/api/stock/units`
Body:
```json
{ "name": "pcs" }
```

#### PATCH `/api/stock/units/:id`
Body:
```json
{ "name": "box" }
```

#### DELETE `/api/stock/units/:id`

Notes:
- DELETE fails with `400` if unit is used by products.

---

### 4.5 Products

#### GET `/api/stock/products`

Query params (all optional):
- `q`, `sku`, `name`
- `productId`, `categoryId`, `unitId`
- `includeInactive` (`true|false`, default `false`)
- `availableOnly` (`true|false`, default `false`)

Response item:
```json
{
  "productId": 1,
  "sku": "SKU-001",
  "categoryId": 1,
  "category": "Spare Parts",
  "name": "MC4 Connector",
  "unitId": 1,
  "unit": "pcs",
  "inQty": 20,
  "outQty": 5,
  "onHand": 15,
  "isActive": true
}
```

#### POST `/api/stock/products`

Required body:
```json
{
  "sku": "SKU-001",
  "name": "MC4 Connector",
  "categoryId": 1,
  "unitId": 1
}
```

Optional body:
- `isActive` (`true|false`, default `true`)

#### PATCH `/api/stock/products/:id`

At least one field required:
- `sku`, `name`, `categoryId`, `unitId`, `isActive`

---

### 4.6 GET `/api/stock/summary`

Use for All Stock table.

Query params:
- Pagination:
  - `page` (default `1`)
  - `pageSize` (default `20`, max `100`)
- Product filters:
  - `q`, `sku`, `name`, `productId`, `categoryId`, `unitId`
  - `includeInactive` (`true|false`, default `false`)
- Numeric filters:
  - `inQtyMin`, `inQtyMax`
  - `outQtyMin`, `outQtyMax`
  - `onHandMin`, `onHandMax`

Success response:
```json
{
  "success": true,
  "data": {
    "list": [
      {
        "productId": 1,
        "sku": "SKU-001",
        "categoryId": 1,
        "category": "Spare Parts",
        "name": "MC4 Connector",
        "unitId": 1,
        "unit": "pcs",
        "inQty": 20,
        "outQty": 5,
        "onHand": 15,
        "isActive": true
      }
    ],
    "pagination": {
      "page": 1,
      "pageSize": 20,
      "total": 1,
      "totalPages": 1
    }
  }
}
```

---

### 4.7 Stock In

#### GET `/api/stock/in`

Use for Stock In list page.

Query params:
- Pagination: `page`, `pageSize`
- Product filters: `q`, `sku`, `name`, `productId`, `categoryId`, `unitId`, `includeInactive`
- Transaction filters:
  - `dateFrom`, `dateTo`
  - `quantityMin`, `quantityMax`
  - `project`, `receiver`, `vendor`, `insuranceCompany`, `insuranceNo`, `note`

Response list item:
```json
{
  "id": 10,
  "type": "IN",
  "txDate": "2026-02-03T01:00:00.000Z",
  "productId": 1,
  "sku": "SKU-001",
  "categoryId": 1,
  "category": "Spare Parts",
  "productName": "MC4 Connector",
  "unitId": 1,
  "unit": "pcs",
  "quantity": 20,
  "inQty": 20,
  "outQty": 0,
  "onHand": 15,
  "project": "Project A",
  "receiver": "Somchai",
  "vendor": "Supplier X",
  "insuranceCompany": "Insure Co",
  "insuranceNo": "INS-001",
  "note": "Initial stock in",
  "createdAt": "2026-02-03T01:00:00.000Z",
  "updatedAt": "2026-02-03T01:00:00.000Z"
}
```

#### POST `/api/stock/in`

Required body:
```json
{
  "productId": 1,
  "quantity": 20
}
```

Optional body:
- `txDate`, `project`, `receiver`, `vendor`, `insuranceCompany`, `insuranceNo`, `note`, `jobId`

---

### 4.8 Stock Out

#### GET `/api/stock/out`

Same query model and response shape as Stock In, but:
- `type` is `OUT`
- `inQty` is `0`
- `outQty` is transaction quantity

#### POST `/api/stock/out`

Required body:
```json
{
  "productId": 1,
  "quantity": 5
}
```

Optional body:
- `txDate`, `project`, `receiver`, `vendor`, `insuranceCompany`, `insuranceNo`, `note`, `jobId`

Important validation:
- Returns `400` when `quantity > onHand` with message:
  - `insufficient stock: onHand=<number>`

---

## 5) Common Error Cases (Frontend Handling)

- `400` validation error:
  - invalid IDs
  - invalid date/range
  - missing required fields
- `404` not found:
  - product/site/inverter not found
- `409` duplicate value:
  - duplicate unique fields (for example category name, unit name, or product SKU)
- `500` internal server error

Recommended frontend handling:
- If HTTP status >= 400, read both:
  - `message` (stock/homepage)
  - `error` (monitoring)

