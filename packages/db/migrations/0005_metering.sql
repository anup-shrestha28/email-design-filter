-- 0005 · Neon compute self-metering (FREE-TIER.md §8.1). Neon Free has no usage API, so the app
-- records the minutes in which it touched the database (plus the 5-minute idle tail) as a per-day
-- bitmap; every instance ORs its minutes in, so overlapping instances are never double-counted.
-- Awake CU-hours = bit_count(minutes) / 60 × 0.25 CU.
CREATE TABLE neon_awake (
  day      date PRIMARY KEY,
  minutes  bit(1440) NOT NULL DEFAULT repeat('0', 1440)::bit(1440)
);
GRANT SELECT ON neon_awake TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON neon_awake TO app_system;

CREATE FUNCTION public.mark_neon_awake(p_day date, p_minutes int[])
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v bit(1440) := repeat('0', 1440)::bit(1440); m int;
BEGIN
  IF p_minutes IS NULL OR cardinality(p_minutes) = 0 THEN RETURN; END IF;
  IF cardinality(p_minutes) > 1440 THEN RAISE EXCEPTION 'mark_neon_awake: too many minutes' USING ERRCODE = '22023'; END IF;
  FOREACH m IN ARRAY p_minutes LOOP
    IF m < 0 OR m > 1439 THEN RAISE EXCEPTION 'mark_neon_awake: minute out of range' USING ERRCODE = '22023'; END IF;
    v := set_bit(v, m, 1);
  END LOOP;
  INSERT INTO public.neon_awake AS n (day, minutes) VALUES (p_day, v)
    ON CONFLICT (day) DO UPDATE SET minutes = n.minutes | EXCLUDED.minutes;
  DELETE FROM public.neon_awake WHERE day < current_date - 100;
END $$;

GRANT app_system TO CURRENT_USER WITH SET TRUE;
GRANT CREATE ON SCHEMA public TO app_system;
ALTER FUNCTION public.mark_neon_awake(date, int[]) OWNER TO app_system;
REVOKE CREATE ON SCHEMA public FROM app_system;
REVOKE ALL ON FUNCTION public.mark_neon_awake(date, int[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_neon_awake(date, int[]) TO app_rw;
