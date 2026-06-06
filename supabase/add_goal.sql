-- Add the weekly goal column (run on an existing DB)
alter table members add column if not exists weekly_goal int;
