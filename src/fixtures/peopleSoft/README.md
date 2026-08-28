# Sanitized PeopleSoft fixtures

These files contain no request headers, cookies, query values from a live session, operator/student identifiers, or raw HAR metadata.

- `course-requirements-multiple.html` is a minimal structure-only reconstruction from an authorized local capture. The capture demonstrated an XML/CDATA course grid with many same-row dynamic actions, including course codes with `L` suffixes. All hidden values, row numbers, window names, and actions here are synthetic.
- `activity-guide-observed.html` reconstructs the observed split shape: the service reference is in `href`, while transient item parameters are in `onclick`. Every identifier and parameter value is synthetic.
- Class-selection and preprocessing fixtures remain synthetic examples based on the fields in the supplied brief because the inspected capture did not include those response bodies.

Never replace these files by copying a complete HAR entry. Retain only the smallest parser-relevant DOM shape and re-sanitize every value.
