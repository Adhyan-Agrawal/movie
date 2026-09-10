# Lumora — native app (Expo / React Native)

The mobile client for Lumora. It shares the **same Supabase backend** and the
**same playback providers** as the web app — the two clients stay in one
product rather than drifting apart.

## How it fits together

```
mobile app ──(anon key, RLS)──▶ Supabase (catalog, watchlist, progress, ratings, requests)
           ──(GET /api/playback)──▶ web app ──▶ provider registry ──▶ Server 1..N
```

- **Catalog + library**: read and written directly against Supabase with the
  public anon key. Every row is governed by the same Row Level Security policies
  the web app uses, so the app can only ever touch public catalog rows and the
  signed-in viewer's own library.
- **Playback**: provider URL construction, the host allowlist and the
  "Server 1..N" anonymization all live server-side in the web app. The native
  client calls **`GET {EXPO_PUBLIC_WEB_URL}/api/playback`** and receives the same
  sanitized source list the web player gets — so the provider logic exists in
  exactly one place, and the app never learns real provider identities.
- **Sessions**: native has no cookies, so the Supabase session is persisted in
  AsyncStorage instead. Signed-in viewers get server-side watch progress;
  guests get a device-local store (`src/lib/guest.ts`) mirroring the web's.

## Setup

```bash
cd mobile
npm install
cp .env.example .env   # then fill in the three EXPO_PUBLIC_* values
```

`.env` (only public values — **never** the service-role key):

| Variable | Meaning |
| --- | --- |
| `EXPO_PUBLIC_SUPABASE_URL` | Supabase project URL (same as the web app). |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Supabase **anon** key. |
| `EXPO_PUBLIC_WEB_URL` | Public web app origin, e.g. `https://hulkofyt.eu.org`. The player asks this domain for its servers. |

> The web app **must be deployed** at `EXPO_PUBLIC_WEB_URL` for playback to work.
> Without it, browsing works but the player reports no available source.

## Run it

```bash
npx expo start
```

Then scan the QR code with **Expo Go** on your phone (Android or iOS). The app
reloads on save.

## Build a store-ready app

Expo Go is fine for development; a real installable build needs EAS:

```bash
npm i -g eas-cli
eas login
eas build:configure
eas build --platform android   # .aab / .apk
eas build --platform ios       # needs an Apple Developer account
```

`app.json` already carries the Lumora name, dark theme, icons
(`assets/icon.png`, `assets/adaptive-icon.png`) and the `org.lumora.app`
bundle/package identifiers — change those before publishing.

## Layout

```
App.tsx                 navigation: bottom tabs (Home/Search/My List/Account)
                        + stack (Title, Player, Person, Auth)
src/navigation.ts       typed route params — the single source of truth
src/theme.ts            design tokens (mirrors the web palette)
src/lib/supabase.ts     Supabase client (AsyncStorage session)
src/lib/api.ts          catalog, playback bridge, auth, library, requests
src/lib/guest.ts        device-local continue-watching for signed-out viewers
src/components/         ui primitives, MediaCard, Row, Hero carousel
src/screens/            one file per screen
```

## Notes

- Typecheck with `npx tsc --noEmit`.
- The native app is a **companion** to the PWA, not a replacement: the PWA
  installs from the browser with zero friction; this app is for store presence
  and native playback.
- Provider embeds render in a `WebView` (unchanged iframe URLs); Lumora-hosted
  uploads play natively through `expo-video`, including real progress telemetry.
