# Repository guidance

- This is a public repository. Keep raw playback captures, reporter diagnostics, local investigation reports, account/device information, signed URLs, and credentials under the Git-ignored `.local/` directory. Never include them in commits or release packages.
- Public test fixtures derived from captures must use synthetic asset paths, identifiers, and DRM payloads, including identifiers or service/account references encoded inside PSSH and PlayReady data. Preserve the stream structure and relationships needed by the tests and label the fixtures as anonymized capture-derived data.
- Before publishing changes that include fixtures or diagnostics, verify Git's candidate files and release package contents for private data. Removing a file from the working tree does not remove it from earlier Git history.
