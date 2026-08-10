# Hara runtime extensions

Concrete Hara providers live here rather than in the language runtime. The
workspace expects `hara-lang/hara` at `technology/hara` and this repository at
`extensions`; set `HARA_WORKSPACE_ROOT` when using another checkout root.

The Hara repository owns provider-neutral ABI, HTA, loader, and host interfaces.
This directory owns the database, cryptographic, audio, and Ledger/Noir provider
implementations built against those interfaces.
