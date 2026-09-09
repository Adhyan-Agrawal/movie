-- Popularity ranking (Spec Section 4: trending / hero curation).
--
-- editorial_score (TMDB vote_average ×10) reflects QUALITY but not fame: an
-- obscure 8.5-rated import can outrank Breaking Bad. TMDB `popularity` is the
-- signal that surfaces recognizable mainstream hits, so we store it per title
-- and rank "trending" / the hero carousel by it (nulls last), with score as the
-- tiebreaker. Backfilled from TMDB popular/top_rated lists (scripts/backfill-popularity.mjs)
-- and refreshed on every sync.

alter table titles add column if not exists popularity double precision;

create index if not exists titles_popularity_idx on titles (popularity desc nulls last);
