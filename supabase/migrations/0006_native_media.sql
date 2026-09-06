-- Native media (Spec Sections 7, 9, 11): a PRIVATE storage bucket for
-- operator-owned video uploads. The bucket is never public — the world cannot
-- reach objects directly; playback resolves server-side and hands the player a
-- time-limited signed URL. All writes go through the service role (admin
-- upload actions); no public storage policies are created on purpose.

insert into storage.buckets (id, name, public)
values ('media', 'media', false)
on conflict (id) do nothing;

-- Object paths are namespaced per title so listing/deleting per title is a
-- prefix operation: media/{titleId}/{episodeId|'title'}/{filename}
