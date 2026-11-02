-- Dayanıklılık: durum sürümü ve tekrarlanabilir yazmalar.

-- Her güncellemede artan sayaç. Güncelleme satır kilidi altında yapıldığı için
-- kesin sıralıdır; istemci eski bir mesajın yeni durumu ezmesini bununla önler.
alter table public.games
  add column if not exists version bigint not null default 1;

create or replace function public.games_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  new.version := old.version + 1;
  return new;
end;
$$;

-- Zar: aynı tur için tekrar gelen istek (yanıtı kaybolmuş olabilir) hata değildir.
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

  if exists (
    select 1 from public.game_dice_rolls
    where game_id = p_game_id and move_number = p_move_number
  ) then
    return v_game;
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

-- Hamle: aynı oyuncunun aynı hamleyi tekrar göndermesi ikinci kez yazmaz, güncel
-- durumu döner ('duplicate': true). Aynı numaraya farklı hamle reddedilir.
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

  select * into v_move from public.game_moves
  where game_id = p_game_id and move_number = p_move_number;
  if found then
    if v_move.user_id = v_uid
      and v_move.from_square = p_from_square
      and v_move.to_square = p_to_square
      and v_move.promotion is not distinct from p_promotion
    then
      return jsonb_build_object(
        'game', to_jsonb(v_game), 'move', to_jsonb(v_move), 'duplicate', true
      );
    end if;
    raise exception 'Oyun durumu değişti, sayfayı yenile.';
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

  return jsonb_build_object(
    'game', to_jsonb(v_game), 'move', to_jsonb(v_move), 'duplicate', false
  );
end;
$$;

-- Pes etme: yanıtı kaybolan isteğin tekrarı hata vermez.
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

  if v_game.status = 'finished' and v_game.result_reason = 'resign' then
    return v_game;
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
