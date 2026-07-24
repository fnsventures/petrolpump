# DSR data model: petrol/diesel tables, union view, and computed stock

Part of the [Petrol Pump documentation](README.md). For all tables and flows, see [DATA_TABLES.md](DATA_TABLES.md) and [FLOWS.md](FLOWS.md).

## Summary

| Object | Type | Purpose | Written by |
|--------|------|---------|------------|
| **dsr_petrol** | Table | MS (petrol) meter readings — one row per date | Meter Reading form |
| **dsr_diesel** | Table | HSD (diesel) meter readings — one row per date | Meter Reading form |
| **dsr** | View | Union of both products (`product` = `petrol` \| `diesel`) for reads | — (SELECT only) |
| **dsr_stock** | View | Stock reconciliation derived from meter rows | — (computed) |
| **get_dsr_stock_range** | RPC | Same stock logic scoped to a date range | — |

**Recommendation:** Treat **dsr_petrol** and **dsr_diesel** as the source of truth. Use the **dsr** view when you need product-agnostic queries. Use **dsr_stock** (or `get_dsr_stock_range`) for opening/closing stock, dip, and variation — there is no separate stock table to maintain.

---

## dsr_petrol and dsr_diesel (base tables)

- **Role:** Daily meter readings per fuel: nozzle open/close, `total_sales`, `testing`, `dip_reading`, `stock` (dip litres), `receipts`, selling rates, `buying_price_per_litre` (admin), `tank_capacity`, remarks.
- **Written by:** The **Meter Reading** page (`meter-reading.html` → `js/meterReading.js`), which upserts into `dsr_petrol` or `dsr_diesel` by product.
- **Listed by:** The **DSR** page (`dsr.html` → `js/dsr.js`) for range summaries and stock views.
- **Used by:** Day closing (sales), dashboard (snapshot, P&amp;L section), analysis, reports (tank-wise DSR, purchase registers).

Each table has one row per **date** (not per pump). MS and HSD are stored separately so tank capacity and defaults can differ (e.g. 15KL vs 20KL).

---

## dsr (backward-compatible view)

```sql
-- Simplified: UNION ALL of dsr_petrol and dsr_diesel with product label
select ..., 'petrol' as product from dsr_petrol
union all
select ..., 'diesel' as product from dsr_diesel;
```

- **SELECT only** — inserts/updates must target `dsr_petrol` or `dsr_diesel`.
- Keeps older queries and docs that reference a single `dsr` relation working without duplicating data.

---

## dsr_stock (computed view)

Stock fields are **derived on read** from meter data:

- `dip_stock` ← `stock` on the meter row  
- `net_sale` ← `greatest(total_sales - testing, 0)`  
- `opening_stock` ← previous day’s `dip_stock` (window `LAG` per product)  
- `closing_stock`, `variation` ← formulas from opening, receipts, net sale, and dip  

There is **no** separate Stock form or `sync_dsr_receipts_from_stock` step. Entering dip/stock on the meter row is enough; reconciliation stays consistent.

**Dashboard / sales-daily:** Read from `dsr_stock` (or `get_dsr_stock_range(start, end)` for filtered periods). Tank fill % uses physical capacity from `pump_settings.config.pumps` (`petrol.tankCapacity` / `diesel.tankCapacity`). `reports.tanks` is one section per product (HSD + MS) for the tank-wise DSR printout.

**Tank-wise DSR report columns:** Open, Buy, **Short** (`max(0, variation)` = book − dip when books are higher), **Total** (open + buy − short), Test, Meter, Actual, Cum, Dip sale, Close, Var, CumV, Rate, **TVA** (configured capacity − closing dip).

---

## get_dsr_stock_range(start, end)

- Same reconciliation logic as the view, but `LAG(opening)` is scoped to **range + one prior day** per product (better for report date pickers).
- Prefer this RPC when loading a bounded period to avoid scanning full history.
- Requires provisioned staff (`require_staff_access()`).
- **Client:** `js/dsrQueries.js` provides `mergeDsrStock(dsrRows, stockRows)` to combine meter rows with stock fields for dashboard and reports.

---

## Why this design

| Approach | Benefit |
|----------|---------|
| Split petrol/diesel tables | Clear per-tank defaults; simpler forms; independent buying-price updates per product |
| Union `dsr` view | One API shape for “all products” reads |
| Computed `dsr_stock` | No duplicate stock rows; no sync jobs; variation always matches latest meter entry |

A future “single table with `product` column” would be equivalent to today’s view + two tables — only worth doing if you need cross-product constraints in one physical table.

---

## Related documentation

| Document | Description |
|----------|-------------|
| [Documentation index](README.md) | Doc portal and getting started |
| [Architecture](ARCHITECTURE.md) | Project structure, tech stack, security |
| [Data Tables](DATA_TABLES.md) | All tables, views, and RLS |
| [Flows](FLOWS.md) | Daily ops; meter → closing |
| [Development guide](DEVELOPMENT.md) | Local setup, deployment |
