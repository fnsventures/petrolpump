# Day closing

Day closing reconciles one business date's money:

```
Today's short = (Total sale + Collection + Short previous)
              − (Night cash + Phone pay + Credit today + Expenses today)
```

A positive result is a shortage (money not accounted for). A negative result is a surplus. The supervisor types Night cash and Phone pay. The server computes every other figure in `compute_day_closing_components`, and `day_closing.short_today` becomes the next day's `short_previous`.

Frontend: `js/day-closing.js` (page `day-closing.html`, sections `#close` and `#register`).

A save that the page rejects, or a short that no longer matches the books: [When a day will not close](#when-a-day-will-not-close).

## Finding the live definition

These functions have been redefined many times with `create or replace`. The migration that sorts last by filename is the one running in prod. **Match `create function`, not the name.** `grant`, `comment on function`, and callers all contain `function public.<name>`, so a looser grep returns a file that does not hold the body. For `set_day_closing_certified` that file is `20260920120000` (a comment only); the body is still `20260817120000`.

```sh
fn=compute_day_closing_components
grep -lE "create( or replace)? function public\.$fn\b" supabase/migrations/* | sort | tail -1
```

`20261006054630_money_write_integrity` does not redefine any function in the table below. It calls `apply_credit_payment_to_day_closing` from the new `record_credit_payment`, and `raise_if_day_closing_certified` from the money RPCs and from `ledger_guard_certified_day` / `dsr_validate_meter_row`. It checks "today" with `meter_station_today()` (IST) on credit, expenses, salary, and invoices. Those RPCs, plus `ledger_guard_certified_day` (expenses, credit sales, payments) and `dsr_validate_meter_row`, call `raise_if_day_closing_certified`. An uncertified saved closing is then refreshed by `refresh_open_day_closing`.

| Function | Definitions | Current definition |
|---|---|---|
| `compute_day_closing_components(date)` | 14 | `20260826150000_day_closing_open_credit_sync.sql` |
| `get_day_closing_breakdown(date)` | 23 | `20260920120000_day_closing_certified_hard_lock.sql` |
| `save_day_closing(date, numeric, numeric, text)` | 13 | `20260920120000_day_closing_certified_hard_lock.sql` |
| `sync_saved_day_closing_for_date(date)` | 5 | `20260920120000_day_closing_certified_hard_lock.sql` |
| `recascade_day_closing_short_from(date)` | 4 | `20260920120000_day_closing_certified_hard_lock.sql` |
| `apply_credit_payment_to_day_closing(date, bool, text, numeric)` | 2 | `20260920120000_day_closing_certified_hard_lock.sql` |
| `delete_day_closing(uuid)` | 3 | `20260920120000_day_closing_certified_hard_lock.sql` |
| `day_closing_block_collected_mutation()` (trigger) | 3 | `20260920120000_day_closing_certified_hard_lock.sql` |
| `raise_if_day_closing_certified(date)` | 1 | `20260920120000_day_closing_certified_hard_lock.sql` |
| `set_day_closing_certified(date, boolean)` | 1 | `20260817120000_day_closing_certify.sql` |
| `day_closing_updated_at()` (trigger) | 1 | `20250130100000_day_closing_and_credit_payments.sql` |

## `compute_day_closing_components(p_date)`: what it computes

The function is `stable security definer` and calls `require_staff_access()`. It returns jsonb with no rounding (values are plain `numeric`).

| Key | Source and formula |
|---|---|
| `total_sale` | `dsr`, one row per product for the date (`distinct on (product)`, latest `created_at`/`id`). `Σ total_sales × petrol_rate` (petrol) or `× diesel_rate` (diesel). Uses gross litres, so testing is included. |
| `collection` | `credit_payments` dated `p_date` with `same_day_settlement = false`, all modes (Cash/UPI/Bank). |
| `short_previous` | `day_closing.short_today` for `p_date − 1 day`, or 0 if that row is missing. |
| `credit_today` | open credit + legacy credit. Per customer, open credit = `credit_entries(transaction_date = p_date)` − `least(same-day payments, that customer's credit today)`, floored at 0 overall. Legacy credit = `credit_customers.amount_due` where `date = p_date` and the customer has no `credit_entries`. |
| `expenses_today` | `Σ expenses.amount` for the date (all expenses, shift and book). |
| `credit_shift_gross` | today's credit entries that have `employee_id` and `shift` (gross, used for shift short). |
| `credit_shift` / `credit_ledger` | `credit_shift = least(credit_shift_gross, open credit)`; `credit_ledger = credit_today − credit_shift`. Display split only. |
| `expenses_shift` / `expenses_ledger` | Expenses with `employee_id` and `shift`, and the rest. Display split only. |
| `shift_cash_total`, `shift_phone_pay_total` | `Σ meter_shift_cash.cash_collected / phone_pay` for `reading_date = p_date`. |
| `same_day_settle[_cash/_upi/_bank]` | Payments flagged `same_day_settlement`, total and per mode. Mode matching is case-insensitive; a null mode counts as Cash. |
| `settle_cash_total`, `settle_upi_total` | All Cash / UPI payments on the date (same-day and collection). |
| `suggested_night_cash` / `suggested_phone_pay` | `shift_cash_total + settle_cash_total` / `shift_phone_pay_total + settle_upi_total`. Shown as a hint only; the UI never prefills it. |

The main design rule: a same-day settlement (a credit sale paid back on the same day, with the checkbox ticked) is removed from both Collection and Credit today. Its Cash/UPI money shows up on the right-hand side through Night cash / Phone pay instead.

## Related RPCs (current behaviour)

- **`get_day_closing_breakdown`** returns the components plus the saved row state: `already_saved`, `can_overwrite`, `certified`, `night_cash_collected`, `saved_*`, and `suggested_*`. If the row is saved and cannot be overwritten, it returns the frozen snapshot of the left-hand figures (`snapshot: true`).
- **`save_day_closing`** works as an upsert per date (`day_closing.date` is unique). The first save inserts the row with reference `DC-YYYY-NNNNN`, numbered per year. Later saves overwrite the row in place, keep the reference, and call `recascade_day_closing_short_from`. It rejects certified rows, and rejects collected rows for non-admins. Client insert and update on `day_closing` are denied, so a console write cannot store night cash or short without this function. Client delete is denied; `delete_day_closing` is the only delete.
- **`recascade_day_closing_short_from(d)`** recomputes every later row in date order using its stored night cash / phone pay. It skips certified rows.
- **`sync_saved_day_closing_for_date`** refreshes a saved snapshot from live books after a credit delete, and after a ledger or meter write on an uncertified day (`refresh_open_day_closing`), then recascades.
- **`apply_credit_payment_to_day_closing`** is called by `record_credit_payment` and refreshes the saved row. For a same-day settlement it also adds the amount to `night_cash` (Cash) or `phone_pay` (UPI); Bank adds nothing.
- **`delete_day_closing`** is admin-only. It deletes only the latest closing, and only if it is not certified or collected.
- **`set_day_closing_certified`** is admin-only. It certifies (records name and time) or revokes. While a row is certified, `day_closing_block_collected_mutation` and `raise_if_day_closing_certified` block figure changes, including by admin. `ledger_guard_certified_day` rejects expenses, credit sales, and payments on that date (settling an older sale may still update `amount_settled`). `expenses_guard_shift_write` also blocks a supervisor from adding, changing, or deleting a shift-attributed expense once day closing is saved, before certification. A book expense with no shift still refreshes an uncertified saved closing. `dsr_validate_meter_row` rejects meter edits, including by admin. Linking a night-cash collection is still allowed.

## When a day will not close

Read the message on the page. It is the exception from the database. `save_day_closing` is the write. Client update is denied, and a SQL update skips the short chain.

| The page says | What is true | What to do |
|---|---|---|
| Certified and locked | `day_closing.certified` is true. Meters, expenses, credit sales, payments, and the closing are frozen, including for admin. | An admin revokes (`set_day_closing_certified(date, false)`), the books are corrected, the day is saved again, then certified again. |
| Night cash was collected. Only an admin can modify it | `night_cash_collection_id` is set. A supervisor cannot overwrite. | An admin can still **Save changes** while the day is not certified. The typed night cash and phone pay are what get stored. |
| Only the most recent day closing can be deleted | A later row exists. | Delete is the wrong tool. Overwrite the day, or delete later uncertified days first. |
| Night cash was collected. Remove the collection in the database first | Delete of a collected row. The collection link cannot be cleared, and the collection row cannot be deleted while a closing points at it (`on delete restrict`). | Leave the collection. Correct the figures with an admin save. |
| `night_cash` or `phone_pay` must be ≥ 0 | The typed amount was blank or negative. | Enter 0 or more. |
| Save day closing before certifying | There is no row yet, or the form has unsaved edits. | Save, then certify. |

A collected day that is also certified has to be revoked before that admin save. Delete stays refused.

### The figure on screen does not match the books

`get_day_closing_breakdown` returns `snapshot: true` when the row cannot be overwritten (certified, or collected and the caller is not an admin). Those left-hand numbers are the stored snapshot. Night cash and phone pay on a saved row are the typed amounts, not the suggestion.

Compare the live calculation with the stored row. The SQL editor has no login, so `require_staff_access()` allows it. A signed-in supervisor can call the same function.

```sql
select public.compute_day_closing_components('2026-10-12'::date);

select date, total_sale, collection, short_previous, night_cash, phone_pay,
       credit_today, expenses_today, short_today, certified, night_cash_collection_id
from public.day_closing
where date = '2026-10-12';
```

Check the component that differs against [what the function computes](#compute_day_closing_componentsp_date-what-it-computes):

- **Total sale** is 0 or low. There is no `dsr_petrol` or `dsr_diesel` row for that date, or the selling rate is null. Testing litres are included.
- **Credit today** is high, or **collection** includes a payment that was paid back the same day. `credit_payments.same_day_settlement` is false, so the payment stays in both. The flag, not the payment mode, decides. With the flag set, the cash or UPI is expected inside the typed Night cash or Phone pay.
- **Short previous** is 0. There is no `day_closing` row for the day before, or that row's `short_today` is null.
- **Expenses** look high. Every `expenses` row for the date counts, including salary.

An uncertified saved row is refreshed when that day's meters, credit, or expenses change (`refresh_open_day_closing`). A certified row is not. A collected row is refreshed only when the writer is an admin.

To store the live figures, save the day again. That recomputes the snapshot from the books and keeps the night cash and phone pay you type. The first save of a date does not walk forward. A second save does: `recascade_day_closing_short_from` rewrites later uncertified days and skips certified ones. It does not replace those days' typed night cash or phone pay.

### A later day's short is stale

`short_previous` is the previous row's stored `short_today`. A missing day in the chain contributes 0 until that day is saved **twice** (the second save is what walks forward). A certified day in the middle keeps its frozen short, and every open day after it inherits that frozen number. Revoke the certified day, save it again, then certify it. That save walks the open days after it.

## History of `compute_day_closing_components`

| Migration | Change |
|---|---|
| `20250527130000_backend_optimizations` | First shared version. `total_sale` = (total_sales − testing) × rate; collection = all payments; credit = entries + legacy. |
| `20260618110000_day_closing_include_testing` | `total_sale` uses gross `total_sales` (testing included). |
| `20260619100000_security_loophole_mitigation` | Adds `set search_path = public` and `require_staff_access()`. |
| `20260820160000_dsr_unique_date` | `distinct on (product)` latest DSR row, to guard against duplicate dates. |
| `20260823180000_meter_shift_cash_credit_expense` | Adds `meter_shift_cash` credit/expense to credit/expenses_today. This double-counted; it must be followed by 190000. |
| `20260823190000_shift_attributed_credit_expense` | Uses ledger rows only; shift credit/expense become a breakdown attributed by `employee_id`+`shift`. |
| `20260824195000_shift_resave_until_day_closing` | Adds `shift_cash_total` and `shift_phone_pay_total`. |
| `20260825160000_same_day_credit_settle_as_cash` | Same-day settle: payments cover the prior open balance first (FIFO), and the remainder nets today's credit. Adds `same_day_*` and `suggested_*`. |
| `20260825170000_fix_same_day_settle_night_cash_prefill` | Adds `settle_cash_total`/`settle_upi_total`; the suggestion now includes *all* Cash/UPI settlements. |
| `20260825180000_same_day_settle_lifo` | LIFO: same-day = `least(pay_today, credit_today)`; the prior balance is ignored. |
| `20260825190000_optimise_same_day_settle_lifo` | Grouped joins replace correlated subqueries; mode split rounded to 2 dp; legacy credit is not netted. |
| `20260825210000_consolidate_settle_night_cash_prefill` | Case-insensitive `payment_mode` matching. |
| `20260826140000_same_day_settlement_flag` | Same-day is now the explicit `credit_payments.same_day_settlement` flag rather than inferred; collection = unflagged payments. The proportional rounding is removed. |
| `20260826150000_day_closing_open_credit_sync` | **Current.** Introduces `v_open_credit`; `credit_shift` is clamped to open credit; exposes `credit_shift_gross`. |

Another 12 migrations only call or grant the function and do not redefine it: `20250527140000`, `20250527150000`, `20260618120000`, `20260618130000`, `20260618140000`, `20260704100000`, `20260705100000`, `20260705110000`, `20260817120000`, `20260825200000`, `20260825220000`, and `20260920120000`. Several of these redefine `get_day_closing_breakdown` and `save_day_closing` (see the table above).

## How to change it

1. Find the current definition with the grep above. Never edit an applied migration.
2. Create a new migration `supabase/migrations/<timestamp>_<name>.sql` with `create or replace function public.compute_day_closing_components(p_date date) ...`. **Copy the body from the current definition**, not from an older one. Older copies silently revert later fixes (see the note in `20260825200000` about RPCs "left on the old version").
3. Keep the signature `(date) returns jsonb`. Changing it needs `drop function`, and the `grant`/`comment` statements must be re-run.
4. If you add or rename a key, check `get_day_closing_breakdown`, which copies keys through explicitly, and `js/day-closing.js`.
5. If the short formula changes, update every place that repeats it: `save_day_closing`, `recascade_day_closing_short_from`, `sync_saved_day_closing_for_date`, `apply_credit_payment_to_day_closing`, and `computeDayClosingShort` in JS. Existing saved rows are snapshots; they change only when they are re-saved or synced.
