# Capture research safety

Keep original HAR files, cookie jars, authenticated HTML, storage-state files, and screenshots containing student or operator information out of this repository. The `research/private/` directory and `*.har` files are ignored, but ignore rules are only a last line of defense.

Before adding a fixture under `research/sanitized/` or `src/fixtures/peopleSoft/`:

1. Replace names, operator/student identifiers, email addresses, and unrelated course data with synthetic values.
2. Remove complete request headers and all `Cookie`, `Set-Cookie`, and `Authorization` values.
3. Remove tokens and identifiers including `PS_TOKEN`, `JSESSIONID`, `ICSID`, `cf_clearance`, and Datawiza/session values.
4. Retain only the minimum DOM/XML shape needed to exercise a parser.
5. Search the result for the original sensitive values before staging it.

Never use a captured row suffix, Activity Guide ID, window/node identifier, or `ICSID` as a constant. Sanitized fixtures should deliberately vary transient identifiers so tests prove they are dynamically discovered.
