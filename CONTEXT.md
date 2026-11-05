# Lumora Context

Last handoff update: 2026-11-05, resumed at approximately 18:27 UTC.
This is a durable handoff, not a claim that every feature is complete.

## Current User Direction

- Continue unfinished work with independent subagents where useful.
- Keep this Markdown context up to date so interrupted/forked sessions can recover accurately.
- Priorities are reliable playback with one initial source-catalogue lookup, visible website animations, and a working published site.
- The user explicitly requested publication after disclosure of the intermittent mobile hydration issue. The site was published; do not apply the superseded pre-deployment hold or upload the same build again unnecessarily.

## Locations And Git

- Web repository: `D:\movie platform`.
- Canonical Android project: `D:\lumora-mobile`.
- Android mirror: `D:\movie platform\mobile`.
- The chat/fork default working directory is the VS Code installation, not the repository. Use explicit paths/workdirs.
- Verified on this resume: branch `master`, HEAD `baf40d6` (`fix Cloudflare CDN fetch binding`). No new commit has been made by this work.
- Approximately 308 release files are already staged. Preserve that index and unrelated changes.
- `scripts/browser-workerd-acceptance-test.mjs` has additional unstaged diagnostic/CLI changes.
- Exclude `scripts/fixtures/player-hydration/report.development.json` and `report.production.json`; they are generated, untracked reports.
- Remote name is `main`, not `origin`; the branch previously had no upstream. The authorized eventual push command is `git push --set-upstream main master:master` after a reviewed commit.
- Do not stage real environment files, signing keys, dependencies, build trees, APK/AAB files, or temporary diagnostic reports.

## Published Website

- URL: https://lumora.adhyanagrawal777.workers.dev
- Confirmed deployed Worker version: `e869deb9-f975-4ae5-a4fb-e813e59dd6dc`.
- Deployment command: `node scripts/deploy-cloudflare.mjs --skip-build --preserve-runtime`.
- Cloudflare confirmed upload and trigger deployment. Upload took about 310 seconds; an earlier monitor time cap did not mean deployment failed.
- Existing runtime secrets/settings were preserved. No account, database, Watch Party, migration, or resource-deletion operation was performed.
- Published artifact SHA-256: `01138a84b6dd67429bd6fd8b95ffe84a158104978f4f06d910c2262b6cb3ed1a`.
- Artifact inventory: 1,601 files, 43,899,621 bytes, excluding source maps in the harness fingerprint.
- Server SHA-256: `0ee4acfa6b6683dc5b339bc5528c126359e1ce8a6eae4ce106b0a9603539d1c5`.
- Build timestamp: `2026-11-05T10:44:23.484Z`.
- These are the last confirmed remote facts, not an assertion that nobody else has deployed since. Verify current version before another publication.

## Implemented And Checked

- Web Direct playback obtains the catalogue first and reuses encrypted, same-origin stream capabilities for audio/quality selection.
- Mounted tests exercise 25 actual stream switches with one catalogue lookup, expiry renewal, subtitle-request coalescing, compatible pinned selections, position/rate/pause preservation, and title/episode isolation.
- The initial catalogue deadline is 35 seconds, covering the server's resolution and enrichment budgets. Capability reuse is bounded by issued expiry, at most four hours.
- Website motion includes hero/page entrances, navigation effects, staggered section/card reveals, image/button interactions, and reduced-motion behavior. Content stays accessible without JavaScript.
- Last full source gate: `npm test -- --maxWorkers=2`, 90 files and 1,917 tests passed. Typecheck and lint passed.
- The earlier unconstrained run had two local workerd startup timeouts; the complete bounded-concurrency pass superseded that run without weakening functional assertions.
- Mounted player suite: 140/140. Focused motion suites: 53/53. Deployment/environment guard suite: 30/30.
- Controlled frozen-artifact browser run: 47/47 checks passed. Trailer run: 21/21 passed. Actual licensed video frames and time advancement were measured.
- Those fixture passes do not certify production providers, and a later mobile hydration failure remains valid evidence.
- Seven production checks passed after deployment: homepage, movie/TV detail, signin/signup unavailable state without password forms, public catalogue, and published motion/reduced-motion CSS.

## Open Priority: Production Direct Sources

- Production stream switching is not fully verified.
- One live smoke call returned a nonempty opaque catalogue with fewer than two startup-verified sources. Another returned an empty catalogue.
- A later header-scoped runtime probe returned HTTP 200 with 10 streams, one startup-verified candidate.
- In that probe, candidate 1 passed root HLS, child HLS, and an MP4-prefix check, all HTTP 200. This is not proof of sustained browser decoding.
- Candidate 2 returned HTTP 502. The first requests reported a FRA ray and the failing request a SIN ray; this is correlation only, not proof of an IP/region cause.
- The probe ended without a final aggregate trace result. Its background-process record is unavailable after resume; retain its coverage as partial, not a complete success.
- The production trace filters a unique header on owned requests and prints only sanitized classifications/counts. Never capture or log other visitors' requests, credentials, or capability URLs.

### Source Audit Findings

- `src/features/vidnest/resolver.ts` truncates ordered provider candidates to 32 before `src/app/api/vidnest/route.ts` removes unsupported, expired, and duplicate inputs. This is a concrete candidate-loss bug, but has not been established as the observed live cause.
- Non-OK upstream responses, timeouts, invalid/oversized JSON, missing/decryption keys, and decrypt failures can collapse to an empty result. HTTP 200 with `streams: []` can hide these distinctions.
- Failed startup probes still create opaque catalogue rows. Missing `startupLatencyMs` alone does not mean a URL is unplayable.
- Movie resolution uses six Vidnest providers. Key discovery may fetch two pages and up to 16 chunks per page. Refresh behavior can repeat discovery; there is no proven hard 40-fetch invocation cap.
- Inspect request-scoped key-refresh reuse and filter-before-cap behavior. Do not add cross-request pending-I/O promises in Workers or simply remove/raise rate limits.
- Useful safe diagnostics: provider, failure stage, HTTP status/error class, discovery-round count, pre-cap/post-normalization counts, and healthy count. No keys, headers, bodies, or upstream URLs are needed.

## Open Known Issue: Mobile Hydration

- A later independent run logged React error `#418` on mobile TV detail after a movie page, against the same published artifact.
- Retained failure: `C:\Users\ADHYAN~1\AppData\Local\Temp\kilo\lumora-workerd-acceptance-L4SrLn\report.json`.
- Isolated browser traces, 16 source-development cases, 18 controlled replays, an exact desktop/motion/mobile sequence, and six byte-preserving network/cache cases did not reproduce or explain it. Negative traces do not clear the failure.
- Static mapping of retained frames `rD -> oq -> iw`: hydration claim failure in `beginWork` during `replaySuspendedUnitOfWork`. Ambiguous among HostComponent, HostText, and Activity claims; not uniquely a leftover-node/pop-tail error.
- A proven source fix is not available. Do not use blanket client-only rendering, `suppressHydrationWarning`, or retries-until-green to hide it.
- This is a disclosed post-publication issue, secondary to current live provider reliability.

## Android APK

- Delivered file: `D:\lumora-mobile\Lumora.apk`.
- SHA-256 rechecked after deployment: `91CA77736BA6E549A5223E6AE76F004D48226658B13C6B1E93965B78258254E5`.
- Size: 88,506,687 bytes.
- Package `org.lumora.app`, version `1.0.0`, code `1`; min SDK 24, target/compile 36.
- Internal debug-key-signed build, not a production Store release. `debuggable=false`, `testOnly=false`, PiP enabled, all four ABIs present.
- Signature, matching Hermes bundle, ZIP/eligible 64-bit ELF alignment, and delivered-copy checksum checks passed.
- AdMob still uses official test IDs.
- No physical-device/emulator verification is available. Seven broader Android fixture failures were reported; do not claim full Android regression acceptance.
- Recent web-only request-reuse/motion implementation is not claimed as new APK parity.
- Canonical and mirror runtime/gate files were checked during the build. Preserve existing environment differences; never blindly overwrite the mirror.

## Services Not Live

- Authentication/account synchronization and Watch Party remain unavailable with explicit safe UI messages.
- D1/Better Auth, API Worker, Watch Party Worker, and migration sources exist but are not production activation or migration approval.
- Do not provision, migrate, delete resources, alter production secrets, bypass email verification, or enable disabled services as part of this release repair.
- Production payment/subscription and real-ad readiness have not been established.

## Verification And Deployment Commands

Run from the explicit web repository, and only when changed inputs warrant them:

```powershell
npm test -- --maxWorkers=2
npm run typecheck -- --incremental false
npm run lint -- --no-cache
node scripts/browser-workerd-acceptance-test.mjs --fingerprint-only --expect-artifact <verified-sha256>
node scripts/deploy-cloudflare.mjs --dry-run --skip-build --preserve-runtime
node scripts/deploy-cloudflare.mjs --skip-build --preserve-runtime
```

- Fingerprint-only mode now exists and explicitly does NOT run acceptance. It did not exist earlier; the old unsupported flag accidentally started a full suite. Unknown CLI options now fail before runtime startup.
- Use the existing sanitized build workflow for a necessary new build. Public Supabase URL/key must remain explicitly empty; generated environment modules must contain only the four allowed public fields.
- Recheck exact artifact identity before deployment. One task owns a root build at a time.
- Use project-local Wrangler (project has `wrangler.jsonc`) and its installed help; do not silently upgrade it.

## Temporary Diagnostics

These files may disappear and are not production artifacts:

- `C:\Users\ADHYAN~1\AppData\Local\Temp\kilo\lumora-release-smoke-20261105.mjs`: read-only live checks, optional `--media-only`, one catalogue request per invocation and bounded capability probes.
- `C:\Users\ADHYAN~1\AppData\Local\Temp\kilo\lumora-provider-runtime-probe.mjs`: header-scoped Wrangler trace plus bounded live media probe; inspect completed output rather than restarting blindly.
- `C:\Users\ADHYAN~1\AppData\Local\Temp\kilo\lumora-stream-hydration-probe.mjs`: controlled HTML/Flight replay, including `--wire-chunks --warm-prefix`; the wire run observed real cache hits and no mismatch.
- `C:\Users\ADHYAN~1\AppData\Local\Temp\kilo\lumora-live-hydration-claims.mjs`: prepared live, non-pausing replay/claim instrumentation; not yet executed at the last handoff.

## Current Coordination

- Main owns this context file, integration, deployment, and Git mutations.
- Previous provider audit worker: `ses_e5415f520ffe2VqVzT3mK2s8xr`.
- Previous browser/build worker: `ses_e54e13786ffeqJITgWDJJpdddj`.
- Previous APK verifier: `ses_e55cabe1bffeqQ214v1n0iCjc3`.
- Historical task IDs are not proof of active work. Read current task/board state before resuming; model-rate failures occurred repeatedly.
- Resume only unfinished, non-overlapping assignments. Keep completed passes as evidence, not a reason to rerun them while waiting.

## Next Actions

1. Resume bounded provider correctness and live-verification work; separate concrete code defects from unproven outage/limit hypotheses.
2. Investigate Android fixture gaps independently without delaying website reliability work or silently changing APK runtime sources.
3. Run the prepared narrow hydration collector only if it can add new evidence; do not repeat completed negative tests.
4. Integrate proven fixes, validate changed inputs, and rebuild/deploy only if runtime source changes require it.
5. Review/restage intended source, harness, and context changes; exclude generated reports; commit and push the authorized scope.
6. Update this file after each material result. Clearly distinguish built, tested, deployed, unverified, and unavailable.
