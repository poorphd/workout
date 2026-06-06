-- Add optional workout type/description to check-ins (run on an existing DB)
alter table checkins add column if not exists workout text;
