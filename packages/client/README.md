# `@media-ref/client`

Pure TypeScript core package for [media-ref](https://mediaref.org) with zero runtime dependencies. Shared by client applications, the API Worker, and the web submission forms.

## Exports

- **Domain types & namespace helpers**: `Media`, `MediaSnapshot`, `SeasonSnapshot`, `MediaDocument`, `Variant`, `Association`, `Segment`, `SegmentInput`, `ExternalId`, `ExternalKey`, `PLATFORM_NAMESPACES`, `CATALOG_NAMESPACES`, `BASELINE_PRIORITY`, `getNamespaceGroup`, `parseExternalKey`, `formatExternalKey`.
- **Episode resolution**: `resolveEpisode(doc, query)` maps `(namespace, season, episode, variantId?)` to a platform collection or catalog entry and target episode number, handling whole-media, whole-season, split-season, merged-season, open-ended, `nonLinear`, and `needsReview` / baseline-mismatch segments.
- **Segment validation**: `normalizeSegment`, `normalizeSegments`, `validateSegment`, `validateVariantSegments`, and `validateSharedCollectionSegments`.
