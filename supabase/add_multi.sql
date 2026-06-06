-- Allow multiple check-ins per day (drop the one-per-day unique constraint)
alter table checkins drop constraint if exists checkins_checkin_date_nickname_key;
