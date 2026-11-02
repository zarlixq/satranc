-- Zarlı Satranç: ilk şema (PostgreSQL / Supabase)
-- Tek seferde çalıştırılır, tekrar çalıştırmak güvenlidir (idempotent).
-- Ayrıntılar: db/SCHEMA.md
--
-- Yazma modeli: istemci tablolara doğrudan yazamaz. Tüm yazmalar aşağıdaki
-- SECURITY DEFINER fonksiyonlarından geçer; sıra, üyelik ve hamle numarası
-- kontrolleri orada, satır kilidi altında ve tek transaction içinde yapılır.

begin;

-- ---------------------------------------------------------------------------
-- Enum'lar
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.game_status as enum ('waiting', 'active', 'finished', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.game_color as enum ('w', 'b');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.piece_type as enum ('p', 'n', 'b', 'r', 'q', 'k');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.promotion_piece as enum ('n', 'b', 'r', 'q');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.game_result_reason as enum (
    'checkmate', 'stalemate', 'draw', 'resign', 'timeout', 'abandon'
  );
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Tablolar
-- ---------------------------------------------------------------------------

create table if not exists public.games (
  id                 uuid primary key default gen_random_uuid(),
  created_by         uuid references auth.users (id) on delete set null,
  lobby_code         text not null unique,
  status             public.game_status not null default 'waiting',
  fen                text not null default 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  current_turn       public.game_color not null default 'w',
  allowed_piece_type public.piece_type,
  winner_user_id     uuid references auth.users (id) on delete set null,
  result_reason      public.game_result_reason,
  move_count         integer not null default 0,
  started_at         timestamptz,
  finished_at        timestamptz,
  last_move_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint games_lobby_code_format check (lobby_code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  constraint games_move_count_positive check (move_count >= 0),
  constraint games_finished_has_result check (
    status <> 'finished' or (result_reason is not null and finished_at is not null)
  ),
  constraint games_roll_only_when_active check (
    status = 'active' or allowed_piece_type is null
  ),
  constraint games_winner_only_when_finished check (
    winner_user_id is null or status = 'finished'
  )
);

create table if not exists public.game_players (
  id         uuid primary key default gen_random_uuid(),
  game_id    uuid not null references public.games (id) on delete cascade,
  user_id    uuid references auth.users (id) on delete set null,
  color      public.game_color not null,
  is_host    boolean not null default false,
  joined_at  timestamptz not null default now(),
  created_at timestamptz not null default now(),

  -- İki renk olduğu için bu kısıt oyuncu sayısını da en fazla 2 ile sınırlar.
  constraint game_players_game_color_key unique (game_id, color),
  constraint game_players_game_user_key unique (game_id, user_id)
);

-- Her satır bir hamlenin zarıdır: move_number, zarın belirlediği hamlenin numarası.
create table if not exists public.game_dice_rolls (
  id                bigint generated always as identity primary key,
  game_id           uuid not null references public.games (id) on delete cascade,
  move_number       integer not null,
  color             public.game_color not null,
  rolled_by         uuid references auth.users (id) on delete set null,
  rolled_piece_type public.piece_type not null,
  legal_piece_types public.piece_type[] not null,
  created_at        timestamptz not null default now(),

  constraint game_dice_rolls_game_move_key unique (game_id, move_number),
  constraint game_dice_rolls_move_number_positive check (move_number > 0),
  constraint game_dice_rolls_rolled_is_legal check (rolled_piece_type = any (legal_piece_types))
);

create table if not exists public.game_moves (
  id                 bigint generated always as identity primary key,
  game_id            uuid not null references public.games (id) on delete cascade,
  user_id            uuid references auth.users (id) on delete set null,
  move_number        integer not null,
  color              public.game_color not null,
  piece_type         public.piece_type not null,
  allowed_piece_type public.piece_type not null,
  from_square        text not null,
  to_square          text not null,
  promotion          public.promotion_piece,
  san                text,
  uci                text,
  fen_before         text not null,
  fen_after          text not null,
  created_at         timestamptz not null default now(),

  constraint game_moves_game_move_key unique (game_id, move_number),
  constraint game_moves_move_number_positive check (move_number > 0),
  constraint game_moves_piece_matches_roll check (piece_type = allowed_piece_type),
  constraint game_moves_from_square_format check (from_square ~ '^[a-h][1-8]$'),
  constraint game_moves_to_square_format check (to_square ~ '^[a-h][1-8]$'),
  -- Zarsız hamle kaydedilemez.
  constraint game_moves_roll_fkey foreign key (game_id, move_number)
    references public.game_dice_rolls (game_id, move_number) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Index'ler (game_id sorguları unique kısıtların index'lerini kullanır)
-- ---------------------------------------------------------------------------

create index if not exists game_players_user_id_idx on public.game_players (user_id);
create index if not exists games_created_by_idx on public.games (created_by);
create index if not exists games_winner_user_id_idx on public.games (winner_user_id);
create index if not exists game_moves_user_id_idx on public.game_moves (user_id);
create index if not exists game_dice_rolls_rolled_by_idx on public.game_dice_rolls (rolled_by);

-- ---------------------------------------------------------------------------
-- updated_at tetikleyicisi
-- ---------------------------------------------------------------------------

create or replace function public.games_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists games_set_updated_at on public.games;
create trigger games_set_updated_at
  before update on public.games
  for each row execute function public.games_set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: oyuncu sadece kendi oyunlarını okur, doğrudan yazma yoktur
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER: game_players policy'si kendi tablosunu sorguladığı için
-- aksi halde sonsuz özyinelemeye düşerdi.
create or replace function public.is_game_player(p_game_id uuid)
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

alter table public.games enable row level security;
alter table public.game_players enable row level security;
alter table public.game_dice_rolls enable row level security;
alter table public.game_moves enable row level security;

drop policy if exists games_select_own on public.games;
create policy games_select_own on public.games
  for select to authenticated using (public.is_game_player(id));

drop policy if exists game_players_select_own on public.game_players;
create policy game_players_select_own on public.game_players
  for select to authenticated using (public.is_game_player(game_id));

drop policy if exists game_dice_rolls_select_own on public.game_dice_rolls;
create policy game_dice_rolls_select_own on public.game_dice_rolls
  for select to authenticated using (public.is_game_player(game_id));

drop policy if exists game_moves_select_own on public.game_moves;
create policy game_moves_select_own on public.game_moves
  for select to authenticated using (public.is_game_player(game_id));

revoke all on table public.games, public.game_players, public.game_dice_rolls, public.game_moves
  from public, anon, authenticated;
grant select on table public.games, public.game_players, public.game_dice_rolls, public.game_moves
  to authenticated;

-- ---------------------------------------------------------------------------
-- Yazma fonksiyonları (RPC)
-- Hata metinleri arayüzde olduğu gibi gösterilir.
-- ---------------------------------------------------------------------------

-- Lobi ve host oyuncuyu birlikte oluşturur. Kod çakışırsa 23505 döner, istemci
-- yeni kodla tekrar dener.
create or replace function public.create_game(p_lobby_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_game public.games;
  v_player public.game_players;
begin
  if v_uid is null then
    raise exception 'Oturum bulunamadı.';
  end if;

  insert into public.games (created_by, lobby_code)
  values (v_uid, p_lobby_code)
  returning * into v_game;

  insert into public.game_players (game_id, user_id, color, is_host)
  values (v_game.id, v_uid, 'w', true)
  returning * into v_player;

  return jsonb_build_object('game', to_jsonb(v_game), 'player', to_jsonb(v_player));
end;
$$;

-- Oyunu kilitleyerek katılır: aynı anda gelen iki katılım aynı rengi alamaz.
-- İkinci oyuncu girince oyun başlar. Zaten oyuncuysa mevcut kaydı döner.
create or replace function public.join_game(p_game_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_game public.games;
  v_player public.game_players;
  v_count integer;
  v_color public.game_color;
begin
  if v_uid is null then
    raise exception 'Oturum bulunamadı.';
  end if;

  select * into v_game from public.games where id = p_game_id for update;
  if not found then
    raise exception 'Oyun bulunamadı.';
  end if;

  select * into v_player from public.game_players
  where game_id = p_game_id and user_id = v_uid;
  if found then
    return jsonb_build_object(
      'game', to_jsonb(v_game), 'player', to_jsonb(v_player), 'activated', false
    );
  end if;

  if v_game.status <> 'waiting' then
    raise exception 'Bu lobi artık katılıma açık değil.';
  end if;

  select count(*) into v_count from public.game_players where game_id = p_game_id;
  if v_count >= 2 then
    raise exception 'Lobi dolu.';
  end if;

  if not exists (select 1 from public.game_players where game_id = p_game_id and color = 'w') then
    v_color := 'w';
  else
    v_color := 'b';
  end if;

  insert into public.game_players (game_id, user_id, color, is_host)
  values (p_game_id, v_uid, v_color, false)
  returning * into v_player;

  if v_count + 1 = 2 then
    update public.games
    set status = 'active', started_at = now(), current_turn = 'w', allowed_piece_type = null
    where id = p_game_id
    returning * into v_game;
  end if;

  return jsonb_build_object(
    'game', to_jsonb(v_game), 'player', to_jsonb(v_player), 'activated', v_count + 1 = 2
  );
end;
$$;

-- Kodla bulma buradadır çünkü RLS, oyuncusu olunmayan oyunun okunmasına izin vermez.
create or replace function public.join_game_by_code(p_lobby_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Oturum bulunamadı.';
  end if;

  select id into v_game_id from public.games where lobby_code = p_lobby_code;
  if not found then
    raise exception 'Bu kodla bir lobi bulunamadı.';
  end if;

  return public.join_game(v_game_id);
end;
$$;

-- Turun zarını kaydeder. Zar zaten atılmışsa oyunu değiştirmeden döner.
create or replace function public.save_dice_roll(
  p_game_id uuid,
  p_move_number integer,
  p_rolled_piece_type public.piece_type,
  p_legal_piece_types public.piece_type[]
)
returns public.games
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_game public.games;
  v_color public.game_color;
begin
  if v_uid is null then
    raise exception 'Oturum bulunamadı.';
  end if;

  select * into v_game from public.games where id = p_game_id for update;
  if not found then
    raise exception 'Oyun bulunamadı.';
  end if;

  select color into v_color from public.game_players
  where game_id = p_game_id and user_id = v_uid;
  if not found then
    raise exception 'Bu oyunun oyuncusu değilsin.';
  end if;

  if v_game.status <> 'active' then
    raise exception 'Oyun aktif değil.';
  end if;
  if v_game.current_turn <> v_color then
    raise exception 'Sıra sende değil.';
  end if;
  if v_game.allowed_piece_type is not null then
    return v_game;
  end if;
  if p_move_number <> v_game.move_count + 1 then
    raise exception 'Oyun durumu değişti, sayfayı yenile.';
  end if;

  insert into public.game_dice_rolls (
    game_id, move_number, color, rolled_by, rolled_piece_type, legal_piece_types
  )
  values (
    p_game_id, p_move_number, v_color, v_uid, p_rolled_piece_type, p_legal_piece_types
  );

  update public.games
  set allowed_piece_type = p_rolled_piece_type, last_move_at = now()
  where id = p_game_id
  returning * into v_game;

  return v_game;
end;
$$;

-- Hamleyi, oyunun yeni durumunu ve (oyun sürüyorsa) sonraki turun zarını tek
-- transaction'da yazar. Satranç kuralları istemcideki chess.js'te doğrulanır;
-- burada sıra, üyelik, hamle numarası ve zara uygunluk zorunlu kılınır.
create or replace function public.record_move(
  p_game_id uuid,
  p_move_number integer,
  p_piece_type public.piece_type,
  p_from_square text,
  p_to_square text,
  p_promotion public.promotion_piece,
  p_san text,
  p_uci text,
  p_fen_after text,
  p_result_reason public.game_result_reason,
  p_next_piece_type public.piece_type,
  p_next_legal_piece_types public.piece_type[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_game public.games;
  v_move public.game_moves;
  v_color public.game_color;
  v_next_turn public.game_color;
begin
  if v_uid is null then
    raise exception 'Oturum bulunamadı.';
  end if;

  select * into v_game from public.games where id = p_game_id for update;
  if not found then
    raise exception 'Oyun bulunamadı.';
  end if;

  select color into v_color from public.game_players
  where game_id = p_game_id and user_id = v_uid;
  if not found then
    raise exception 'Bu oyunun oyuncusu değilsin.';
  end if;

  if v_game.status <> 'active' then
    raise exception 'Oyun aktif değil.';
  end if;
  if v_game.current_turn <> v_color then
    raise exception 'Sıra sende değil.';
  end if;
  if v_game.allowed_piece_type is null then
    raise exception 'Bu tur için zar sonucu bulunamadı.';
  end if;
  if p_piece_type <> v_game.allowed_piece_type then
    raise exception 'Bu hamle gelen taş türüne uygun değil.';
  end if;
  if p_move_number <> v_game.move_count + 1 then
    raise exception 'Oyun durumu değişti, sayfayı yenile.';
  end if;

  v_next_turn := case when v_color = 'w' then 'b' else 'w' end::public.game_color;

  if split_part(p_fen_after, ' ', 2) <> v_next_turn::text then
    raise exception 'Geçersiz tahta durumu.';
  end if;
  if p_result_reason is not null and p_result_reason not in ('checkmate', 'stalemate', 'draw') then
    raise exception 'Hamle bu sonuçla bitirilemez.';
  end if;
  if p_result_reason is not null and p_next_piece_type is not null then
    raise exception 'Biten oyun için zar atılamaz.';
  end if;

  insert into public.game_moves (
    game_id, user_id, move_number, color, piece_type, allowed_piece_type,
    from_square, to_square, promotion, san, uci, fen_before, fen_after
  )
  values (
    p_game_id, v_uid, p_move_number, v_color, p_piece_type, v_game.allowed_piece_type,
    p_from_square, p_to_square, p_promotion, p_san, p_uci, v_game.fen, p_fen_after
  )
  returning * into v_move;

  if p_next_piece_type is not null then
    insert into public.game_dice_rolls (
      game_id, move_number, color, rolled_by, rolled_piece_type, legal_piece_types
    )
    values (
      p_game_id, p_move_number + 1, v_next_turn, v_uid,
      p_next_piece_type, p_next_legal_piece_types
    );
  end if;

  update public.games
  set
    fen = p_fen_after,
    current_turn = v_next_turn,
    allowed_piece_type = p_next_piece_type,
    move_count = p_move_number,
    last_move_at = now(),
    status = case when p_result_reason is null then 'active' else 'finished' end::public.game_status,
    winner_user_id = case when p_result_reason = 'checkmate' then v_uid end,
    result_reason = p_result_reason,
    finished_at = case when p_result_reason is null then null else now() end
  where id = p_game_id
  returning * into v_game;

  return jsonb_build_object('game', to_jsonb(v_game), 'move', to_jsonb(v_move));
end;
$$;

-- Hamle dışı bitiş. Mat, pat ve beraberliği record_move kapatır; 'timeout' ve
-- 'abandon' enum'da var ama kodda onları tetikleyen bir akış yok, o yüzden
-- şimdilik yalnızca 'resign' kabul edilir.
create or replace function public.finish_game(
  p_game_id uuid,
  p_result_reason public.game_result_reason
)
returns public.games
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_game public.games;
  v_opponent uuid;
begin
  if v_uid is null then
    raise exception 'Oturum bulunamadı.';
  end if;
  if p_result_reason <> 'resign' then
    raise exception 'Oyun bu sonuçla bitirilemez.';
  end if;

  select * into v_game from public.games where id = p_game_id for update;
  if not found then
    raise exception 'Oyun bulunamadı.';
  end if;

  if not exists (
    select 1 from public.game_players where game_id = p_game_id and user_id = v_uid
  ) then
    raise exception 'Bu oyunun oyuncusu değilsin.';
  end if;

  if v_game.status <> 'active' then
    raise exception 'Sadece aktif oyunda pes edebilirsin.';
  end if;

  select user_id into v_opponent from public.game_players
  where game_id = p_game_id and user_id is distinct from v_uid;

  update public.games
  set
    status = 'finished',
    winner_user_id = v_opponent,
    result_reason = p_result_reason,
    finished_at = now(),
    allowed_piece_type = null
  where id = p_game_id
  returning * into v_game;

  return v_game;
end;
$$;

-- Giriş yapan oyuncunun istatistiği, RLS altında kendi oyunlarından hesaplanır.
create or replace function public.get_player_stats()
returns table (
  games_played integer,
  in_progress integer,
  wins integer,
  losses integer,
  draws integer
)
language sql
stable
set search_path = ''
as $$
  select
    count(*) filter (where g.status = 'finished')::integer,
    count(*) filter (where g.status = 'active')::integer,
    count(*) filter (where g.status = 'finished' and g.winner_user_id = p.user_id)::integer,
    count(*) filter (
      where g.status = 'finished'
        and g.winner_user_id is distinct from p.user_id
        and g.result_reason not in ('stalemate', 'draw')
    )::integer,
    count(*) filter (
      where g.status = 'finished' and g.result_reason in ('stalemate', 'draw')
    )::integer
  from public.game_players p
  join public.games g on g.id = p.game_id
  where p.user_id = auth.uid();
$$;

-- Supabase varsayılan olarak fonksiyonlara anon yetkisi verir; kaldırılıyor.
-- Anonim oturumlar (signInAnonymously) "authenticated" rolüyle çalışır.
revoke all on function public.is_game_player(uuid) from public, anon;
revoke all on function public.create_game(text) from public, anon;
revoke all on function public.join_game(uuid) from public, anon;
revoke all on function public.join_game_by_code(text) from public, anon;
revoke all on function public.save_dice_roll(uuid, integer, public.piece_type, public.piece_type[]) from public, anon;
revoke all on function public.record_move(
  uuid, integer, public.piece_type, text, text, public.promotion_piece, text, text, text,
  public.game_result_reason, public.piece_type, public.piece_type[]
) from public, anon;
revoke all on function public.finish_game(uuid, public.game_result_reason) from public, anon;
revoke all on function public.get_player_stats() from public, anon;
revoke all on function public.games_set_updated_at() from public, anon, authenticated;

grant execute on function public.is_game_player(uuid) to authenticated;
grant execute on function public.create_game(text) to authenticated;
grant execute on function public.join_game(uuid) to authenticated;
grant execute on function public.join_game_by_code(text) to authenticated;
grant execute on function public.save_dice_roll(uuid, integer, public.piece_type, public.piece_type[]) to authenticated;
grant execute on function public.record_move(
  uuid, integer, public.piece_type, text, text, public.promotion_piece, text, text, text,
  public.game_result_reason, public.piece_type, public.piece_type[]
) to authenticated;
grant execute on function public.finish_game(uuid, public.game_result_reason) to authenticated;
grant execute on function public.get_player_stats() to authenticated;

commit;
