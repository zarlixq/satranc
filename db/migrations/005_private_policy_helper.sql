-- RLS yardımcı fonksiyonu API'den çağrılabilir olmasın: PostgREST'in yayınlamadığı
-- bir şemaya taşınır. Policy'ler onu hâlâ çalıştırabilir.

create schema if not exists private;

revoke all on schema private from public;
grant usage on schema private to authenticated;

create or replace function private.is_game_player(p_game_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.game_players
    where game_id = p_game_id and user_id = auth.uid()
  );
$$;

revoke all on function private.is_game_player(uuid) from public, anon;
grant execute on function private.is_game_player(uuid) to authenticated;

drop policy if exists games_select_own on public.games;
create policy games_select_own on public.games
  for select to authenticated using (private.is_game_player(id));

drop policy if exists game_players_select_own on public.game_players;
create policy game_players_select_own on public.game_players
  for select to authenticated using (private.is_game_player(game_id));

drop policy if exists game_dice_rolls_select_own on public.game_dice_rolls;
create policy game_dice_rolls_select_own on public.game_dice_rolls
  for select to authenticated using (private.is_game_player(game_id));

drop policy if exists game_moves_select_own on public.game_moves;
create policy game_moves_select_own on public.game_moves
  for select to authenticated using (private.is_game_player(game_id));

drop function if exists public.is_game_player(uuid);
