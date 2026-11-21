-- Canonical definition of public.check_credit_balances. Edit here, then:
--   node scripts/sql-functions.mjs emit check_credit_balances
create or replace function public.check_credit_balances()
returns table (
  customer_id uuid,
  customer_name text,
  stored_due numeric,
  stored_prepaid numeric,
  book_due numeric,
  book_prepaid numeric,
  issue text
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can run the credit balance check';
  end if;

  return query
  with books as (
    select
      c.id,
      c.customer_name,
      c.amount_due as stored_due,
      c.prepaid_balance as stored_prepaid,
      coalesce(e.due, 0) as book_due,
      greatest(0, coalesce(p.paid, 0) - coalesce(e.settled, 0)) as book_prepaid
    from public.credit_customers c
    left join (
      select credit_customer_id,
             sum(amount - amount_settled) as due,
             sum(amount_settled) as settled
      from public.credit_entries
      where status = 'posted'
      group by credit_customer_id
    ) e on e.credit_customer_id = c.id
    left join (
      select credit_customer_id, sum(amount) as paid
      from public.credit_payments
      where status = 'posted'
      group by credit_customer_id
    ) p on p.credit_customer_id = c.id
  )
  select
    b.id,
    b.customer_name::text,
    b.stored_due,
    b.stored_prepaid,
    b.book_due,
    b.book_prepaid,
    case
      when b.stored_due > 0.009 and b.stored_prepaid > 0.009 then 'Owes money and holds advance'
      else 'Stored balance does not match entries'
    end
  from books b
  where abs(b.stored_due - b.book_due) > 0.009
     or abs(b.stored_prepaid - b.book_prepaid) > 0.009
     or (b.stored_due > 0.009 and b.stored_prepaid > 0.009)
  order by b.customer_name;
end;
$$;

grant execute on function public.check_credit_balances() to authenticated;
