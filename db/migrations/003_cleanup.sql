-- 30 dakikadan uzun süre 'waiting' durumunda kalan lobileri siler.
-- Bağlı oyuncu kayıtları ON DELETE CASCADE ile silinir.

create or replace function public.cleanup_stale_lobbies()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.games
  where status = 'waiting'
    and created_at < now() - interval '30 minutes';

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- Yalnızca sahibi (ve zamanlayıcı) çalıştırabilir, istemciden çağrılamaz.
revoke all on function public.cleanup_stale_lobbies() from public, anon, authenticated;

create index if not exists games_waiting_created_at_idx
  on public.games (created_at)
  where status = 'waiting';

create extension if not exists pg_cron;

select cron.schedule(
  'cleanup-stale-lobbies',
  '*/10 * * * *',
  $$select public.cleanup_stale_lobbies()$$
);
