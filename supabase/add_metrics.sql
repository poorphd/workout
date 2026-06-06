-- Add optional workout metrics to check-ins (run on an existing DB)
alter table checkins add column if not exists duration_min int;
alter table checkins add column if not exists calories int;
