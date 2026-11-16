-- Private, durable mail for installations explicitly using EMAIL_DRIVER=mock.
-- Bodies contain bearer links: access is through authenticated admin routes.
create table public.mock_email_requests (
  id uuid primary key,
  idempotency_key text unique,
  fingerprint text not null
);

create table public.mock_email_outbox (
  sequence bigserial primary key,
  id text not null unique,
  request_id uuid not null references public.mock_email_requests(id),
  position integer not null,
  created_at timestamptz not null default now(),
  from_address text not null check (octet_length(from_address) <= 1024),
  to_address text not null check (octet_length(to_address) <= 1024),
  reply_to text check (octet_length(reply_to) <= 1024),
  subject text not null check (octet_length(subject) <= 4096),
  template text not null,
  text_body text not null check (octet_length(text_body) <= 1048576),
  html_body text check (octet_length(html_body) <= 1048576),
  attachments jsonb not null default '[]'::jsonb
    check (jsonb_typeof(attachments) = 'array' and octet_length(attachments::text) <= 65536),
  unique (request_id, position)
);

revoke all on public.mock_email_requests from public;
revoke all on public.mock_email_outbox from public;
revoke all on sequence public.mock_email_outbox_sequence_seq from public;
